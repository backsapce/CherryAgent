import test from 'node:test';
import assert from 'node:assert/strict';

// Browser-global mocks, mirroring agent.test.js: agentConnection resolves
// WebSocket URLs against window.location and talks to WebSocket instances.
const originalWindow = globalThis.window;

class MockWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    super();
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    this.binaryType = 'blob';
    MockWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    queueMicrotask(() => this.emitClose());
  }

  // Test drivers -----------------------------------------------------------
  static instances = [];
  static reset() {
    MockWebSocket.instances = [];
  }

  serverOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  serverMessage(value) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }

  serverBinary(streamId, text, final) {
    const bytes = new TextEncoder().encode(text);
    const frame = new Uint8Array(5 + bytes.byteLength);
    const view = new DataView(frame.buffer);
    view.setUint32(0, streamId);
    frame[4] = final ? 0x01 : 0x00;
    frame.set(bytes, 5);
    this.dispatchEvent(new MessageEvent('message', { data: frame.buffer }));
  }

  emitClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }

  sentJson() {
    return this.sent.filter((entry) => typeof entry === 'string').map((entry) => JSON.parse(entry));
  }

  sentRequest(type) {
    const matches = this.sentJson().filter((message) => message.type === type);
    return matches[matches.length - 1];
  }
}

function installBrowserMocks() {
  globalThis.window = { location: { href: 'https://localhost:5173/' } };
  MockWebSocket.reset();
}

function restoreBrowserMocks() {
  globalThis.window = originalWindow;
}

