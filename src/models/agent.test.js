import assert from 'node:assert/strict';
import test from 'node:test';
import { resetAgentConnections } from './agentConnection.js';
import {
  abortRemoteAgentRun,
  assertRemoteAgentRunProtocol,
  checkAgentAvailable,
  executeCommand,
  getCommand,
  getRemoteAgentRun,
  listFiles,
  listRemoteFiles,
  startRemoteAgentRun,
  startCommand,
  stopCommand,
  waitCommand,
} from './agent.js';

// ─── Browser mocks ──────────────────────────────────────────────────────────

function installBrowserMocks(WebSocketMock, fetchMock) {
  const previous = {
    window: globalThis.window,
    WebSocket: globalThis.WebSocket,
    fetch: globalThis.fetch,
  };
  globalThis.window = {
    location: {
      href: 'https://localhost:5173/',
      origin: 'https://localhost:5173',
    },
  };
  globalThis.WebSocket = WebSocketMock;
  globalThis.fetch = fetchMock;
  resetAgentConnections();
  return () => {
    resetAgentConnections();
    Object.assign(globalThis, previous);
  };
}

/**
 * Scripted agent server: speaks the WS protocol far enough to drive the
 * client module — hello/welcome, exec streams, and managed jobs. Per-test
 * behavior is swapped through the static `handlers` map.
 */
class AgentServerMock extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances = [];
  static handlers = {};
  static capabilities = { agentRunProtocol: 4, wsProtocol: 1 };
  static reset(handlers = {}, capabilities = { agentRunProtocol: 4, wsProtocol: 1 }) {
    AgentServerMock.instances = [];
    AgentServerMock.handlers = handlers;
    AgentServerMock.capabilities = capabilities;
  }

  constructor(url) {
    super();
    this.url = url;
    this.readyState = AgentServerMock.CONNECTING;
    this.sent = [];
    this.binaryType = 'blob';
    AgentServerMock.instances.push(this);
    queueMicrotask(() => {
      this.readyState = AgentServerMock.OPEN;
      this.dispatchEvent(new Event('open'));
    });
  }

  send(data) {
    this.sent.push(data);
    const message = JSON.parse(data);
    queueMicrotask(() => this.handleMessage(message));
  }

  close() {
    if (this.readyState === AgentServerMock.CLOSED) return;
    this.readyState = AgentServerMock.CLOSED;
    queueMicrotask(() => this.dispatchEvent(new Event('close')));
  }

  reply(id, ok, payload) {
    this.serverSend(ok ? { id, ok: true, data: payload } : { id, ok: false, ...payload });
  }

  push(type, sub, data) {
    this.serverSend({ type, sub, data });
  }

  serverSend(value) {
    queueMicrotask(() => {
      if (this.readyState !== AgentServerMock.OPEN) return;
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
    });
  }

  sentJson() {
    return this.sent.map((entry) => JSON.parse(entry));
  }

  sentRequest(type) {
    const matches = this.sentJson().filter((message) => message.type === type);
    return matches[matches.length - 1];
  }

  async handleMessage(message) {
    if (message.type === 'hello') {
      this.reply(message.id, true, {
        authenticated: true,
        needsAuth: false,
        capabilities: { ...AgentServerMock.capabilities },
      });
      return;
    }
    const handler = AgentServerMock.handlers[message.type];
    if (!handler) {
      this.reply(message.id, false, { error: `Unknown type ${message.type}`, code: 400 });
      return;
    }
    try {
      const data = await handler(message.payload ?? {}, this);
      this.reply(message.id, true, data ?? {});
    } catch (error) {
      this.reply(message.id, false, { error: error.message, code: error.code ?? 500 });
    }
  }
}

