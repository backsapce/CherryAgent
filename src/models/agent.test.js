import assert from 'node:assert/strict';
import test from 'node:test';
import {
  abortRemoteAgentRun,
  assertRemoteAgentRunProtocol,
  checkAgentAvailable,
  downloadRemoteFile,
  executeCommand,
  getCommand,
  getRemoteAgentRun,
  listFiles,
  listRemoteFiles,
  readFileText,
  startRemoteAgentRun,
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
  const restore = installBrowserMocks(undefined, (url, options) => {
    request = { url, options };
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  });
  const controller = new AbortController();

  try {
    const pending = abortRemoteAgentRun('https://sandbox.example', 'run one', controller.signal);
    await Promise.resolve();
    controller.abort();
    await assert.rejects(pending, (error) => error?.name === 'AbortError');
    assert.equal(request.url, 'https://sandbox.example/agent/runs/run%20one');
    assert.equal(request.options.method, 'DELETE');
    assert.equal(request.options.signal.aborted, true);
  } finally {
    restore();
  }
});

test('remote run polling bypasses caches', async () => {
  let request = null;
  const restore = installBrowserMocks(undefined, async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'run-one', status: 'waiting', sequence: 34 }),
    };
  });

  try {
    const result = await getRemoteAgentRun('https://sandbox.example', 'run-one', 34);
    assert.equal(result.status, 'waiting');
    assert.equal(request.url, 'https://sandbox.example/agent/runs/run-one?after=34');
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.cache, 'no-store');
  } finally {
    restore();
  }
});

test('remote run polling retries an empty 304 with a cache-busting URL', async () => {
  const requests = [];
  const restore = installBrowserMocks(undefined, async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) {
      return {
        ok: false,
        status: 304,
        json: async () => { throw new Error('304 has no body'); },
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'run-one', status: 'completed', sequence: 52 }),
    };
  });

  try {
    const result = await getRemoteAgentRun('https://sandbox.example', 'run-one', 34);
    assert.equal(result.status, 'completed');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://sandbox.example/agent/runs/run-one?after=34');
    assert.match(requests[1].url, /^https:\/\/sandbox\.example\/agent\/runs\/run-one\?after=34&_=[0-9]+$/);
    assert.equal(requests[1].options.cache, 'no-store');
  } finally {
    restore();
  }
});

test('sandbox runs reject an outdated agent run protocol before starting', async () => {
  const requests = [];
  const restore = installBrowserMocks(undefined, async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        status: 'ok',
        capabilities: { backgroundAgentRuns: true, agentRunProtocol: 2 },
      }),
    };
  });

  try {
    await assert.rejects(
      startRemoteAgentRun('https://sandbox.example', { sessionId: 'one' }),
      (error) => {
        assert.match(error.message, /runtime is outdated.*protocol 2.*3 required/i);
        assert.equal(error.code, 'AGENT_RUN_PROTOCOL_OUTDATED');
        return true;
      }
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://sandbox.example/agent');
    assert.equal(requests[0].options.method, 'GET');
    assert.equal(requests[0].options.cache, 'no-store');
  } finally {
    restore();
  }
});

test('sandbox runtime health errors preserve their HTTP status for retry policy', async () => {
  const restore = installBrowserMocks(undefined, async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: 'Forbidden' }),
  }));

  try {
    await assert.rejects(
      assertRemoteAgentRunProtocol('https://sandbox.example'),
      (error) => error.message === 'Forbidden' && error.status === 403
    );
  } finally {
    restore();
  }
});

test('sandbox run reattachment also rejects an outdated runtime protocol', async () => {
  const restore = installBrowserMocks(undefined, async () => ({
    ok: true,
    json: async () => ({ capabilities: { agentRunProtocol: 2 } }),
  }));

  try {
    await assert.rejects(
      assertRemoteAgentRunProtocol('https://sandbox.example'),
      /runtime is outdated.*protocol 2.*3 required/i
    );
  } finally {
    restore();
  }
});

test('sandbox runs start after confirming the current agent run protocol', async () => {
  const requests = [];
  const restore = installBrowserMocks(undefined, async (url, options) => {
    requests.push({ url, options });
    if (options.method === 'GET') {
      return {
        ok: true,
        json: async () => ({
          status: 'ok',
          capabilities: { backgroundAgentRuns: true, agentRunProtocol: 3 },
        }),
      };
    }
    return { ok: true, json: async () => ({ id: 'run-one', status: 'running' }) };
  });

  try {
    const result = await startRemoteAgentRun('https://sandbox.example', { sessionId: 'one' });
    assert.equal(result.id, 'run-one');
    assert.deepEqual(requests.map((request) => [request.options.method, request.url]), [
      ['GET', 'https://sandbox.example/agent'],
      ['POST', 'https://sandbox.example/agent/runs'],
    ]);
  } finally {
    restore();
  }
});

test('sandbox run start errors distinguish preflight failure from an attempted POST', async () => {
  const preflightRequests = [];
  let restore = installBrowserMocks(undefined, async (url, options) => {
    preflightRequests.push({ url, options });
    throw new Error('health check offline');
  });

  try {
    await assert.rejects(
      startRemoteAgentRun('https://sandbox.example', { sessionId: 'one' }),
      (error) => {
        assert.match(error.message, /health check offline/);
        assert.notEqual(error.agentRunRequestStarted, true);
        return true;
      }
    );
    assert.equal(preflightRequests.length, 1);
  } finally {
    restore();
  }

  const postRequests = [];
  restore = installBrowserMocks(undefined, async (url, options) => {
    postRequests.push({ url, options });
    if (options.method === 'GET') {
      return {
        ok: true,
        json: async () => ({ capabilities: { agentRunProtocol: 3 } }),
      };
    }
    throw new Error('POST response lost');
  });

  try {
    await assert.rejects(
      startRemoteAgentRun('https://sandbox.example', { sessionId: 'one' }),
      (error) => {
        assert.match(error.message, /POST response lost/);
        assert.equal(error.agentRunRequestStarted, true);
        return true;
      }
    );
    assert.deepEqual(postRequests.map((request) => request.options.method), ['GET', 'POST']);
  } finally {
    restore();
  }
});

