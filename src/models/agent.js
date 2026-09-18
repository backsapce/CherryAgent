/**
 * Agent client module.
 *
 * The browser↔agent-server API surface: availability probing, temp-token
 * authentication, command execution, managed jobs, file transfers, web
 * proxies, and durable sandbox runs — all multiplexed over the shared
 * WebSocket connection managed by agentConnection.js. E2B cloud sandboxes
 * bypass this transport entirely.
 */

import config from '../config/config.js';
import { assertSecureAgentUrl, getAgentConnection } from './agentConnection.js';
import { initE2b, getSandboxStatus, executeInSandbox, stopSandbox, enableE2b, listE2bFiles, createE2bFile, createE2bDir, deleteE2bFile, moveE2bFile, uploadE2bFile, downloadE2bFile, readE2bFileText, writeE2bFileText } from './e2b.js';

export { assertSecureAgentUrl };

const E2B_AGENT_ID = '__e2b__';
// Protocol 4 moves run traffic onto the multiplexed WebSocket protocol
// (subscribe pushes, incremental continue) and coalesces streaming deltas.
// Older runtimes can accept a run and then leave the browser polling an
// endpoint that no longer exists.
const REQUIRED_AGENT_RUN_PROTOCOL = 4;

const AGENT_RUN_REQUEST_TIMEOUT_MS = 15_000;
const AGENT_RUN_POST_MAX_TIMEOUT_MS = 150_000;
const AGENT_RUN_POST_GRACE_BYTES = 1024 * 1024;
const AGENT_RUN_POST_BYTES_PER_SECOND = 1024 * 1024;
// Binary-stream deadlines: the control reply is bounded by the normal request
// timeout, the byte transfer itself by these generous ceilings.
const UPLOAD_END_TIMEOUT_MS = 120_000;
const DOWNLOAD_STREAM_TIMEOUT_MS = 5 * 60_000;
// Upper bound for a single wait_command bounded wait; matches the 7-day maximum
// of schedule_wakeup so any wait the model may declare can be served in one call.
const MAX_COMMAND_WAIT_MS = 7 * 24 * 60 * 60_000;

let streamSequence = 0;
/** Monotonic binary-stream ids shared by uploads and downloads. */
function nextStreamId() {
  streamSequence = (streamSequence + 1) % 0x7fffffff;
  return streamSequence + 1;
}

function timeoutError(message) {
  const error = new Error(message);
  error.name = 'TimeoutError';
  error.code = 'AGENT_REQUEST_TIMEOUT';
  return error;
}

/** Shared multiplexed WebSocket connection for an agent URL. */
function connFor(url) {
  return getAgentConnection(url, { getToken: () => getAgentToken(url) });
}

function isAbortSignal(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function'
  );
}

function requestControls(value, defaultTimeoutMs) {
  if (isAbortSignal(value)) {
    return { signal: value, timeoutMs: defaultTimeoutMs };
  }
  const requestedTimeout = Number(value?.timeoutMs);
  return {
    signal: isAbortSignal(value?.signal) ? value.signal : null,
    timeoutMs: Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.floor(requestedTimeout)
      : defaultTimeoutMs,
  };
}

function hasExplicitRequestTimeout(value) {
  if (isAbortSignal(value)) return false;
  const timeoutMs = Number(value?.timeoutMs);
  return Number.isFinite(timeoutMs) && timeoutMs > 0;
}

