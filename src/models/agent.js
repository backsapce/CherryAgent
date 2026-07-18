/**
 * Agent client module.
 *
 * Provides helpers to check whether agent servers are reachable,
 * authenticate via temp-token exchange, and execute commands.
 * Supports multiple agent hosts and E2B cloud sandboxes.
 */

import config from '../config/config.js';
import { initE2b, cleanupE2b, getSandboxStatus, executeInSandbox, stopSandbox, enableE2b, listE2bFiles, createE2bFile, createE2bDir, deleteE2bFile, moveE2bFile, uploadE2bFile, downloadE2bFile, readE2bFileText, writeE2bFileText } from './e2b.js';

const E2B_AGENT_ID = '__e2b__';

const DEFAULT_AGENT_PATH = '/agent';

/**
 * Normalise a host URL into a full agent endpoint.
 * - If the url already contains '/agent', use as-is.
 * - Otherwise append '/agent'.
 * @param {string} [url] - e.g. 'http://localhost:3099' or '/agent'
 * @returns {string}
 */
function resolveAgentUrl(url) {
  if (!url) return DEFAULT_AGENT_PATH;
  const u = url.replace(/\/+$/, '');
  const endpoint = u.endsWith('/agent') ? u : `${u}/agent`;
  return isLoopbackAgentUrl(endpoint) ? DEFAULT_AGENT_PATH : endpoint;
}

function resolveAgentWsUrl(url) {
  if (isLoopbackAgentUrl(url)) {
    const base = new URL('/agent/ws', window.location.href);
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    return base.toString();
  }

  const endpoint = resolveAgentUrl(url).replace(/\/agent$/, '/agent/ws');
  const base = new URL(endpoint, window.location.href);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return base.toString();
}

function isLoopbackAgentUrl(url) {
  if (!url) return true;
  try {
    const parsed = new URL(url, window.location.href);
    return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      && (parsed.port === '3099' || parsed.pathname.startsWith('/agent'));
  } catch {
    return false;
  }
}

/** Build a unique config key for a given agent URL's token. */
function tokenKey(url) {
  const base = (url || window.location.origin).replace(/[^a-zA-Z0-9]/g, '_');
  return `agentTokens.${base}`;
}

/** Get the saved long-lived token for a given agent URL. */
export function getAgentToken(url) {
  return config.get(tokenKey(url)) || null;
}

/** Save a long-lived token for a given agent URL. */
export async function saveAgentToken(url, token) {
  await config.set(tokenKey(url), token);
}

/** Clear the saved token for a given agent URL. */
export async function clearAgentToken(url) {
  await config.set(tokenKey(url), null);
}

/**
 * Check if the agent server is available (GET /agent returns 200).
 * Also returns whether the server requires authentication.
 * @param {string} [url] - agent host URL (optional, defaults to local /agent)
 * @returns {Promise<{ available: boolean, needsAuth: boolean }>}
 */
export async function checkAgentAvailable(url) {
  try {
    const endpoint = resolveAgentUrl(url);
    const headers = {};
    const token = getAgentToken(url);
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(endpoint, { method: 'GET', headers });
    if (!res.ok) return { available: false, needsAuth: false };
    const data = await res.json();
    return {
      available: data.status === 'ok',
      needsAuth: !!data.needsAuth,
    };
  } catch {
    return { available: false, needsAuth: false };
  }
}

/**
 * Exchange a temp token (shown in server console) for a long-lived token.
 * The long-lived token is automatically saved to config.
 * @param {string} tempToken - The temp token from the server console.
 * @param {string} [url] - agent host URL.
 * @returns {Promise<string>} The long-lived token.
 */
export async function connectAgent(tempToken, url) {
  const base = resolveAgentUrl(url);
  // POST to /agent/connect
  const connectUrl = base.replace(/\/agent$/, '/agent/connect');
  const res = await fetch(connectUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: tempToken }),
  });
  const data = await res.json().catch(() => ({ error: 'Invalid response' }));
  if (!res.ok) {
    throw new Error(data.error || `Connect failed (${res.status})`);
  }
  if (!data.token) {
    throw new Error('Server did not return a token.');
  }
  // Persist the long-lived token
  await saveAgentToken(url, data.token);
  return data.token;
}

