import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WS_BINARY_FLAG_FINAL, WS_OPCODE, encodeMaskedWsFrame, parseWsFrames } from './ws-frames.js';
import { createAgentWsServer } from './ws-protocol.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.written = [];
    this.destroyed = false;
    this.writableLength = 0;
    this.noDelay = false;
  }
  setNoDelay(value) {
    this.noDelay = value;
  }
  write(chunk) {
    if (this.destroyed) return false;
    this.written.push(Buffer.from(chunk));
    return true;
  }
  end(chunk) {
    if (this.destroyed) return;
    if (chunk) this.written.push(Buffer.from(chunk));
    this.destroyed = true;
    this.emit('close');
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }

  // Test drivers -----------------------------------------------------------
  clientSend(opcode, payload) {
    this.emit('data', encodeMaskedWsFrame(opcode, payload));
  }
  clientJson(value) {
    this.clientSend(WS_OPCODE.TEXT, Buffer.from(JSON.stringify(value)));
  }
  serverFrames() {
    return parseWsFrames(Buffer.concat(this.written)).frames;
  }
  serverJson() {
    return this.serverFrames()
      .filter((frame) => frame.opcode === WS_OPCODE.TEXT)
      .map((frame) => JSON.parse(frame.payload.toString('utf8')));
  }
}

function createFixture(overrides = {}) {
  const longLived = 'long-token-1';
  const state = {
    tempToken: 'temp-token',
    issued: [],
    closed: [],
    pushes: [],
  };
  const server = createAgentWsServer({
    isValidToken: (token) => token === longLived,
    exchangeTempToken: (tempToken) => {
      if (tempToken !== state.tempToken) return null;
      state.issued.push(tempToken);
      return longLived;
    },
    capabilities: () => ({ wsProtocol: 1 }),
    handlers: {
      echo: async (payload) => ({ echoed: payload.value }),
      boom: async () => {
        const error = new Error('nope');
        error.code = 409;
        throw error;
      },
      'upload.begin': (payload, conn) => {
        conn.registerUpload(payload.streamId, {
          onData(chunk, { final }) {
            state.pushes.push({ chunk: chunk.toString('utf8'), final });
          },
          onError() {},
        });
        return { accepted: true };
      },
      pusher: (payload, conn) => {
        conn.send('push.kind', payload.sub, { hello: 'world' });
        return { pushed: true };
      },
    },
    onConnectionClosed: (conn) => state.closed.push(conn),
    legacyFirstMessage: (socket, message) => {
      state.legacy = message;
      socket.destroy();
    },
    heartbeatIntervalMs: 2_147_483_000,
    unauthIdleMs: 2_147_483_000,
    ...overrides,
  });
  return { server, state, longLived };
}

function upgrade(server) {
  const socket = new FakeSocket();
  server.handleUpgrade(socket, '127.0.0.1');
  return socket;
}

function lastReply(socket) {
  const replies = socket.serverJson().filter((message) => message.id !== undefined);
  return replies[replies.length - 1];
}

function replyById(socket, id) {
  // Replies are correlated by id, not order: an async handler's reply can
  // land after a later synchronous error reply from the same batch.
  return socket.serverJson().find((message) => message.id === id);
}

test('hello with a valid token authenticates and reports capabilities', async () => {
  const { server, longLived } = createFixture();
  const socket = upgrade(server);
  socket.clientJson({ id: 'q1', type: 'hello', payload: { token: longLived } });
  await new Promise((resolve) => setImmediate(resolve));
  const reply = lastReply(socket);
  assert.equal(reply.id, 'q1');
  assert.equal(reply.ok, true);
  assert.equal(reply.data.authenticated, true);
  assert.equal(reply.data.needsAuth, false);
  assert.equal(reply.data.capabilities.wsProtocol, 1);
});

test('hello without a token leaves the connection unauthenticated', async () => {
  const { server } = createFixture();
  const socket = upgrade(server);
  socket.clientJson({ id: 'q1', type: 'hello', payload: {} });
  await new Promise((resolve) => setImmediate(resolve));
  const reply = lastReply(socket);
  assert.equal(reply.data.needsAuth, true);
  assert.equal(reply.data.authenticated, false);
});

test('unauthenticated connections may only hello and connect', async () => {
  const { server } = createFixture();
  const socket = upgrade(server);
  socket.clientJson({ id: 'q1', type: 'hello', payload: {} });
  socket.clientJson({ id: 'q2', type: 'echo', payload: { value: 1 } });
  await new Promise((resolve) => setImmediate(resolve));
  const reply = replyById(socket, 'q2');
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 401);
});