test('sandbox run network failures include runtime connectivity diagnostics', async () => {
  const requests = [];
  const restore = installBrowserMocks(undefined, async (url, options) => {
    requests.push({ url, options });
    if (options.method === 'GET') {
      return {
        ok: true,
        json: async () => ({ capabilities: { agentRunProtocol: 3 } }),
      };
    }
    throw new TypeError('Failed to fetch');
  });

  try {
    await assert.rejects(
      startRemoteAgentRun('https://sandbox.example', { sessionId: 'one' }),
      (error) => {
        assert.equal(error.name, 'AgentRuntimeNetworkError');
        assert.equal(error.code, 'AGENT_RUNTIME_NETWORK_ERROR');
        assert.equal(error.agentRunRequestStarted, true);
        assert.match(error.message, /cherry-sandbox is running/i);
        assert.match(error.message, /AGENT_ALLOWED_ORIGINS/);
        assert.match(error.message, /Local Network Access/);
        return true;
      }
    );
    assert.deepEqual(requests.map((request) => request.options.method), ['GET', 'POST']);
  } finally {
    restore();
  }
});

test('agent health checks settle on a deadline when fetch ignores abort', { timeout: 1_000 }, async () => {
  const restore = installBrowserMocks(undefined, () => new Promise(() => {}));

  try {
    const result = await checkAgentAvailable('https://sandbox.example', { timeoutMs: 20 });
    assert.deepEqual(result, { available: false, needsAuth: false });
  } finally {
    restore();
  }
});

test('remote run POST and GET settle on a deadline when fetch never returns', { timeout: 1_000 }, async () => {
  const restore = installBrowserMocks(undefined, (url, options) => {
    if (url === 'https://sandbox.example/agent' && options.method === 'GET') {
      return Promise.resolve({
        ok: true,
        json: async () => ({ capabilities: { agentRunProtocol: 3 } }),
      });
    }
    return new Promise(() => {});
  });

  try {
    await assertRequestTimeout(startRemoteAgentRun(
      'https://sandbox.example',
      { sessionId: 'one' },
      { timeoutMs: 20 }
    ));
    await assertRequestTimeout(getRemoteAgentRun(
      'https://sandbox.example',
      'run-one',
      0,
      { timeoutMs: 20 }
    ));
  } finally {
    restore();
  }
});

test('sandbox file list, download, and text reads have abort-independent deadlines', { timeout: 1_000 }, async () => {
  const restore = installBrowserMocks(undefined, () => new Promise(() => {}));

  try {
    await assertRequestTimeout(listRemoteFiles('skills', 'https://sandbox.example', { timeoutMs: 20 }));
    await assertRequestTimeout(downloadRemoteFile('skills/one/SKILL.md', 'https://sandbox.example', { timeoutMs: 20 }));
    await assertRequestTimeout(readFileText('skills/one/SKILL.md', 'https://sandbox.example', { timeoutMs: 20 }));
  } finally {
    restore();
  }
});

test('sandbox file list, download, and text reads honor caller cancellation', { timeout: 1_000 }, async () => {
  let requestSignal = null;
  const restore = installBrowserMocks(undefined, (_url, options) => {
    requestSignal = options.signal;
    return new Promise(() => {});
  });
  const operations = [
    (signal) => listFiles('skills', 'https://sandbox.example', { signal, timeoutMs: 500 }),
    (signal) => downloadRemoteFile('skills/one/SKILL.md', 'https://sandbox.example', { signal, timeoutMs: 500 }),
    (signal) => readFileText('skills/one/SKILL.md', 'https://sandbox.example', { signal, timeoutMs: 500 }),
  ];

  try {
    for (const operation of operations) {
      const controller = new AbortController();
      const pending = operation(controller.signal);
      await Promise.resolve();
      controller.abort();
      await assert.rejects(pending, (error) => error?.name === 'AbortError');
      assert.equal(requestSignal?.aborted, true);
    }
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

test('sandbox requests preserve an explicit non-default localhost port', async () => {
  let requestedUrl = null;
  const restore = installBrowserMocks(undefined, async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => [] };
  });

  try {
    await listRemoteFiles('', 'http://localhost:3100/agent');
    assert.equal(requestedUrl, 'http://localhost:3100/agent/files');
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

test('recursive sandbox file requests use one recursive endpoint call', async () => {
  let requestedUrl = null;
  const restore = installBrowserMocks(undefined, async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ recursive: true, children: [] }) };
  });

  try {
    await listFiles('', 'https://sandbox.example', { recursive: true });
    assert.equal(requestedUrl, 'https://sandbox.example/agent/files?recursive=true');
  } finally {
    restore();
  }
});

test('sandbox file requests can explicitly include hidden entries', async () => {
  let requestedUrl = null;
  const restore = installBrowserMocks(undefined, async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ children: [] }) };
  });

  try {
    await listFiles('', 'https://sandbox.example', { includeHidden: true });
    assert.equal(requestedUrl, 'https://sandbox.example/agent/files?includeHidden=true');
  } finally {
    restore();
  }
});

async function assertRequestTimeout(promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.name, 'TimeoutError');
    assert.equal(error?.code, 'AGENT_REQUEST_TIMEOUT');
    assert.equal(error?.timeoutMs, 20);
    return true;
  });
}
