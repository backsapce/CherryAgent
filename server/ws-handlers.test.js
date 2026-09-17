import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WS_OPCODE, encodeMaskedWsFrame, parseWsFrames } from './ws-frames.js';
import { createAgentWsServer } from './ws-protocol.js';
import { createDomainHandlers } from './ws-handlers.js';

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
  serverMessages() {
    return parseWsFrames(Buffer.concat(this.written)).frames
      .filter((frame) => frame.opcode === WS_OPCODE.TEXT)
      .map((frame) => JSON.parse(frame.payload.toString('utf8')));
  }
  replyOf(id) {
    const matches = this.serverMessages().filter((message) => message.id === id);
    return matches[matches.length - 1];
  }
  pushes(type) {
    return this.serverMessages().filter((message) => message.sub !== undefined && message.type === type);
  }
}

function createStubHandle() {
  return {
    terminated: null,
    result: Promise.resolve({ stdout: '', stderr: '', code: 0, status: 'exited', platform: 'linux', shell: 'bash', cwd: 'workspace', filesRoot: 'workspace' }),
    terminate(reason) {
      this.terminated = reason;
      this.result = Promise.resolve({ stdout: '', stderr: '', code: 130, status: 'aborted', platform: 'linux', shell: 'bash', cwd: 'workspace', filesRoot: 'workspace' });
    },
  };
}