test('connect exchanges a temp token and unlocks the connection', async () => {
  const { server, state } = createFixture();
  const socket = upgrade(server);
  socket.clientJson({ id: 'q1', type: 'hello', payload: {} });
  socket.clientJson({ id: 'q2', type: 'connect', payload: { token: 'temp-token' } });
  socket.clientJson({ id: 'q3', type: 'echo', payload: { value: 7 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replyById(socket, 'q2').ok, true);
  assert.equal(replyById(socket, 'q2').data.token, 'long-token-1');
  assert.equal(replyById(socket, 'q3').ok, true);
  assert.equal(replyById(socket, 'q3').data.echoed, 7);
  assert.deepEqual(state.issued, ['temp-token']);
});

test('connect rejects an invalid temp token', async () => {
  const { server } = createFixture();
  const socket = upgrade(server);
  socket.clientJson({ id: 'q1', type: 'hello', payload: {} });
  socket.clientJson({ id: 'q2', type: 'connect', payload: { token: 'wrong' } });
  await new Promise((resolve) => setImmediate(resolve));
  const reply = replyById(socket, 'q2');
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 403);
});

test('unknown message types and handler errors map to error replies', async () => {
  const { server, longLived } = createFixture();
  const socket = upgrade(server);
  socket.clientJson({ id: 'q1', type: 'hello', payload: { token: longLived } });
  socket.clientJson({ id: 'q2', type: 'does.not.exist', payload: {} });
  socket.clientJson({ id: 'q3', type: 'boom', payload: {} });
  socket.clientJson({ id: 'q4', type: 'echo', payload: 'not-an-object' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replyById(socket, 'q2').ok, false);
  assert.equal(replyById(socket, 'q2').code, 400);
  assert.equal(replyById(socket, 'q3').ok, false);
  assert.equal(replyById(socket, 'q3').code, 409);
  assert.equal(replyById(socket, 'q4').ok, false);
  assert.equal(replyById(socket, 'q4').code, 400);
});

test('handlers can push messages addressed to a subscription id', async () => {
  const { server, longLived } = createFixture();
  const socket = upgrade(server);
  socket.clientJson({ id: 'q1', type: 'hello', payload: { token: longLived } });
  socket.clientJson({ id: 'q2', type: 'pusher', payload: { sub: 'sub-1' } });
  await new Promise((resolve) => setImmediate(resolve));
  const push = socket.serverJson().find((message) => message.sub === 'sub-1');
  assert.equal(push.type, 'push.kind');
  assert.deepEqual(push.data, { hello: 'world' });
});

test('binary frames route to registered upload sinks until final', async () => {
  const { server, longLived, state } = createFixture();
  const socket = upgrade(server);
  socket.clientJson({ id: 'q1', type: 'hello', payload: { token: longLived } });
  socket.clientJson({ id: 'q2', type: 'upload.begin', payload: { streamId: 9 } });

  const chunk = (streamId, text, final) => {
    const payload = Buffer.alloc(5 + text.length);
    payload.writeUInt32BE(streamId, 0);
    payload[4] = final ? WS_BINARY_FLAG_FINAL : 0;
    payload.write(text, 5, 'utf8');
    socket.clientSend(WS_OPCODE.BINARY, payload);
  };
  chunk(9, 'hello ', false);
  chunk(9, 'world', true);
  chunk(9, 'ignored-after-final', true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.pushes, [
    { chunk: 'hello ', final: false },
    { chunk: 'world', final: true },
  ]);
});

test('a legacy {cmd, token} first message is delegated whole', async () => {
  const { server, state } = createFixture();
  const socket = upgrade(server);
  socket.clientJson({ cmd: 'ls', token: 'whatever' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.legacy, { cmd: 'ls', token: 'whatever' });
  assert.equal(state.closed.length, 0);
});

test('socket close notifies onConnectionClosed once', async () => {
  const { server, state } = createFixture();
  const socket = upgrade(server);
  socket.clientJson({ id: 'q1', type: 'hello', payload: {} });
  socket.destroy();
  assert.equal(state.closed.length, 1);
  socket.destroy();
  assert.equal(state.closed.length, 1);
});

test('malformed JSON closes the connection with a protocol error', async () => {
  const { server } = createFixture();
  const socket = upgrade(server);
  socket.clientSend(WS_OPCODE.TEXT, Buffer.from('not-json'));
  assert.equal(socket.destroyed, true);
});

test('oversized buffers are refused', async () => {
  const { server } = createFixture({ maxFrameBytes: 1024, maxBufferBytes: 2048 });
  const socket = upgrade(server);
  socket.emit('data', Buffer.alloc(4096));
  assert.equal(socket.destroyed, true);
});
