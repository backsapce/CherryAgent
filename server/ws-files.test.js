import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WS_OPCODE, encodeMaskedWsFrame, parseWsFrames } from './ws-frames.js';
import { createAgentWsServer } from './ws-protocol.js';
import { createFileHandlers, createFileOperations } from './ws-files.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.written = [];
    this.destroyed = false;
    this.writableLength = 0;
  }
  setNoDelay() {}
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
  clientSend(opcode, payload) {
    this.emit('data', encodeMaskedWsFrame(opcode, payload));
  }
  clientJson(value) {
    this.clientSend(WS_OPCODE.TEXT, Buffer.from(JSON.stringify(value)));
  }
  clientBinary(streamId, chunk, final) {
    const payload = Buffer.alloc(5 + chunk.length);
    payload.writeUInt32BE(streamId, 0);
    payload[4] = final ? 1 : 0;
    chunk.copy(payload, 5);
    this.clientSend(WS_OPCODE.BINARY, payload);
  }
  serverMessages() {
    return parseWsFrames(Buffer.concat(this.written)).frames
      .filter((frame) => frame.opcode === WS_OPCODE.TEXT)
      .map((frame) => JSON.parse(frame.payload.toString('utf8')));
  }
  replyOf(id) {
    const matches = this.serverMessages().filter((message) => message.id === id);
    return matches[matches.length - 1];
  }
  binaryFrames(streamId) {
    return parseWsFrames(Buffer.concat(this.written)).frames
      .filter((frame) => frame.opcode === WS_OPCODE.BINARY && frame.payload.readUInt32BE(0) === streamId);
  }
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cherry-ws-files-'));
  const operations = createFileOperations({
    filesRootDir: root,
    isSafePath: (path) => !String(path || '').includes('..'),
    isSafeMutationPath: (path) => !String(path || '').includes('..'),
    isProtectedControlPath: (path) => String(path).includes('.cherry'),
    isSameOrChildPath: (target, ancestor) => target === ancestor || target.startsWith(`${ancestor}/`),
    maxUploadBytes: 1024 * 1024,
  });
  const server = createAgentWsServer({
    authDisabled: true,
    handlers: createFileHandlers(operations),
    heartbeatIntervalMs: 2_147_483_000,
    unauthIdleMs: 2_147_483_000,
  });
  const socket = new FakeSocket();
  server.handleUpgrade(socket, '127.0.0.1');
  socket.clientJson({ id: 'h', type: 'hello', payload: {} });
  return { root, operations, socket };
}

function flush(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('file.list wraps the root listing and honors recursive/hidden flags', async () => {
  const { root, socket } = createFixture();
  writeFileSync(join(root, 'a.txt'), 'A');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'b.txt'), 'B');
  writeFileSync(join(root, '.hidden'), 'x');

  socket.clientJson({ id: 'q1', type: 'file.list', payload: { path: '' } });
  await flush();
  const rootListing = socket.replyOf('q1').data;
  assert.equal(rootListing.id, 'root');
  const names = rootListing.children.map((entry) => entry.name);
  assert.ok(names.includes('a.txt'));
  assert.ok(!names.includes('.hidden'));

  socket.clientJson({ id: 'q2', type: 'file.list', payload: { path: 'sub' } });
  await flush();
  assert.ok(Array.isArray(socket.replyOf('q2').data));
  assert.equal(socket.replyOf('q2').data[0].name, 'b.txt');

  socket.clientJson({ id: 'q3', type: 'file.list', payload: { path: '', recursive: true, includeHidden: true } });
  await flush();
  const recursiveNames = socket.replyOf('q3').data.children.map((entry) => entry.path || entry.name);
  assert.ok(recursiveNames.length >= 3);

  socket.clientJson({ id: 'q4', type: 'file.list', payload: { path: 'missing' } });
  await flush();
  assert.equal(socket.replyOf('q4').code, 404);
});