function createFixture(overrides = {}) {
  const state = { terminated: [], jobs: new Map() };
  const handles = [];
  const streamCommand = (cmd, callbacks) => {
    const handle = createStubHandle();
    if (/^sleep/.test(cmd)) {
      // Keep the stream open until terminate() is called, mirroring a real
      // long-running command.
      handle.result = new Promise((resolve) => {
        handle.settle = (result) => resolve(result);
      });
      handle.terminate = (reason) => {
        if (handle.terminated) return;
        handle.terminated = reason;
        state.terminated.push(cmd);
        handle.settle?.({ stdout: '', stderr: '', code: 130, status: 'aborted', platform: 'linux', shell: 'bash', cwd: 'workspace', filesRoot: 'workspace' });
      };
      handles.push({ cmd, callbacks, handle });
      return handle;
    }
    handles.push({ cmd, callbacks, handle });
    handle.result.then((result) => {
      callbacks.onStart?.({ platform: 'linux', shell: 'bash', cwd: 'workspace', filesRoot: 'workspace' });
      callbacks.onStdout?.(`out:${cmd}`);
      callbacks.onExit?.(result);
    });
    return handle;
  };
  const jobManager = {
    start(command) {
      const job = { job_id: `job-${state.jobs.size + 1}`, status: 'running', command, nextCursor: 0, hasMore: false, log: '' };
      state.jobs.set(job.job_id, job);
      return { ...job };
    },
    get(id, cursor = 0) {
      const job = state.jobs.get(id);
      if (!job) return null;
      return { ...job, logCursor: cursor, nextCursor: cursor, hasMore: false };
    },
    async wait(id, { cursor = 0, waitMs } = {}) {
      // Tiny bounded delay so the subscription loop cannot spin hot.
      await new Promise((resolve) => setTimeout(resolve, Math.min(Number(waitMs) || 5, 10)));
      return jobManager.get(id, cursor);
    },
    async stop(id) {
      const job = state.jobs.get(id);
      if (!job) return null;
      job.status = 'stopped';
      return { ...job };
    },
  };
  const server = createAgentWsServer({
    isValidToken: (token) => token === 'tok',
    handlers: createDomainHandlers({
      streamCommand,
      validateCommand: (cmd) => (/danger/.test(cmd)
        ? { blocked: true, reason: 'test pattern' }
        : { blocked: false }),
      rateLimit: () => false,
      jobManager,
      runWebSearch: overrides.runWebSearch || (async () => ({ results: [] })),
      fetchWebPage: overrides.fetchWebPage || (async () => ({ url: 'https://ok', text: 'page' })),
      normalizeWebUrl: (value) => (/^https:\/\//.test(String(value || '')) ? value : null),
      isPrivateWebHostname: (hostname) => String(hostname).endsWith('.internal'),
    }),
    heartbeatIntervalMs: 2_147_483_000,
    unauthIdleMs: 2_147_483_000,
  });
  const socket = new FakeSocket();
  server.handleUpgrade(socket, '127.0.0.1');
  socket.clientJson({ id: 'h', type: 'hello', payload: { token: 'tok' } });
  return { socket, state, handles, jobManager };
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

test('exec.start streams start, data, and exit pushes to the subscriber', async () => {
  const { socket } = createFixture();
  socket.clientJson({ id: 'q1', type: 'exec.start', payload: { sub: 'e1', cmd: 'echo hi' } });
  await flush();
  assert.equal(socket.replyOf('q1')?.ok, true);
  assert.equal(socket.pushes('exec.start')[0].data.platform, 'linux');
  assert.deepEqual(socket.pushes('exec.data').map((push) => push.data), [
    { stream: 'stdout', data: 'out:echo hi' },
  ]);
  const exit = socket.pushes('exec.exit')[0];
  assert.equal(exit.sub, 'e1');
  assert.equal(exit.data.code, 0);
});

test('exec.start rejects blocked commands with 403', async () => {
  const { socket } = createFixture();
  socket.clientJson({ id: 'q1', type: 'exec.start', payload: { sub: 'e1', cmd: 'danger rm -rf /' } });
  await flush();
  const reply = socket.replyOf('q1');
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 403);
  assert.match(reply.error, /blocked/i);
});

test('exec.cancel terminates the running stream', async () => {
  const { socket, handles, state } = createFixture();
  socket.clientJson({ id: 'q1', type: 'exec.start', payload: { sub: 'e9', cmd: 'sleep 100' } });
  await flush();
  const running = handles[handles.length - 1];
  socket.clientJson({ id: 'q2', type: 'exec.cancel', payload: { sub: 'e9' } });
  await flush();
  assert.equal(socket.replyOf('q2')?.ok, true);
  assert.equal(running.handle.terminated, 'aborted');
  assert.deepEqual(state.terminated, ['sleep 100']);
});

test('connection close terminates foreground command streams', async () => {
  const { socket, handles } = createFixture();
  socket.clientJson({ id: 'q1', type: 'exec.start', payload: { sub: 'e1', cmd: 'sleep 100' } });
  await flush();
  const running = handles[handles.length - 1];
  socket.destroy();
  assert.equal(running.handle.terminated, 'aborted');
});

test('job.start, job.get, and job.stop mirror the manager API', async () => {
  const { socket } = createFixture();
  socket.clientJson({ id: 'q1', type: 'job.start', payload: { command: 'python train.py' } });
  await flush();
  assert.equal(socket.replyOf('q1')?.data.job_id, 'job-1');
  socket.clientJson({ id: 'q2', type: 'job.get', payload: { job_id: 'job-1', cursor: 17 } });
  await flush();
  assert.equal(socket.replyOf('q2')?.data.job_id, 'job-1');
  socket.clientJson({ id: 'q3', type: 'job.stop', payload: { job_id: 'job-1' } });
  await flush();
  assert.equal(socket.replyOf('q3')?.data.status, 'stopped');
  socket.clientJson({ id: 'q4', type: 'job.get', payload: { job_id: 'missing' } });
  await flush();
  assert.equal(socket.replyOf('q4')?.code, 404);
});

test('job.subscribe pushes the initial snapshot and follows terminal updates', async () => {
  const { socket, state } = createFixture();
  socket.clientJson({ id: 'q1', type: 'job.start', payload: { command: 'build' } });
  await flush();
  const jobId = socket.replyOf('q1').data.job_id;
  socket.clientJson({ id: 'q2', type: 'job.subscribe', payload: { sub: 'j1', job_id: jobId, cursor: 0 } });
  await flush();
  const updates = socket.pushes('job.update');
  assert.equal(updates[0].data.job_id, jobId);
  assert.equal(updates[0].data.status, 'running');
  assert.equal(socket.replyOf('q2')?.ok, true);
  // The waiter keeps following until the job turns terminal without pending
  // logs; drive that and confirm a second push arrives.
  state.jobs.get(jobId).status = 'completed';
  await new Promise((resolve) => setTimeout(resolve, 30));
  const afterTerminal = socket.pushes('job.update');
  assert.ok(afterTerminal.length >= 2, 'expected a terminal job.update push');
  assert.equal(afterTerminal[afterTerminal.length - 1].data.status, 'completed');
});

test('job.subscribe rejects unknown jobs', async () => {
  const { socket } = createFixture();
  socket.clientJson({ id: 'q1', type: 'job.subscribe', payload: { sub: 'j1', job_id: 'nope' } });
  await flush();
  assert.equal(socket.replyOf('q1')?.code, 404);
});

test('web.search validates the query and forwards the provider config', async () => {
  let seen = null;
  const { socket } = createFixture({
    runWebSearch: async (config, request) => {
      seen = { config, request };
      return { results: [{ title: 'one' }] };
    },
  });
  socket.clientJson({ id: 'q1', type: 'web.search', payload: { config: { provider: 'searxng' }, request: { query: 'hello' } } });
  await flush();
  assert.equal(socket.replyOf('q1')?.ok, true);
  assert.equal(seen.config.provider, 'searxng');
  assert.equal(seen.request.query, 'hello');

  socket.clientJson({ id: 'q2', type: 'web.search', payload: { config: {}, request: {} } });
  await flush();
  assert.equal(socket.replyOf('q2')?.code, 400);
});

test('web.fetch rejects private hosts and forwards valid URLs', async () => {
  let fetched = null;
  const { socket } = createFixture({
    fetchWebPage: async (url) => {
      fetched = url;
      return { url, text: 'body' };
    },
  });
  socket.clientJson({ id: 'q1', type: 'web.fetch', payload: { url: 'https://host.internal/page' } });
  await flush();
  assert.equal(socket.replyOf('q1')?.code, 403);

  socket.clientJson({ id: 'q2', type: 'web.fetch', payload: { url: 'https://example.com/page', max_chars: 500 } });
  await flush();
  assert.equal(socket.replyOf('q2')?.ok, true);
  assert.equal(fetched, 'https://example.com/page');
});