/**
 * Execute a shell command via the agent server.
 * Automatically attaches the saved auth token.
 * Routes through E2B sandbox if the selected agent is E2B Cloud.
 * @param {string} cmd - The command to run.
 * @param {string} [url] - agent host URL (optional, defaults to local /agent)
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
export async function executeCommand(cmd, url, opts = {}) {
  // Route through E2B sandbox
  if (url === E2B_AGENT_ID) {
    return executeInSandbox(cmd, opts);
  }

  if (typeof WebSocket !== 'undefined' && opts.stream !== false) {
    try {
      return await executeCommandStreaming(cmd, url, opts);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      // Retrying after the command was submitted could execute a mutating
      // command twice. HTTP fallback is only safe when the socket never
      // opened (for example, when a proxy does not support WebSockets).
      if (opts.requireStreaming || err?.agentCommandStarted) throw err;
      console.warn('[agent] WebSocket command stream failed; falling back to HTTP:', err);
    }
  }

  const endpoint = resolveAgentUrl(url);
  const headers = { 'Content-Type': 'application/json' };
  const token = getAgentToken(url);
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ cmd }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Agent request failed' }));
    throw new Error(err.error || `Agent returned ${res.status}`);
  }
  return res.json();
}

function assertRemoteAgentRuntime(url) {
  if (!url || url === E2B_AGENT_ID) {
    throw new Error('Sandbox runtime requires an authenticated VertexAgent agent server. Direct E2B command sandboxes do not expose the background run API.');
  }
}

async function requestAgentRun(url, path = '', options = {}) {
  assertRemoteAgentRuntime(url);
  const endpoint = `${resolveAgentUrl(url)}/runs${path}`;
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}) };
  const token = getAgentToken(url);
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(endpoint, { ...options, headers: { ...headers, ...options.headers } });
  const data = await res.json().catch(() => ({ error: 'Invalid agent runtime response' }));
  if (!res.ok) throw new Error(data.error || `Agent runtime returned ${res.status}`);
  return data;
}

/** Start a background run that continues after the browser disconnects. */
export function startRemoteAgentRun(url, input, signal) {
  return requestAgentRun(url, '', {
    method: 'POST',
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
}

/** Read new events and the current durable result for a background run. */
export function getRemoteAgentRun(url, runId, after = 0, signal) {
  return requestAgentRun(url, `/${encodeURIComponent(runId)}?after=${Math.max(0, Number(after) || 0)}`, {
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
}

export function listRemoteAgentRuns(url, sessionId, signal) {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  return requestAgentRun(url, query, { method: 'GET', ...(signal ? { signal } : {}) });
}

export function abortRemoteAgentRun(url, runId) {
  return requestAgentRun(url, `/${encodeURIComponent(runId)}`, { method: 'DELETE' });
}

function assertManagedCommandRuntime(url) {
  if (!url || url === E2B_AGENT_ID) {
    throw new Error('Managed background commands require a connected VertexAgent agent server.');
  }
}

async function requestManagedCommand(url, path = '', options = {}) {
  assertManagedCommandRuntime(url);
  const endpoint = `${resolveAgentUrl(url)}/commands${path}`;
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}) };
  const token = getAgentToken(url);
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(endpoint, { ...options, headers: { ...headers, ...options.headers } });
  const data = await res.json().catch(() => ({ error: 'Invalid background command response' }));
  if (!res.ok) throw new Error(data.error || `Background command returned ${res.status}`);
  return data;
}

/** Start a managed command that continues independently of the browser request. */
export function startCommand(command, url, signal) {
  return requestManagedCommand(url, '', {
    method: 'POST',
    body: JSON.stringify({ command }),
    ...(signal ? { signal } : {}),
  });
}

/** Read a background command and the next bounded log segment. */
export function getCommand(jobId, url, cursor = 0, signal) {
  const query = `?cursor=${Math.max(0, Number(cursor) || 0)}`;
  return requestManagedCommand(url, `/${encodeURIComponent(jobId)}${query}`, {
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
}

/** Long-poll briefly for command output or a terminal state. */
export function waitCommand(jobId, url, { cursor = 0, waitMs = 30_000, signal } = {}) {
  const query = `?cursor=${Math.max(0, Number(cursor) || 0)}&wait_ms=${Math.min(30_000, Math.max(0, Number(waitMs) || 0))}`;
  return requestManagedCommand(url, `/${encodeURIComponent(jobId)}${query}`, {
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
}

/** Stop a managed command and its entire process tree. */
export function stopCommand(jobId, url, signal) {
  return requestManagedCommand(url, `/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
    ...(signal ? { signal } : {}),
  });
}

function executeCommandStreaming(cmd, url, opts = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(resolveAgentWsUrl(url));
    const token = getAgentToken(url);
    const result = {
      stdout: '',
      stderr: '',
      code: 1,
    };
    let started = false;
    let finished = false;

    const cleanup = () => {
      opts.signal?.removeEventListener('abort', abort);
    };

    const fail = (err) => {
      if (finished) return;
      finished = true;
      cleanup();
      try { ws.close(); } catch { /* ignore */ }
      if (err && typeof err === 'object') err.agentCommandStarted = started;
      reject(err);
    };

    const abort = () => {
      fail(new DOMException('Command execution aborted', 'AbortError'));
    };

    if (opts.signal?.aborted) {
      abort();
      return;
    }
    opts.signal?.addEventListener('abort', abort, { once: true });

    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify({ cmd, token }));
        started = true;
      } catch (err) {
        fail(err);
      }
    });

    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.type === 'start') {
        Object.assign(result, {
          platform: message.platform,
          shell: message.shell,
          cwd: message.cwd,
          filesRoot: message.filesRoot,
        });
      } else if (message.type === 'stdout') {
        result.stdout += message.data || '';
        opts.onStdout?.(message.data || '', { ...result });
      } else if (message.type === 'stderr') {
        result.stderr += message.data || '';
        opts.onStderr?.(message.data || '', { ...result });
      } else if (message.type === 'exit') {
        finished = true;
        cleanup();
        Object.assign(result, message);
        resolve(result);
      } else if (message.type === 'error') {
        const err = new Error(message.error || 'Agent WebSocket command failed');
        err.status = message.status;
        fail(err);
      }
    });

    ws.addEventListener('error', () => {
      fail(new Error('Agent WebSocket connection failed'));
    });

    ws.addEventListener('close', () => {
      if (!finished) {
        fail(new Error(started ? 'Agent WebSocket closed before command completed' : 'Agent WebSocket failed to open'));
      }
    });
  });
}

/**
 * List files from the agent server's files root.
 * Automatically attaches the saved auth token.
 * @param {string} [path] - Directory path relative to files root (empty for root).
 * @param {string} [url] - agent host URL (optional, defaults to local /agent)
 * @returns {Promise<{id: string, name: string, type: string, children: Array}|Array>}
 */
export async function listRemoteFiles(path = '', url) {
  const base = resolveAgentUrl(url);
  const filesUrl = `${base}/files${path ? `?path=${encodeURIComponent(path)}` : ''}`;
  const headers = {};
  const token = getAgentToken(url);
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(filesUrl, { method: 'GET', headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Agent request failed' }));
    throw new Error(err.error || `Agent returned ${res.status}`);
  }
  return res.json();
}

/**
 * Create a file or directory on the remote agent server.
 * @param {string} path - Path relative to files root
 * @param {string} [content] - File content (optional, empty string if not provided)
 * @param {boolean} [isDirectory] - If true, creates a directory instead of a file
 * @param {string} [url] - agent host URL (optional, defaults to local /agent)
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function createRemoteFile(path, content = '', isDirectory = false, url) {
  const base = resolveAgentUrl(url);
  const filesUrl = `${base}/files`;
  const headers = { 'Content-Type': 'application/json' };
  const token = getAgentToken(url);
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(filesUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ path, content, isDirectory }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Agent request failed' }));
    throw new Error(err.error || `Agent returned ${res.status}`);
  }
  return res.json();
}

/**
 * Delete a file or directory on the remote agent server.
 * @param {string} path - Path relative to files root
 * @param {string} [url] - agent host URL (optional, defaults to local /agent)
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function deleteRemoteFile(path, url) {
  const base = resolveAgentUrl(url);
  const filesUrl = `${base}/files?path=${encodeURIComponent(path)}`;
  const headers = {};
  const token = getAgentToken(url);
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(filesUrl, { method: 'DELETE', headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Agent request failed' }));
    throw new Error(err.error || `Agent returned ${res.status}`);
  }
  return res.json();
}

/**
 * Move a file or directory on the remote agent server.
 * @param {string} sourcePath - Source path relative to files root
 * @param {string} targetPath - Destination path relative to files root
 * @param {string} [url] - agent host URL (optional, defaults to local /agent)
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function moveRemoteFile(sourcePath, targetPath, url) {
  const base = resolveAgentUrl(url);
  const filesUrl = `${base}/files`;
  const headers = { 'Content-Type': 'application/json' };
  const token = getAgentToken(url);
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(filesUrl, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ sourcePath, targetPath }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Agent request failed' }));
    throw new Error(err.error || `Agent returned ${res.status}`);
  }
  return res.json();
}

/**
 * Upload a file to the remote agent server.
 * @param {string} path - Path relative to files root
 * @param {Blob|File} file - The file to upload
 * @param {string} [url] - agent host URL (optional, defaults to local /agent)
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function uploadRemoteFile(path, file, url) {
  const base = resolveAgentUrl(url);
  const uploadUrl = `${base}/files/upload`;
  
  // Create form data for multipart upload
  const formData = new FormData();
  formData.append('path', path);
  formData.append('file', file);

  const headers = {};
  const token = getAgentToken(url);
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers,
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Agent request failed' }));
    throw new Error(err.error || `Agent returned ${res.status}`);
  }
  return res.json();
}

/**
 * Download a file from the remote agent server.
 * @param {string} path - Path relative to files root
 * @param {string} [url] - agent host URL (optional, defaults to local /agent)
 * @returns {Promise<Blob>}
 */
export async function downloadRemoteFile(path, url) {
  const base = resolveAgentUrl(url);
  const downloadUrl = `${base}/files/download?path=${encodeURIComponent(path)}`;
  const headers = {};
  const token = getAgentToken(url);
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(downloadUrl, { method: 'GET', headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Agent request failed' }));
    throw new Error(err.error || `Agent returned ${res.status}`);
  }
  return res.blob();
}

/**
 * Get the currently selected agent URL from config.
 * @returns {string|null}
 */
function getSelectedAgent() {
  return config.get('selectedAgent') || null;
}

/**
 * List files from the active agent (E2B or HTTP server).
 * @param {string} [path] - Directory path relative to files root (empty for root).
 * @returns {Promise<{id: string, name: string, type: string, children: Array}|Array>}
 */
export async function listFiles(path = '', url = getSelectedAgent()) {
  const selected = url;
  if (selected === E2B_AGENT_ID) {
    return listE2bFiles(path);
  }
  return listRemoteFiles(path, selected);
}

/**
 * Create a file or directory on the active agent.
 * @param {string} path - Path relative to files root
 * @param {string} [content] - File content
 * @param {boolean} [isDirectory] - If true, creates a directory
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function createFile(path, content = '', isDirectory = false, url = getSelectedAgent()) {
  const selected = url;
  if (selected === E2B_AGENT_ID) {
    return isDirectory ? createE2bDir(path) : createE2bFile(path, content);
  }
  return createRemoteFile(path, content, isDirectory, selected);
}

/**
 * Delete a file or directory on the active agent.
 * @param {string} path - Path relative to files root
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function deleteFile(path, url = getSelectedAgent()) {
  const selected = url;
  if (selected === E2B_AGENT_ID) {
    return deleteE2bFile(path);
  }
  return deleteRemoteFile(path, selected);
}

/**
 * Move a file or directory on the active agent.
 * @param {string} sourcePath - Source path relative to files root
 * @param {string} targetPath - Destination path relative to files root
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function moveFile(sourcePath, targetPath, url = getSelectedAgent()) {
  const selected = url;
  if (selected === E2B_AGENT_ID) {
    return moveE2bFile(sourcePath, targetPath);
  }
  return moveRemoteFile(sourcePath, targetPath, selected);
}

/**
 * Upload a file to the active agent.
 * @param {string} path - Path relative to files root
 * @param {Blob|File} file - The file to upload
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function uploadFile(path, file, url = getSelectedAgent()) {
  const selected = url;
  if (selected === E2B_AGENT_ID) {
    return uploadE2bFile(path, file);
  }
  return uploadRemoteFile(path, file, selected);
}

/**
 * Download a file from the active agent.
 * @param {string} path - Path relative to files root
 * @returns {Promise<Blob>}
 */
export async function downloadFile(path, url = getSelectedAgent()) {
  const selected = url;
  if (selected === E2B_AGENT_ID) {
    return downloadE2bFile(path);
  }
  return downloadRemoteFile(path, selected);
}

/**
 * Read file content as text from the active agent.
 * @param {string} path - Path relative to files root
 * @returns {Promise<string>}
 */
export async function readFileText(path, url = getSelectedAgent()) {
  const selected = url;
  if (selected === E2B_AGENT_ID) {
    return readE2bFileText(path);
  }
  // For HTTP server, download as blob and convert to text
  const blob = await downloadRemoteFile(path, selected);
  return blob.text();
}

/**
 * Write file content to the active agent.
 * @param {string} path - Path relative to files root
 * @param {string} content - File content
 * @returns {Promise<void>}
 */
export async function writeFile(path, content, url = getSelectedAgent()) {
  const selected = url;
  if (selected === E2B_AGENT_ID) {
    return writeE2bFileText(path, content);
  }
  // For HTTP server, use createRemoteFile (overwrite)
  await createRemoteFile(path, content, false, selected);
}

// ─── Agent initialization ───────────────────────────────────────────────────

/**
 * Initialize agents: detect local agent, check saved agents connectivity,
 * and determine which agent should be auto-selected.
 * @returns {Promise<{ agents: Array, selectedUrl: string|null }>}
 */
export async function initAgents() {
  // Wait until config is initialized
  while (!config.initialized) await new Promise((r) => setTimeout(r, 50));

  const savedAgents = config.get('agents') || [];
  const dismissed = config.get('dismissedAgents') || [];
  const localUrl = window.location.origin;
  const localCheck = await checkAgentAvailable();
  const detected = [];

  // Auto-detect local agent
  const hasLocal = savedAgents.some((a) => a.url === localUrl);
  const wasDismissed = dismissed.includes(localUrl);
  if (localCheck.available && !hasLocal && !wasDismissed) {
    const status = localCheck.needsAuth ? 'needsAuth' : 'connected';
    detected.push({ url: localUrl, name: 'Local Agent', status });
  }

  // Check saved agents connectivity
  const checked = await Promise.all(
    savedAgents.map(async (a) => {
      const info = await checkAgentAvailable(a.url);
      let status = 'disconnected';
      if (info.available && !info.needsAuth) status = 'connected';
      else if (info.available && info.needsAuth) status = 'needsAuth';
      return { ...a, status };
    })
  );

  // Update local agent status if it was already saved
  if (localCheck.available && hasLocal) {
    for (const a of checked) {
      if (a.url === localUrl) a.status = localCheck.needsAuth ? 'needsAuth' : 'connected';
    }
  }

  // Add E2B cloud agent only if API key is configured
  const e2bKey = config.get('e2b.apiKey');
  let e2bAgent = null;
  if (e2bKey) {
    const e2bSandboxInfo = getSandboxStatus();
    e2bAgent = { url: E2B_AGENT_ID, name: 'E2B Cloud', status: 'disconnected', isE2b: true, sandboxId: e2bSandboxInfo.sandboxId };
    try {
      const { connected } = await initE2b();
      const info = getSandboxStatus();
      e2bAgent.status = connected ? 'connected' : 'error';
      e2bAgent.sandboxId = info.sandboxId;
    } catch {
      e2bAgent.status = 'error';
    }
  }

  const allAgents = [...detected, ...checked, ...(e2bAgent ? [e2bAgent] : [])];

  // Persist newly detected agents
  if (detected.length > 0) {
    await config.set('agents', allAgents.filter((a) => !a.isE2b).map(({ url, name }) => ({ url, name })));
  }

  // Restore a saved selection for remote file operations. Sessions opt in per agent.
  const savedSelected = config.get('selectedAgent');
  const connected = allAgents.filter((a) => a.status === 'connected');
  const selectedUrl = (savedSelected && connected.some((a) => a.url === savedSelected))
    ? savedSelected
    : null;

  return { agents: allAgents, selectedUrl };
}

// Re-export E2B functions for use in App.jsx and Settings
export { cleanupE2b, getSandboxStatus, stopSandbox as stopE2bSandbox, enableE2b };
export { E2B_AGENT_ID };
export { listE2bFiles, createE2bFile, createE2bDir, deleteE2bFile, uploadE2bFile, downloadE2bFile, readE2bFileText, writeE2bFileText };