function defaultWsHandlers() {
  return {
    'exec.start': (payload, server) => {
      const { sub, cmd } = payload;
      server.push('exec.start', sub, { platform: 'linux', shell: 'bash', cwd: 'workspace', filesRoot: 'workspace' });
      server.push('exec.data', sub, { stream: 'stdout', data: `hello ${cmd}` });
      server.push('exec.data', sub, { stream: 'stderr', data: 'warned' });
      server.push('exec.exit', sub, { stdout: `hello ${cmd}`, stderr: 'warned', code: 0, status: 'exited' });
      return { started: true };
    },
    'job.start': () => ({ job_id: 'job-one', status: 'running', nextCursor: 0, hasMore: false }),
    'job.get': (payload) => ({ job_id: payload.job_id, status: 'running', log: '', nextCursor: payload.cursor, hasMore: false }),
    'job.stop': (payload) => ({ job_id: payload.job_id, status: 'stopped' }),
    'job.subscribe': (payload, server) => {
      const { sub } = payload;
      server.push('job.update', sub, { job_id: payload.job_id, status: 'running', log: 'starting', nextCursor: 8, hasMore: false });
      server.push('job.update', sub, { job_id: payload.job_id, status: 'completed', exit_code: 0, log: 'done', nextCursor: 12, hasMore: false });
      return { subscribed: true };
    },
    'file.list': () => ({ id: 'root', name: '/', type: 'directory', children: [] }),
  };
}

// ─── WebSocket transport (commands, jobs, health) ───────────────────────────

test('executeCommand streams output and resolves with the accumulated result', async () => {
  AgentServerMock.reset(defaultWsHandlers());
  const restore = installBrowserMocks(AgentServerMock, async () => {
    throw new Error('HTTP should not be called');
  });

  try {
    const chunks = [];
    const result = await executeCommand('printf hi', 'https://sandbox.example', {
      onStdout: (chunk) => chunks.push(chunk),
    });
    assert.equal(result.stdout, 'hello printf hi');
    assert.equal(result.stderr, 'warned');
    assert.equal(result.code, 0);
    assert.equal(result.platform, 'linux');
    assert.equal(result.cwd, 'workspace');
    assert.deepEqual(chunks, ['hello printf hi']);
  } finally {
    restore();
  }
});

test('executeCommand rejects when the server reports an exec error', async () => {
  AgentServerMock.reset({
    ...defaultWsHandlers(),
    'exec.start': (payload, server) => {
      server.push('exec.error', payload.sub, { error: 'spawn failed' });
      return { started: false };
    },
  });
  const restore = installBrowserMocks(AgentServerMock, async () => {
    throw new Error('HTTP should not be called');
  });

  try {
    await assert.rejects(executeCommand('bad-binary', 'https://sandbox.example'), /spawn failed/);
  } finally {
    restore();
  }
});

test('checkAgentAvailable reports the welcome state and failures', async () => {
  AgentServerMock.reset(defaultWsHandlers());
  const restore = installBrowserMocks(AgentServerMock, async () => { throw new Error('no http'); });

  try {
    const result = await checkAgentAvailable('https://sandbox.example');
    assert.deepEqual(result, { available: true, needsAuth: false });
  } finally {
    restore();
  }

  class DeadSocket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => {
        this.dispatchEvent(new Event('error'));
        this.dispatchEvent(new Event('close'));
      });
    }
    send() {}
    close() {}
  }
  const restoreDead = installBrowserMocks(DeadSocket, async () => { throw new Error('no http'); });
  try {
    const result = await checkAgentAvailable('https://unreachable.example');
    assert.deepEqual(result, { available: false, needsAuth: false });
  } finally {
    restoreDead();
  }
});

test('managed commands and waits ride the multiplexed connection', async () => {
  const seen = [];
  const handlers = defaultWsHandlers();
  for (const type of Object.keys(handlers)) {
    const inner = handlers[type];
    handlers[type] = (payload, server) => {
      seen.push(type);
      return inner(payload, server);
    };
  }
  AgentServerMock.reset(handlers);
  const restore = installBrowserMocks(AgentServerMock, async () => {
    throw new Error('HTTP should not be called');
  });

  try {
    const started = await startCommand('python train.py', 'https://sandbox.example');
    assert.equal(started.job_id, 'job-one');

    const snapshot = await getCommand('job-one', 'https://sandbox.example', 17);
    assert.equal(snapshot.status, 'running');

    const waited = await waitCommand('job-one', 'https://sandbox.example', { cursor: 23, waitMs: 5_000 });
    assert.equal(waited.status, 'completed');
    assert.equal(waited.exit_code, 0);
    // Pushes deliver incremental log slices; the result must carry them all.
    assert.equal(waited.log, 'startingdone');

    const stopped = await stopCommand('job-one', 'https://sandbox.example');
    assert.equal(stopped.status, 'stopped');

    assert.deepEqual(seen, ['job.start', 'job.get', 'job.subscribe', 'job.stop']);
    const subscribe = AgentServerMock.instances[0].sentRequest('job.subscribe');
    assert.equal(subscribe.payload.job_id, 'job-one');
    assert.equal(subscribe.payload.cursor, 23);
  } finally {
    restore();
  }
});