function agentRunPostTimeoutMs(bodyBytes) {
  const uploadBytes = Math.max(0, Number(bodyBytes) - AGENT_RUN_POST_GRACE_BYTES);
  const uploadSeconds = Math.ceil(uploadBytes / AGENT_RUN_POST_BYTES_PER_SECOND);
  return Math.min(
    AGENT_RUN_POST_MAX_TIMEOUT_MS,
    AGENT_RUN_REQUEST_TIMEOUT_MS + uploadSeconds * 1000
  );
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

/**
 * Check if the agent server is available by opening (or reusing) the shared
 * WebSocket connection and reading the hello/welcome exchange.
 * @param {string} [url] - agent host URL (optional, defaults to local /agent)
 * @param {{signal?: AbortSignal, timeoutMs?: number}|AbortSignal} [options]
 * @returns {Promise<{ available: boolean, needsAuth: boolean }>}
 */
export async function checkAgentAvailable(url) {
  try {
    const welcome = await connFor(url).ready();
    return { available: true, needsAuth: !!welcome.needsAuth };
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
  const conn = connFor(url);
  await conn.ready();
  const data = await conn.request('connect', { token: tempToken });
  if (!data?.token) {
    throw new Error('Server did not return a token.');
  }
  // Persist the long-lived token
  await saveAgentToken(url, data.token);
  return data.token;
}

/**
 * Execute a shell command via the agent server over the shared WebSocket
 * connection. Output streams through push messages so onStdout/onStderr fire
 * live; resolves with the accumulated executor result on exit.
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

  const conn = connFor(url);
  const signal = opts.signal;
  const result = {
    stdout: '',
    stderr: '',
    code: 1,
  };

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      finish(reject, signal.reason instanceof Error ? signal.reason : new DOMException('Command execution aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const subscription = conn.subscribe({
      request: 'exec.start',
      payload: { cmd },
      signal,
      onData: (type, data) => {
        if (type === 'exec.start') {
          Object.assign(result, data);
        } else if (type === 'exec.data') {
          if (data.stream === 'stdout') {
            result.stdout += data.data || '';
            opts.onStdout?.(data.data || '', { ...result });
          } else if (data.stream === 'stderr') {
            result.stderr += data.data || '';
            opts.onStderr?.(data.data || '', { ...result });
          }
        } else if (type === 'exec.exit') {
          Object.assign(result, data);
          finish(resolve);
        } else if (type === 'exec.error') {
          finish(reject, new Error(data.error || 'Agent command failed'));
        }
      },
      onError: (error) => finish(reject, error),
    });
    subscription.ready.catch((error) => finish(reject, error));
  });
  return result;
}

function assertRemoteAgentRuntime(url) {
  if (!url || url === E2B_AGENT_ID) {
    throw new Error('Sandbox runtime requires an authenticated CherryAgent agent server. Direct E2B command sandboxes do not expose the background run API.');
  }
}

/**
 * Run a web search on the agent server. Used as a fallback when the search
 * provider cannot be reached directly from the browser (for example a
 * SearXNG instance without CORS headers). The request carries the search
 * provider credential, so it rides the same authenticated channel as
 * sandbox-run model configs.
 */
export async function proxyWebSearch(url, searchConfig, request, options = {}) {
  assertRemoteAgentRuntime(url);
  return connFor(url).request('web.search', { config: searchConfig, request }, options);
}

/**
 * Fetch a web page through the agent server, bypassing browser CORS limits.
 * Returns the page envelope (url, status, contentType, text, truncated).
 */
export async function proxyWebFetch(url, targetUrl, options = {}) {
  assertRemoteAgentRuntime(url);
  return connFor(url).request('web.fetch', {
    url: targetUrl,
    ...(options.maxChars != null ? { max_chars: options.maxChars } : {}),
  }, options);
}

function protocolOutdatedError(protocol) {
  const error = new Error(
    `Sandbox runtime is outdated (agent run protocol ${protocol || 'missing'}; ${REQUIRED_AGENT_RUN_PROTOCOL} required). Reinstall and restart cherry-sandbox.`
  );
  error.code = 'AGENT_RUN_PROTOCOL_OUTDATED';
  return error;
}

/**
 * Verify the shared connection's runtime capabilities before starting or
 * reattaching to a durable run. The welcome exchange doubles as the health
 * probe, so an unreachable or legacy server surfaces with reconnect guidance.
 */
export async function assertRemoteAgentRunProtocol(url) {
  assertRemoteAgentRuntime(url);
  let welcome;
  try {
    welcome = await connFor(url).ready();
  } catch (error) {
    if (error?.code === 'AGENT_INSECURE_URL') throw error;
    const wrapped = new Error(
      `Agent runtime health check could not reach ${url || 'the configured sandbox'} (${error?.message || error}). Check that cherry-sandbox is running, the URL uses compatible HTTPS, AGENT_ALLOWED_ORIGINS permits this page, and the browser granted Local Network Access.`
    );
    wrapped.name = 'AgentRuntimeNetworkError';
    wrapped.code = 'AGENT_RUNTIME_NETWORK_ERROR';
    wrapped.cause = error;
    throw wrapped;
  }
  const protocol = Number(welcome?.capabilities?.agentRunProtocol) || 0;
  if (protocol < REQUIRED_AGENT_RUN_PROTOCOL) throw protocolOutdatedError(protocol);
  return welcome;
}

/** Start a background run that continues after the browser disconnects. */
export async function startRemoteAgentRun(url, input, signalOrOptions) {
  assertRemoteAgentRuntime(url);
  const controls = requestControls(signalOrOptions, AGENT_RUN_REQUEST_TIMEOUT_MS);
  await assertRemoteAgentRunProtocol(url);
  const bodyBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  const timeoutMs = hasExplicitRequestTimeout(signalOrOptions)
    ? controls.timeoutMs
    : agentRunPostTimeoutMs(bodyBytes);
  try {
    return await connFor(url).request('run.start', input, { signal: controls.signal, timeoutMs });
  } catch (error) {
    // A definitive 4xx reply proves the server processed and rejected the
    // request, so no run was created and the recovery probe would only mask
    // the real error (surfacing as a misleading "Agent run not found").
    // Ambiguous failures (timeout, connection loss, 5xx) may have committed.
    const status = Number(error?.status);
    const definitiveRejection = Number.isFinite(status) && status >= 400 && status < 500;
    if (!definitiveRejection) {
      try {
        error.agentRunRequestStarted = true;
      } catch {
        // A frozen platform error is still safe to surface; omitting the marker
        // only disables provisional recovery for that request.
      }
    }
    throw error;
  }
}

/**
 * Continue an idle run with one new user message instead of re-uploading the
 * conversation. Rejects with HISTORY_DIVERGED when the server's copy no
 * longer matches; callers fall back to a full startRemoteAgentRun.
 */
export function continueRemoteAgentRun(url, payload, options = {}) {
  assertRemoteAgentRuntime(url);
  return connFor(url).request('run.continue', payload, options);
}

/** Read new events and the current durable result for a background run. */
export function getRemoteAgentRun(url, runId, after = 0, signalOrOptions) {
  const controls = requestControls(signalOrOptions, AGENT_RUN_REQUEST_TIMEOUT_MS);
  return connFor(url).request('run.state', {
    runId,
    after: Math.max(0, Number(after) || 0),
  }, { signal: controls.signal, timeoutMs: controls.timeoutMs });
}

export function listRemoteAgentRuns(url, sessionId, signalOrOptions) {
  const controls = requestControls(signalOrOptions, AGENT_RUN_REQUEST_TIMEOUT_MS);
  return connFor(url).request('run.list', { sessionId: sessionId || null }, {
    signal: controls.signal,
    timeoutMs: controls.timeoutMs,
  });
}

export function abortRemoteAgentRun(url, runId, signalOrOptions) {
  const controls = requestControls(signalOrOptions, AGENT_RUN_REQUEST_TIMEOUT_MS);
  return connFor(url).request('run.cancel', { runId }, {
    signal: controls.signal,
    timeoutMs: controls.timeoutMs,
  });
}

/**
 * Subscribe to a durable run's live event stream: replays everything past
 * `after`, then pushes new event batches and status snapshots until the
 * subscription is dropped or the connection closes.
 */
export function subscribeRemoteAgentRun(url, { runId, after = 0, onEvents, onStatus, onError, signal }) {
  return connFor(url).subscribe({
    request: 'run.subscribe',
    payload: { runId, after: Math.max(0, Number(after) || 0) },
    signal,
    onData: (type, data) => {
      if (type === 'run.events') onEvents?.(data?.events || []);
      else if (type === 'run.status') onStatus?.(data);
    },
    onError,
  });
}

function assertManagedCommandRuntime(url) {
  if (!url || url === E2B_AGENT_ID) {
    throw new Error('Managed background commands require a connected CherryAgent agent server.');
  }
}

/** Start a managed command that continues independently of the browser. */
export function startCommand(command, url, signal) {
  assertManagedCommandRuntime(url);
  return connFor(url).request('job.start', { command }, { signal });
}

/** Read a background command and one incremental log segment. */
export function getCommand(jobId, url, cursor = 0, signal) {
  assertManagedCommandRuntime(url);
  return connFor(url).request('job.get', { job_id: jobId, cursor: Math.max(0, Number(cursor) || 0) }, { signal });
}

/**
 * Wait for a background command: subscribes to job pushes and resolves with
 * the newest snapshot once the job reaches a terminal state without pending
 * logs, or when waitMs elapses (mirroring the old long-poll contract).
 */
export async function waitCommand(jobId, url, { cursor = 0, waitMs = 30_000, signal } = {}) {
  assertManagedCommandRuntime(url);
  const boundedWaitMs = Math.min(MAX_COMMAND_WAIT_MS, Math.max(0, Number(waitMs) || 0));
  const conn = connFor(url);
  if (boundedWaitMs === 0) {
    return conn.request('job.get', { job_id: jobId, cursor }, { signal });
  }

  let latest = null;
  let failure = null;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const subscription = conn.subscribe({
    request: 'job.subscribe',
    payload: { job_id: jobId, cursor: Math.max(0, Number(cursor) || 0) },
    signal,
    onData: (type, data) => {
      if (type === 'job.update') {
        latest = data;
        if (['completed', 'failed', 'stopped', 'interrupted'].includes(data.status) && !data.hasMore) {
          resolveDone();
        }
      } else if (type === 'job.error') {
        failure = new Error(data.error || 'Job wait failed');
        resolveDone();
      }
    },
    onError: (error) => {
      failure = error;
      resolveDone();
    },
  });

  let timeoutId = null;
  const abortWait = signal
    ? new Promise((_, reject) => {
      signal.addEventListener('abort', () => {
        reject(signal.reason instanceof Error ? signal.reason : new DOMException('Job wait aborted', 'AbortError'));
      }, { once: true });
    })
    : null;
  const waitBudget = new Promise((resolve) => { timeoutId = setTimeout(resolve, boundedWaitMs); });
  const racers = [subscription.ready.then(() => done), waitBudget];
  if (abortWait) racers.push(abortWait);
  try {
    await Promise.race(racers);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    subscription.unsubscribe();
  }
  if (!latest && failure) throw failure;
  return latest;
}

/** Stop a managed command and its entire process tree. */
export function stopCommand(jobId, url, signal) {
  assertManagedCommandRuntime(url);
  return connFor(url).request('job.stop', { job_id: jobId }, { signal });
}

/**
 * List files from the agent server's files root over the shared connection.
 * @param {string} [path] - Directory path relative to files root (empty for root).
 * @param {string} [url] - agent host URL (optional, defaults to local /agent)
 * @param {{recursive?: boolean, includeHidden?: boolean, signal?: AbortSignal, timeoutMs?: number}} [options] - Listing options
 * @returns {Promise<{id: string, name: string, type: string, children: Array}|Array>}
 */
export async function listRemoteFiles(path = '', url, options = {}) {
  return connFor(url).request('file.list', {
    path: path || '',
    recursive: options.recursive === true,
    includeHidden: options.includeHidden === true,
  }, options);
}

/**
 * Create a file or directory on the remote agent server.
 * @param {string} path - Path relative to files root
 * @param {string} [content] - File content (optional, empty string if not provided)
 * @param {boolean} [isDirectory] - If true, creates a directory instead of a file
 * @param {string} [url] - agent host URL (optional, defaults to local /agent)
 * @returns {Promise<{success: boolean, message: string}>}
 */
export function createRemoteFile(path, content = '', isDirectory = false, url) {
  return connFor(url).request('file.create', { path, content, isDirectory });
}

/**
 * Delete a file or directory on the remote agent server.
 * @param {string} path - Path relative to files root
 * @param {string} [url] - agent host URL (optional, defaults to local /agent)
 * @returns {Promise<{success: boolean, message: string}>}
 */
export function deleteRemoteFile(path, url) {
  return connFor(url).request('file.delete', { path });
}

/**
 * Move a file or directory on the remote agent server.
 * @param {string} sourcePath - Source path relative to files root
 * @param {string} targetPath - Destination path relative to files root
 * @param {string} [url] - agent host URL (optional, defaults to local /agent)
 * @returns {Promise<{success: boolean, message: string}>}
 */
export function moveRemoteFile(sourcePath, targetPath, url) {
  return connFor(url).request('file.move', { sourcePath, targetPath });
}

/**
 * Upload a file to the remote agent server as a chunked binary stream.
 * @param {string} path - Path relative to files root
 * @param {Blob|File} file - The file to upload
 * @param {string} [url] - agent host URL (optional, defaults to local /agent)
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function uploadRemoteFile(path, file, url) {
  const conn = connFor(url);
  const streamId = nextStreamId();
  await conn.request('file.upload.begin', { streamId, path, size: file.size });
  await conn.sendStream(streamId, file);
  return conn.request('file.upload.end', { streamId }, { timeoutMs: UPLOAD_END_TIMEOUT_MS });
}

/**
 * Download a file from the remote agent server as a chunked binary stream
 * reassembled into a Blob.
 * @param {string} path - Path relative to files root
 * @param {string} [url] - agent host URL (optional, defaults to local /agent)
 * @param {{signal?: AbortSignal, timeoutMs?: number}|AbortSignal} [options]
 * @returns {Promise<Blob>}
 */
export async function downloadRemoteFile(path, url, options = {}) {
  const conn = connFor(url);
  const streamId = nextStreamId();
  const received = conn.receiveStream(streamId);
  // Callers can abandon a download (catalog deadlines, aborts) before the
  // stream settles; keep a no-op consumer so a late rejection never becomes
  // an unhandled rejection while the real race still sees the original.
  received.catch(() => {});
  let streamTimer = null;
  try {
    await conn.request('file.download', { path, streamId }, options);
    const chunks = await Promise.race([
      received,
      new Promise((_, reject) => {
        streamTimer = setTimeout(() => {
          reject(timeoutError(`Agent file download timed out: ${path}`));
        }, DOWNLOAD_STREAM_TIMEOUT_MS);
      }),
    ]);
    return new Blob(chunks, { type: 'application/octet-stream' });
  } catch (error) {
    conn.cancelStream(streamId, `Download failed: ${path}`);
    throw error;
  } finally {
    if (streamTimer) clearTimeout(streamTimer);
  }
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
 * @param {string} [url] - Agent host URL or E2B identifier
 * @param {{recursive?: boolean, includeHidden?: boolean, signal?: AbortSignal, timeoutMs?: number}} [options] - Listing options
 * @returns {Promise<{id: string, name: string, type: string, children: Array}|Array>}
 */
export async function listFiles(path = '', url = getSelectedAgent(), options = {}) {
  const selected = url;
  if (selected === E2B_AGENT_ID) {
    return listE2bFiles(path, options);
  }
  return listRemoteFiles(path, selected, options);
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
 * @param {string} [url] - Agent host URL or E2B identifier
 * @param {{signal?: AbortSignal, timeoutMs?: number}|AbortSignal} [options]
 * @returns {Promise<Blob>}
 */
export async function downloadFile(path, url = getSelectedAgent(), options = {}) {
  const selected = url;
  if (selected === E2B_AGENT_ID) {
    return downloadE2bFile(path);
  }
  return downloadRemoteFile(path, selected, options);
}

/**
 * Read file content as text from the active agent.
 * @param {string} path - Path relative to files root
 * @param {string} [url] - Agent host URL or E2B identifier
 * @param {{signal?: AbortSignal, timeoutMs?: number}|AbortSignal} [options]
 * @returns {Promise<string>}
 */
export async function readFileText(path, url = getSelectedAgent(), options = {}) {
  const selected = url;
  if (selected === E2B_AGENT_ID) {
    return readE2bFileText(path);
  }
  // For HTTP server, download as blob and convert to text
  const blob = await downloadRemoteFile(path, selected, options);
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
export { getSandboxStatus, stopSandbox as stopE2bSandbox, enableE2b };
export { E2B_AGENT_ID };
export { listE2bFiles, createE2bFile, createE2bDir, deleteE2bFile, uploadE2bFile, downloadE2bFile, readE2bFileText, writeE2bFileText };