async function replySubscribeOk(socket, type = 'run.subscribe') {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const request = socket.sentRequest(type);
  if (request) socket.serverMessage({ id: request.id, ok: true, data: { subscribed: true } });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function authenticatedConn(getToken = () => 'token-1') {
  const conn = new (await import('../models/agentConnection.js')).AgentWsConnection('http://localhost:3099/agent', {
    getToken,
    WebSocketImpl: MockWebSocket,
  });
  const promise = conn.ready();
  await new Promise((resolve) => setTimeout(resolve, 0));
  MockWebSocket.instances[0].serverOpen();
  await new Promise((resolve) => setTimeout(resolve, 0));
  MockWebSocket.instances[0].serverMessage({
    id: MockWebSocket.instances[0].sentJson()[0].id,
    ok: true,
    data: { authenticated: true, needsAuth: false, capabilities: { wsProtocol: 1 } },
  });
  await promise;
  return conn;
}

test('connection performs hello and resolves requests by id', async () => {
  installBrowserMocks();
  try {
    const { AgentWsConnection } = await import('../models/agentConnection.js');
    const conn = new AgentWsConnection('http://localhost:3099/agent', {
      getToken: () => 'token-1',
      WebSocketImpl: MockWebSocket,
    });
    const promise = conn.request('ping', { x: 1 }, { timeoutMs: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const socket = MockWebSocket.instances[0];
    assert.equal(socket.url, 'wss://localhost:5173/agent/ws');
    socket.serverOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const hello = socket.sentJson()[0];
    assert.equal(hello.type, 'hello');
    assert.equal(hello.payload.token, 'token-1');
    socket.serverMessage({ id: hello.id, ok: true, data: { authenticated: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = socket.sentRequest('ping');
    assert.deepEqual(request.payload, { x: 1 });
    socket.serverMessage({ id: request.id, ok: true, data: { pong: true } });
    assert.deepEqual(await promise, { pong: true });
    assert.equal(conn.state, 'connected');
  } finally {
    restoreBrowserMocks();
  }
});

test('welcome with needsAuth leaves the connection usable but unauthenticated', async () => {
  installBrowserMocks();
  try {
    const { AgentWsConnection } = await import('../models/agentConnection.js');
    const conn = new AgentWsConnection('http://localhost:3099/agent', {
      getToken: () => null,
      WebSocketImpl: MockWebSocket,
    });
    const promise = conn.ready();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const socket = MockWebSocket.instances[0];
    socket.serverOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const hello = socket.sentJson()[0];
    socket.serverMessage({ id: hello.id, ok: true, data: { authenticated: false, needsAuth: true } });
    const welcome = await promise;
    assert.equal(welcome.needsAuth, true);
    assert.equal(conn.state, 'needsAuth');
    conn.close();
  } finally {
    restoreBrowserMocks();
  }
});

test('error replies map to coded errors and 5xx is retryable', async () => {
  installBrowserMocks();
  try {
    const conn = await authenticatedConn();
    const socket = MockWebSocket.instances[0];
    const rejected = conn.request('run.start', {}, { timeoutMs: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = socket.sentRequest('run.start');
    socket.serverMessage({ id: request.id, ok: false, error: 'Conflict', code: 409 });
    const error = await rejected.then(() => null, (err) => err);
    assert.equal(error.code, 409);
    assert.equal(error.retryable, undefined);

    const retryable = conn.request('run.start', {}, { timeoutMs: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request2 = socket.sentRequest('run.start');
    socket.serverMessage({ id: request2.id, ok: false, error: 'Boom', code: 500 });
    const error2 = await retryable.then(() => null, (err) => err);
    assert.equal(error2.retryable, true);
    conn.close();
  } finally {
    restoreBrowserMocks();
  }
});

test('unanswered requests time out with TimeoutError', async () => {
  installBrowserMocks();
  try {
    const conn = await authenticatedConn();
    const rejected = conn.request('ping', {}, { timeoutMs: 30 });
    const error = await rejected.then(() => null, (err) => err);
    assert.equal(error.name, 'TimeoutError');
    assert.equal(error.code, 'AGENT_REQUEST_TIMEOUT');
    conn.close();
  } finally {
    restoreBrowserMocks();
  }
});

test('connection loss fails pending requests and subscriptions', async () => {
  installBrowserMocks();
  try {
    const conn = await authenticatedConn();
    const socket = MockWebSocket.instances[0];
    const rejected = conn.request('job.get', { job_id: 'j1' }, { timeoutMs: 5_000 });
    const subErrors = [];
    const sub = conn.subscribe({
      request: 'run.subscribe',
      payload: { runId: 'run-1' },
      onData: () => {},
      onError: (error) => subErrors.push(error),
    });
    await replySubscribeOk(socket);
    await sub.ready;
    socket.emitClose();
    const error = await rejected.then(() => null, (err) => err);
    assert.equal(error.code, 'AGENT_CONNECTION_LOST');
    assert.equal(subErrors.length, 1);
    assert.equal(subErrors[0].code, 'AGENT_CONNECTION_LOST');
    assert.equal(conn.state, 'closed');
    conn.close();
  } finally {
    restoreBrowserMocks();
  }
});

test('subscription pushes are routed by sub id and can be unsubscribed', async () => {
  installBrowserMocks();
  try {
    const conn = await authenticatedConn();
    const socket = MockWebSocket.instances[0];
    const pushes = [];
    const sub = conn.subscribe({
      request: 'run.subscribe',
      payload: { runId: 'run-1' },
      onData: (type, data) => pushes.push({ type, data }),
    });
    await replySubscribeOk(socket);
    await sub.ready;
    const subId = socket.sentRequest('run.subscribe').payload.sub;
    socket.serverMessage({ type: 'run.events', sub: subId, data: { events: [1] } });
    socket.serverMessage({ type: 'run.events', sub: 'other-sub', data: { events: [2] } });
    assert.deepEqual(pushes, [{ type: 'run.events', data: { events: [1] } }]);
    sub.unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(socket.sentRequest('unsubscribe').payload.sub, subId);
    socket.serverMessage({ type: 'run.events', sub: subId, data: { events: [3] } });
    assert.equal(pushes.length, 1);
    conn.close();
  } finally {
    restoreBrowserMocks();
  }
});

test('binary streams reassemble in order and resolve on the final chunk', async () => {
  installBrowserMocks();
  try {
    const conn = await authenticatedConn();
    const socket = MockWebSocket.instances[0];
    const received = conn.receiveStream(77);
    socket.serverBinary(77, 'hello ', false);
    socket.serverBinary(77, 'world', true);
    const chunks = await received;
    const text = chunks.map((chunk) => new TextDecoder().decode(chunk)).join('');
    assert.equal(text, 'hello world');
    conn.close();
  } finally {
    restoreBrowserMocks();
  }
});

test('a new request after a drop opens a fresh connection', async () => {
  installBrowserMocks();
  try {
    const conn = await authenticatedConn();
    const first = MockWebSocket.instances[0];
    first.emitClose();
    const promise = conn.request('ping', {}, { timeoutMs: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = MockWebSocket.instances[1];
    assert.notEqual(second, first);
    second.serverOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const hello = second.sentJson()[0];
    second.serverMessage({ id: hello.id, ok: true, data: { authenticated: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = second.sentRequest('ping');
    second.serverMessage({ id: request.id, ok: true, data: {} });
    await promise;
    conn.close();
  } finally {
    restoreBrowserMocks();
  }
});

test('getAgentConnection shares instances per resolved URL and reset clears them', async () => {
  installBrowserMocks();
  try {
    const mod = await import('../models/agentConnection.js');
    const a = mod.getAgentConnection('http://localhost:3099/agent');
    const b = mod.getAgentConnection('/agent');
    assert.equal(a, b);
    const other = mod.getAgentConnection('https://example.com/agent');
    assert.notEqual(other, a);
    mod.resetAgentConnections();
    assert.notEqual(mod.getAgentConnection('http://localhost:3099/agent'), a);
  } finally {
    restoreBrowserMocks();
  }
});

test('resolveAgentWsUrl maps remote origins onto the served endpoint', async () => {
  installBrowserMocks();
  try {
    const { resolveAgentWsUrl } = await import('../models/agentConnection.js');
    // Bare origin: the server only serves /agent/ws, never /ws.
    assert.equal(
      resolveAgentWsUrl('https://cherry-sandbox.example.com:6060'),
      'wss://cherry-sandbox.example.com:6060/agent/ws',
    );
    assert.equal(
      resolveAgentWsUrl('https://cherry-sandbox.example.com:6060/'),
      'wss://cherry-sandbox.example.com:6060/agent/ws',
    );
    // Explicit /agent suffix keeps resolving to the canonical endpoint.
    assert.equal(
      resolveAgentWsUrl('https://cherry-sandbox.example.com:6060/agent'),
      'wss://cherry-sandbox.example.com:6060/agent/ws',
    );
    // Non-agent paths stay proxy-mounted prefixes.
    assert.equal(
      resolveAgentWsUrl('https://proxy.example.com/prefix'),
      'wss://proxy.example.com/prefix/ws',
    );
  } finally {
    restoreBrowserMocks();
  }
});