test('waitCommand returns the newest snapshot when the wait budget elapses', async () => {
  AgentServerMock.reset({
    ...defaultWsHandlers(),
    'job.subscribe': (payload, server) => {
      // Never terminal: the client must resolve on its wait budget.
      server.push('job.update', payload.sub, { job_id: payload.job_id, status: 'running', log: 'tick', nextCursor: 3, hasMore: false });
      return { subscribed: true };
    },
  });
  const restore = installBrowserMocks(AgentServerMock, async () => { throw new Error('no http'); });

  try {
    const result = await waitCommand('job-slow', 'https://sandbox.example', { cursor: 0, waitMs: 80 });
    assert.equal(result.status, 'running');
    assert.equal(result.log, 'tick');
  } finally {
    restore();
  }
});

test('waitCommand appends one fresh read when the budget elapses', async () => {
  AgentServerMock.reset({
    ...defaultWsHandlers(),
    'job.subscribe': (payload, server) => {
      // Never terminal, and the push goes stale right after delivery.
      server.push('job.update', payload.sub, { job_id: payload.job_id, status: 'running', log: 'stale ', logCursor: 0, nextCursor: 6, logSize: 6, hasMore: false });
      return { subscribed: true };
    },
    'job.get': (payload) => ({
      job_id: payload.job_id,
      status: 'running',
      log: 'fresh',
      logCursor: payload.cursor,
      nextCursor: payload.cursor + 5,
      logSize: payload.cursor + 5,
      hasMore: false,
    }),
  });
  const restore = installBrowserMocks(AgentServerMock, async () => { throw new Error('no http'); });

  try {
    const result = await waitCommand('job-slow', 'https://sandbox.example', { cursor: 0, waitMs: 80 });
    assert.equal(result.status, 'running');
    assert.equal(result.log, 'stale fresh');
    // The fresh read continues after the pushed slice instead of repeating it.
    const finalRead = AgentServerMock.instances[0].sentRequest('job.get');
    assert.equal(finalRead.payload.cursor, 6);
  } finally {
    restore();
  }
});

test('waitCommand resubscribes after a connection reset instead of returning a stale snapshot', async () => {
  AgentServerMock.reset({
    ...defaultWsHandlers(),
    'job.subscribe': (payload, server) => {
      if (AgentServerMock.instances.indexOf(server) === 0) {
        server.push('job.update', payload.sub, { job_id: payload.job_id, status: 'running', log: 'first ', logCursor: 0, nextCursor: 6, logSize: 6, hasMore: false });
        // Drop the socket mid-wait; the client must reconnect and keep waiting.
        setTimeout(() => server.close(), 10);
      } else {
        server.push('job.update', payload.sub, { job_id: payload.job_id, status: 'completed', exit_code: 0, log: 'second', logCursor: 6, nextCursor: 12, logSize: 12, hasMore: false });
      }
      return { subscribed: true };
    },
  });
  const restore = installBrowserMocks(AgentServerMock, async () => { throw new Error('no http'); });

  try {
    const result = await waitCommand('job-drop', 'https://sandbox.example', { cursor: 0, waitMs: 5_000 });
    assert.equal(result.status, 'completed');
    assert.equal(result.exit_code, 0);
    // The post-reset subscription resumes after the bytes already received.
    assert.equal(result.log, 'first second');
    assert.ok(AgentServerMock.instances.length >= 2, 'client should have reconnected');
    const resubscribe = AgentServerMock.instances[1].sentRequest('job.subscribe');
    assert.equal(resubscribe.payload.job_id, 'job-drop');
    assert.equal(resubscribe.payload.cursor, 6);
  } finally {
    restore();
  }
});

