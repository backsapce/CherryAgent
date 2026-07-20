import assert from 'node:assert/strict';
import test from 'node:test';
import {
  abortRemoteAgentRun,
  executeCommand,
  getCommand,
  listFiles,
  listRemoteFiles,
  startCommand,
  stopCommand,
  waitCommand,
} from './agent.js';

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
  return () => Object.assign(globalThis, previous);
}

class MockWebSocket extends EventTarget {
  close() {}
}

test('executeCommand falls back to HTTP when the WebSocket cannot connect', async () => {
  let fetchCalls = 0;
  class ConnectionFailureWebSocket extends MockWebSocket {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event('error')));
    }
  }
  const restore = installBrowserMocks(ConnectionFailureWebSocket, async () => {
    fetchCalls += 1;
    return {
      ok: true,
      json: async () => ({ stdout: 'fallback', stderr: '', code: 0 }),
    };
  });

  try {
    const result = await executeCommand('printf fallback', '/agent', { stream: true });
    assert.equal(result.stdout, 'fallback');
    assert.equal(fetchCalls, 1);
  } finally {
    restore();
  }
});

test('executeCommand does not retry after submitting a command over WebSocket', async () => {
  let fetchCalls = 0;
  class StartedWebSocket extends MockWebSocket {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }

    send() {
      queueMicrotask(() => this.dispatchEvent(new Event('error')));
    }
  }
  const restore = installBrowserMocks(StartedWebSocket, async () => {
    fetchCalls += 1;
    throw new Error('HTTP should not be called');
  });

  try {
    await assert.rejects(
      executeCommand('touch submitted-once', '/agent', { stream: true }),
      /Agent WebSocket connection failed/
    );
    assert.equal(fetchCalls, 0);
  } finally {
    restore();
  }
});

test('managed command clients use job endpoints and preserve log cursors', async () => {
  const requests = [];
  const restore = installBrowserMocks(undefined, async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ job_id: 'job-one', status: 'running' }) };
  });

  try {
    await startCommand('python train.py', 'https://sandbox.example');
    await getCommand('job-one', 'https://sandbox.example', 17);
    await waitCommand('job-one', 'https://sandbox.example', { cursor: 23, waitMs: 12_000 });
    await stopCommand('job-one', 'https://sandbox.example');

    assert.deepEqual(requests.map((request) => [request.options.method, request.url]), [
      ['POST', 'https://sandbox.example/agent/commands'],
      ['GET', 'https://sandbox.example/agent/commands/job-one?cursor=17'],
      ['GET', 'https://sandbox.example/agent/commands/job-one?cursor=23&wait_ms=12000'],
      ['DELETE', 'https://sandbox.example/agent/commands/job-one'],
    ]);
    assert.deepEqual(JSON.parse(requests[0].options.body), { command: 'python train.py' });
  } finally {
    restore();
  }
});

test('remote run abort forwards its cancellation signal', async () => {
  let request = null;
  const restore = installBrowserMocks(undefined, async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ status: 'aborted' }) };
  });
  const controller = new AbortController();

  try {
    await abortRemoteAgentRun('https://sandbox.example', 'run one', controller.signal);
    assert.equal(request.url, 'https://sandbox.example/agent/runs/run%20one');
    assert.equal(request.options.method, 'DELETE');
    assert.equal(request.options.signal, controller.signal);
  } finally {
    restore();
  }
});

test('sandbox file requests route configured loopback hosts through the page proxy', async () => {
  let requestedUrl = null;
  const restore = installBrowserMocks(undefined, async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => [] };
  });
  window.location.href = 'https://192.168.1.20:5173/';
  window.location.origin = 'https://192.168.1.20:5173';

  try {
    await listRemoteFiles('', 'http://localhost:3099');
    assert.equal(requestedUrl, '/agent/files');
  } finally {
    restore();
  }
});

test('sandbox file requests honor an explicit session sandbox URL', async () => {
  let requestedUrl = null;
  const restore = installBrowserMocks(undefined, async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => [] };
  });

  try {
    await listFiles('src', 'https://sandbox.example');
    assert.equal(requestedUrl, 'https://sandbox.example/agent/files?path=src');
  } finally {
    restore();
  }
});