test('file.create, file.move, and file.delete round-trip', async () => {
  const { root, socket } = createFixture();
  socket.clientJson({ id: 'q1', type: 'file.create', payload: { path: 'notes', isDirectory: true } });
  await flush();
  socket.clientJson({ id: 'q2', type: 'file.create', payload: { path: 'notes/todo.txt', content: 'hi' } });
  await flush();
  assert.equal(existsSync(join(root, 'notes/todo.txt')), true);

  socket.clientJson({ id: 'q3', type: 'file.move', payload: { sourcePath: 'notes/todo.txt', targetPath: 'notes/done.txt' } });
  await flush();
  assert.equal(readFileSync(join(root, 'notes/done.txt'), 'utf8'), 'hi');

  socket.clientJson({ id: 'q4', type: 'file.delete', payload: { path: 'notes/done.txt' } });
  await flush();
  assert.equal(existsSync(join(root, 'notes/done.txt')), false);

  socket.clientJson({ id: 'q5', type: 'file.move', payload: { sourcePath: 'a/../escape', targetPath: 'b' } });
  await flush();
  assert.equal(socket.replyOf('q5').code, 403);
});

test('file.download streams binary frames and reassembles byte-exact', async () => {
  const { root, socket } = createFixture();
  const payload = Buffer.from('0123456789'.repeat(100));
  writeFileSync(join(root, 'blob.bin'), payload);

  socket.clientJson({ id: 'q1', type: 'file.download', payload: { path: 'blob.bin', streamId: 5 } });
  await flush(30);
  const reply = socket.replyOf('q1');
  assert.equal(reply.ok, true);
  assert.equal(reply.data.size, payload.length);
  const frames = socket.binaryFrames(5);
  const last = frames[frames.length - 1];
  assert.equal(last.payload[4] & 0x01, 0x01);
  const reassembled = Buffer.concat(frames.map((frame) => frame.payload.subarray(5)));
  assert.equal(reassembled.equals(payload), true);

  socket.clientJson({ id: 'q2', type: 'file.download', payload: { path: 'missing.bin', streamId: 6 } });
  await flush();
  assert.equal(socket.replyOf('q2').code, 404);
});

test('file.upload streams chunks and finalizes with an atomic rename receipt', async () => {
  const { root, socket } = createFixture();
  const body = Buffer.from('upload-body-'.repeat(20));
  socket.clientJson({ id: 'q1', type: 'file.upload.begin', payload: { streamId: 9, path: 'inbox/data.bin', size: body.length } });
  await flush();
  assert.equal(socket.replyOf('q1').ok, true);

  // Ending before the final chunk is rejected.
  socket.clientJson({ id: 'q2', type: 'file.upload.end', payload: { streamId: 9 } });
  await flush();
  assert.equal(socket.replyOf('q2').code, 400);

  const half = Math.floor(body.length / 2);
  socket.clientBinary(9, body.subarray(0, half), false);
  socket.clientBinary(9, body.subarray(half), true);
  socket.clientJson({ id: 'q3', type: 'file.upload.end', payload: { streamId: 9 } });
  await flush(20);
  assert.equal(socket.replyOf('q3').ok, true);
  assert.equal(readFileSync(join(root, 'inbox/data.bin')).equals(body), true);
});

test('file.upload rejects size mismatches and oversize declarations', async () => {
  const { root, socket } = createFixture();
  socket.clientJson({ id: 'q1', type: 'file.upload.begin', payload: { streamId: 3, path: 'big.bin', size: 10 * 1024 * 1024 } });
  await flush();
  assert.equal(socket.replyOf('q1').code, 413);

  socket.clientJson({ id: 'q2', type: 'file.upload.begin', payload: { streamId: 4, path: 'short.bin', size: 4 } });
  await flush();
  socket.clientBinary(4, Buffer.from('toolong'), true);
  socket.clientJson({ id: 'q3', type: 'file.upload.end', payload: { streamId: 4 } });
  await flush(20);
  assert.equal(socket.replyOf('q3').code, 404);
  assert.equal(existsSync(join(root, 'short.bin')), false);
});