test('waitCommand drains capped logs after a terminal push', async () => {
  AgentServerMock.reset({
    ...defaultWsHandlers(),
    'job.subscribe': (payload, server) => {
      server.push('job.update', payload.sub, {
        job_id: payload.job_id,
        status: 'completed',
        exit_code: 0,
        log: 'first half ',
        logCursor: 0,
        nextCursor: 11,
        logSize: 22,
        hasMore: true,
      });
      return { subscribed: true };
    },
    'job.get': (payload) => ({
      job_id: payload.job_id,
      status: 'completed',
      exit_code: 0,
      log: 'second half',
      logCursor: payload.cursor,
      nextCursor: 22,
      logSize: 22,
      hasMore: false,
    }),
  });
  const restore = installBrowserMocks(AgentServerMock, async () => { throw new Error('no http'); });

  try {
    const result = await waitCommand('job-capped', 'https://sandbox.example', { cursor: 0, waitMs: 2_000 });
    assert.equal(result.status, 'completed');
    assert.equal(result.log, 'first half second half');
    assert.equal(result.hasMore, false);
    const drain = AgentServerMock.instances[0].sentRequest('job.get');
    assert.equal(drain.payload.cursor, 11);
  } finally {
    restore();
  }
});

test('waitCommand fails fast when the server rejects the subscription', async () => {
  AgentServerMock.reset({
    ...defaultWsHandlers(),
    'job.subscribe': () => {
      throw Object.assign(new Error('Background command not found'), { code: 404 });
    },
  });
  const restore = installBrowserMocks(AgentServerMock, async () => { throw new Error('no http'); });

  try {
    await assert.rejects(
      waitCommand('job-gone', 'https://sandbox.example', { cursor: 0, waitMs: 5_000 }),
      /Background command not found/
    );
  } finally {
    restore();
  }
});

// ─── Durable runs over the WebSocket protocol ───────────────────────────────

test('remote run cancel and state address the run by id', async () => {
  AgentServerMock.reset({
    'run.cancel': () => new Promise(() => {}),
    'run.state': (payload) => ({ id: payload.runId, status: 'waiting', sequence: 34, events: [] }),
  });
  const restore = installBrowserMocks(AgentServerMock, async () => { throw new Error('no http'); });

  try {
    const controller = new AbortController();
    const pending = abortRemoteAgentRun('https://sandbox.example', 'run one', controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await assert.rejects(pending, (error) => error?.name === 'AbortError');
    const cancel = AgentServerMock.instances[0].sentRequest('run.cancel');
    assert.equal(cancel.payload.runId, 'run one');

    const run = await getRemoteAgentRun('https://sandbox.example', 'run-one', 34);
    assert.equal(run.status, 'waiting');
    const state = AgentServerMock.instances[0].sentRequest('run.state');
    assert.equal(state.payload.runId, 'run-one');
    assert.equal(state.payload.after, 34);
  } finally {
    restore();
  }
});

test('sandbox runs reject an outdated agent run protocol before starting', async () => {
  AgentServerMock.reset(defaultWsHandlers(), { agentRunProtocol: 3 });
  const restore = installBrowserMocks(AgentServerMock, async () => { throw new Error('no http'); });

  try {
    await assert.rejects(
      startRemoteAgentRun('https://sandbox.example', { sessionId: 'one' }),
      (error) => {
        assert.match(error.message, /runtime is outdated.*protocol 3.*4 required/i);
        assert.equal(error.code, 'AGENT_RUN_PROTOCOL_OUTDATED');
        return true;
      }
    );
    assert.equal(AgentServerMock.instances[0].sentRequest('run.start'), undefined);
  } finally {
    restore();
  }
});

test('sandbox run reattachment also rejects an outdated runtime protocol', async () => {
  AgentServerMock.reset(defaultWsHandlers(), { agentRunProtocol: 2 });
  const restore = installBrowserMocks(AgentServerMock, async () => { throw new Error('no http'); });

  try {
    await assert.rejects(
      assertRemoteAgentRunProtocol('https://sandbox.example'),
      /runtime is outdated.*protocol 2.*4 required/i
    );
  } finally {
    restore();
  }
});

test('sandbox runs start after confirming the current agent run protocol', async () => {
  AgentServerMock.reset({
    ...defaultWsHandlers(),
    'run.start': (payload) => ({ id: payload.runId, status: 'running' }),
  });
  const restore = installBrowserMocks(AgentServerMock, async () => { throw new Error('no http'); });

  try {
    const result = await startRemoteAgentRun('https://sandbox.example', { sessionId: 'one', runId: 'run-abc123' });
    assert.equal(result.id, 'run-abc123');
    const request = AgentServerMock.instances[0].sentRequest('run.start');
    assert.deepEqual(request.payload, { sessionId: 'one', runId: 'run-abc123' });
  } finally {
    restore();
  }
});

test('sandbox run start errors distinguish preflight failure from an attempted start', async () => {
  class DeadSocket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => {
        this.dispatchEvent(new Event('error'));
        this.dispatchEvent(new Event('close'));
      });
    }
    send() {}
    close() {}
  }
  const restore = installBrowserMocks(DeadSocket, async () => { throw new Error('no http'); });

  try {
    await assert.rejects(
      startRemoteAgentRun('https://sandbox.example', { sessionId: 'one' }),
      (error) => {
        assert.equal(error.name, 'AgentRuntimeNetworkError');
        assert.notEqual(error.agentRunRequestStarted, true);
        return true;
      }
    );
  } finally {
    restore();
  }

  AgentServerMock.reset({
    ...defaultWsHandlers(),
    'run.start': () => Promise.reject(new Error('start response lost')),
  });
  const restore2 = installBrowserMocks(AgentServerMock, async () => { throw new Error('no http'); });
  try {
    await assert.rejects(
      startRemoteAgentRun('https://sandbox.example', { sessionId: 'one' }),
      (error) => {
        assert.match(error.message, /start response lost/);
        assert.equal(error.agentRunRequestStarted, true);
        return true;
      }
    );
  } finally {
    restore2();
  }
});

