import assert from 'node:assert/strict';
import test from 'node:test';
import { executeCommand, listFiles, listRemoteFiles } from './agent.js';

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