test('a definitive 4xx run.start rejection is not marked as an attempted start', async () => {
  // The server processed and refused the request (e.g. validation or an
  // active-run conflict), so the recovery probe would only mask the real
  // error behind a misleading "Agent run not found".
  const rejection = new Error('Session one already has an active agent run.');
  rejection.code = 409;
  AgentServerMock.reset({
    ...defaultWsHandlers(),
    'run.start': () => Promise.reject(rejection),
  });
  const restore = installBrowserMocks(AgentServerMock, async () => { throw new Error('no http'); });

  try {
    await assert.rejects(
      startRemoteAgentRun('https://sandbox.example', { sessionId: 'one' }),
      (error) => {
        assert.match(error.message, /active agent run/);
        assert.equal(error.status, 409);
        assert.notEqual(error.agentRunRequestStarted, true);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('sandbox run network failures include runtime connectivity diagnostics', async () => {
  class DeadSocket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => {
        this.dispatchEvent(new Event('error'));
        this.dispatchEvent(new Event('close'));
      });
    }
    send() {}
    close() {}
  }
  const restore = installBrowserMocks(DeadSocket, async () => { throw new Error('no http'); });

  try {
    await assert.rejects(
      assertRemoteAgentRunProtocol('https://sandbox.example'),
      (error) => {
        assert.equal(error.name, 'AgentRuntimeNetworkError');
        assert.match(error.message, /cherry-sandbox is running/i);
        assert.match(error.message, /AGENT_ALLOWED_ORIGINS/);
        assert.match(error.message, /Local Network Access/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('remote run state settles on a deadline when the server stalls', { timeout: 2_000 }, async () => {
  AgentServerMock.reset({ 'run.state': () => new Promise(() => {}) });
  const restore = installBrowserMocks(AgentServerMock, async () => { throw new Error('no http'); });

  try {
    await assert.rejects(
      getRemoteAgentRun('https://sandbox.example', 'run-one', 0, { timeoutMs: 30 }),
      (error) => {
        assert.equal(error.name, 'TimeoutError');
        assert.equal(error.code, 'AGENT_REQUEST_TIMEOUT');
        return true;
      }
    );
  } finally {
    restore();
  }
});

// ─── Sandbox files over the WebSocket protocol ──────────────────────────────

test('remote run start scales its deadline with the payload size', async () => {
  AgentServerMock.reset({
    ...defaultWsHandlers(),
    'run.start': () => new Promise(() => {}),
  });
  const restore = installBrowserMocks(AgentServerMock, async () => { throw new Error('no http'); });

  try {
    await assert.rejects(
      startRemoteAgentRun('https://sandbox.example', { sessionId: 'one' }, { timeoutMs: 30 }),
      (error) => {
        assert.equal(error.name, 'TimeoutError');
        assert.equal(error.code, 'AGENT_REQUEST_TIMEOUT');
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('sandbox file requests time out when the server stalls', { timeout: 2_000 }, async () => {
  AgentServerMock.reset({ 'file.list': () => new Promise(() => {}) });
  const restore = installBrowserMocks(AgentServerMock, async () => { throw new Error('no http'); });

  try {
    await assert.rejects(
      listRemoteFiles('skills', 'https://sandbox.example', { timeoutMs: 30 }),
      (error) => {
        assert.equal(error.name, 'TimeoutError');
        assert.equal(error.code, 'AGENT_REQUEST_TIMEOUT');
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('sandbox file requests honor caller cancellation', { timeout: 2_000 }, async () => {
  AgentServerMock.reset({ 'file.list': () => new Promise(() => {}) });
  const restore = installBrowserMocks(AgentServerMock, async () => { throw new Error('no http'); });

  try {
    const controller = new AbortController();
    const pending = listRemoteFiles('skills', 'https://sandbox.example', { signal: controller.signal, timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(pending, (error) => error?.name === 'AbortError');
  } finally {
    restore();
  }
});

test('sandbox file requests route configured loopback hosts through the page proxy', async () => {
  AgentServerMock.reset(defaultWsHandlers());
  const restore = installBrowserMocks(AgentServerMock, async () => { throw new Error('no http'); });
  window.location.href = 'https://192.168.1.20:5173/';
  window.location.origin = 'https://192.168.1.20:5173';

  try {
    await listRemoteFiles('', 'http://localhost:3099');
    assert.equal(AgentServerMock.instances[0].url, 'wss://192.168.1.20:5173/agent/ws');
  } finally {
    restore();
  }
});

test('sandbox requests preserve an explicit non-default localhost port', async () => {
  AgentServerMock.reset(defaultWsHandlers());
  const restore = installBrowserMocks(AgentServerMock, async () => { throw new Error('no http'); });

  try {
    await listRemoteFiles('', 'http://localhost:3100/agent');
    assert.equal(AgentServerMock.instances[0].url, 'ws://localhost:3100/agent/ws');
  } finally {
    restore();
  }
});

test('sandbox file requests honor an explicit session sandbox URL', async () => {
  AgentServerMock.reset(defaultWsHandlers());
  const restore = installBrowserMocks(AgentServerMock, async () => { throw new Error('no http'); });

  try {
    await listFiles('src', 'https://sandbox.example');
    const request = AgentServerMock.instances[0].sentRequest('file.list');
    assert.equal(request.payload.path, 'src');
    assert.equal(request.payload.recursive, false);
  } finally {
    restore();
  }
});

test('recursive sandbox file requests pass the recursive flag', async () => {
  AgentServerMock.reset(defaultWsHandlers());
  const restore = installBrowserMocks(AgentServerMock, async () => { throw new Error('no http'); });

  try {
    await listFiles('', 'https://sandbox.example', { recursive: true });
    const request = AgentServerMock.instances[0].sentRequest('file.list');
    assert.equal(request.payload.recursive, true);
  } finally {
    restore();
  }
});

test('sandbox file requests can explicitly include hidden entries', async () => {
  AgentServerMock.reset(defaultWsHandlers());
  const restore = installBrowserMocks(AgentServerMock, async () => { throw new Error('no http'); });

  try {
    await listFiles('', 'https://sandbox.example', { includeHidden: true });
    const request = AgentServerMock.instances[0].sentRequest('file.list');
    assert.equal(request.payload.includeHidden, true);
  } finally {
    restore();
  }
});
