/**
 * E2B cloud sandbox integration using the official E2B SDK.
 *
 * Flow: user provides API key -> find/create sandbox with metadata tag -> execute commands.
 * Sandbox is reused across sessions via metadata filter (vertexsandbox + random ID).
 * Commands are sent via E2B's WebSocket protocol (browser-compatible).
 */

import config from '../config/config.js';
import { Sandbox } from 'e2b';

const E2B_TEMPLATE = 'base';
const E2B_META_KEY = 'vertexsandbox';
const E2B_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const E2B_RECURSIVE_LIST_DEPTH = 64;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get or create a persistent random ID for this browser.
 * Stored in localStorage so sandbox survives page reloads.
 */
function getOrCreateId() {
  if (typeof localStorage === 'undefined') return crypto.randomUUID();
  let id = localStorage.getItem('e2b_vertex_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('e2b_vertex_id', id);
  }
  return id;
}

/**
 * Try to find an existing sandbox by metadata.
 * Returns the sandbox info if found, null otherwise.
 */
async function findExistingSandbox(apiKey, metaId = getOrCreateId()) {
  const paginator = await Sandbox.list({
    apiKey,
    query: { metadata: { [E2B_META_KEY]: metaId } },
  });
  const firstPage = await paginator.nextItems();
  if (firstPage && firstPage.length > 0) {
    return firstPage[0]; // return the first matching sandbox
  }
  return null;
}

function lifecycleAbortError() {
  return new DOMException('Sandbox startup was superseded', 'AbortError');
}

function sameSandbox(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  return Boolean(left.sandboxId && right.sandboxId && left.sandboxId === right.sandboxId);
}

/**
 * Coordinate sandbox startup and shutdown without depending on the E2B SDK.
 * Keeping this state machine injected makes its cancellation races deterministic
 * in tests and prevents concurrent callers from creating duplicate sandboxes.
 */
function createSandboxLifecycle({ open, close }) {
  let sandbox = null;
  let status = 'none';
  let error = null;
  let startup = null;
  let generation = 0;
  let connectedCleanup = Promise.resolve();
  const cleanupJobs = new Set();

  const isCurrentStartup = (record) => (
    startup === record && generation === record.generation
  );

  const observeCleanup = (operation) => {
    let job;
    job = Promise.resolve()
      .then(operation)
      .catch(() => {})
      .finally(() => cleanupJobs.delete(job));
    cleanupJobs.add(job);
  };

  const retireStaleSandbox = async (candidate, staleGeneration) => {
    // A newer startup may connect to the same persistent remote sandbox. Let it
    // claim the sandbox before deciding whether the stale SDK handle is safe to
    // kill, otherwise cleanup from an old generation could kill the new one.
    while (startup && startup.generation > staleGeneration) {
      const newerStartup = startup;
      await newerStartup.promise.catch(() => {});
      if (startup === newerStartup) break;
    }
    if (sameSandbox(candidate, sandbox)) return;
    await close(candidate);
  };

  const start = () => {
    if (sandbox) return Promise.resolve(sandbox);
    if (startup) return startup.promise;

    status = 'starting';
    error = null;
    const record = {
      generation: ++generation,
      promise: null,
    };
    const cleanupSnapshot = connectedCleanup;
    startup = record;

    // Defer opening until after the record is installed. This makes even a
    // synchronous throw from an injected SDK operation follow normal cleanup.
    record.promise = cleanupSnapshot
      .then(() => {
        if (!isCurrentStartup(record)) throw lifecycleAbortError();
        // Do not reconnect to a persistent sandbox while an older handle is
        // still being killed. Otherwise a late kill could terminate the newly
        // connected generation after it has already been published as ready.
        return open();
      })
      .then((candidate) => {
        if (!isCurrentStartup(record)) {
          observeCleanup(() => retireStaleSandbox(candidate, record.generation));
          throw lifecycleAbortError();
        }
        sandbox = candidate;
        status = 'connected';
        error = null;
        return candidate;
      })
      .catch((err) => {
        if (!isCurrentStartup(record)) throw lifecycleAbortError();
        sandbox = null;
        status = 'error';
        error = err instanceof Error ? err.message : String(err);
        throw err;
      })
      .finally(() => {
        if (startup === record) startup = null;
      });

    return record.promise;
  };

  const stop = async () => {
    generation += 1;
    const pendingStartup = startup;
    const connectedSandbox = sandbox;

    // Invalidate synchronously so a fire-and-forget disable/cleanup cannot be
    // undone by a late connect/create resolution.
    startup = null;
    sandbox = null;
    status = 'none';
    error = null;

    // The invalidated startup is still allowed to settle, but its rejection is
    // always observed and any late sandbox is retired by the startup handler.
    pendingStartup?.promise.catch(() => {});
    if (!connectedSandbox) return;

    const closing = Promise.resolve()
      .then(() => close(connectedSandbox))
      .catch(() => {
        // Remote cleanup is best effort. Local state is already disconnected.
      });
    connectedCleanup = closing;
    await closing;
    if (connectedCleanup === closing) connectedCleanup = Promise.resolve();
  };

  return {
    start,
    stop,
    ensure() {
      return sandbox ? Promise.resolve(sandbox) : start();
    },
    getSandbox() {
      return sandbox;
    },
    getStatus() {
      return {
        status,
        sandboxId: sandbox?.sandboxId || null,
        error,
      };
    },
    async drainCleanups() {
      while (cleanupJobs.size > 0) {
        await Promise.all([...cleanupJobs]);
      }
    },
  };
}

async function openPersistentSandbox({
  apiKey,
  metaId,
  find = findExistingSandbox,
  connect = (sandboxId, options) => Sandbox.connect(sandboxId, options),
  create = (options) => Sandbox.create(options),
}) {
  const existing = await find(apiKey, metaId);
  if (existing) {
    return connect(existing.sandboxId, { apiKey });
  }

  return create({
    template: E2B_TEMPLATE,
    apiKey,
    metadata: { [E2B_META_KEY]: metaId },
    timeoutMs: E2B_TIMEOUT_MS,
  });
}

async function openConfiguredSandbox() {
  const apiKey = config.get('e2b.apiKey');
  if (!apiKey) throw new Error('E2B API key not configured');

  return openPersistentSandbox({
    apiKey,
    metaId: getOrCreateId(),
  });
}

const sandboxLifecycle = createSandboxLifecycle({
  open: openConfiguredSandbox,
  close: (sandbox) => sandbox.kill(),
});

// ─── Sandbox lifecycle ───────────────────────────────────────────────────────

/**
 * Create or resume an E2B sandbox.
 * Reuses an existing sandbox tagged with our metadata, or creates a new one.
 */
export function startSandbox() {
  return sandboxLifecycle.start();
}

/**
 * Close the current E2B sandbox.
 */
export async function stopSandbox() {
  await sandboxLifecycle.stop();
}

/**
 * Execute a shell command in the E2B sandbox.
 * @param {string} cmd - Shell command to run.
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
export async function executeInSandbox(cmd, options = {}) {
  const result = await runUntilAbort(async () => {
    const sandbox = await ensureSandbox();
    // A sandbox startup can outlive the caller. Do not launch a command when
    // startup finishes after navigation or factory reset already aborted it.
    if (options.signal?.aborted) throw commandAbortError();

    // The E2B SDK does not expose a portable cancellation handle for this
    // one-shot call. Stop awaiting it on abort so navigation/factory reset can
    // complete; the sandbox command may finish independently server-side.
    return sandbox.commands.run(cmd);
  }, options.signal);

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    code: result.exitCode ?? 1,
  };
}

/**
 * Check if E2B is configured and sandbox is running.
 */
export function getSandboxStatus() {
  const apiKey = config.get('e2b.apiKey');
  const hasKey = !!apiKey;
  const lifecycleStatus = sandboxLifecycle.getStatus();
  return {
    enabled: hasKey,
    status: hasKey ? lifecycleStatus.status : 'none',
    sandboxId: lifecycleStatus.sandboxId,
    error: lifecycleStatus.error,
  };
}

/**
 * Initialize E2B: if API key is set and no sandbox, start one.
 * @returns {Promise<{ connected: boolean }>}
 */
export async function initE2b() {
  const apiKey = config.get('e2b.apiKey');
  if (!apiKey) {
    stopSandbox().catch(() => {});
    return { connected: false };
  }

  try {
    await startSandbox();
    return { connected: true };
  } catch (err) {
    console.error('E2B init failed:', err);
    return { connected: false };
  }
}

/**
 * Cleanup: close sandbox on app unload.
 */
export function cleanupE2b() {
  stopSandbox().catch(() => {});
}

/**
 * Enable E2B from Settings: save API key and start sandbox.
 * @returns {Promise<{ connected: boolean, error?: string }>}
 */
export async function enableE2b() {
  const apiKey = config.get('e2b.apiKey');
  if (!apiKey) return { connected: false, error: 'No API key' };
  try {
    await startSandbox();
    return { connected: true };
  } catch (err) {
    return { connected: false, error: err.message };
  }
}

// ─── File operations ────────────────────────────────────────────────────────

async function ensureSandbox() {
  return sandboxLifecycle.ensure();
}

function commandAbortError() {
  return new DOMException('Command execution aborted', 'AbortError');
}

/**
 * Stop awaiting an operation when its signal is aborted. Promise.race keeps
 * observing the SDK promise after the caller is released, preventing a late
 * startup/command rejection from becoming unhandled.
 */
function runUntilAbort(operation, signal) {
  if (!signal) return Promise.resolve().then(operation);
  if (signal.aborted) return Promise.reject(commandAbortError());

  let abort;
  const aborted = new Promise((_resolve, reject) => {
    abort = () => reject(commandAbortError());
    signal.addEventListener('abort', abort, { once: true });
    // Cover an abort between the initial check and listener registration.
    if (signal.aborted) abort();
  });
  const pending = Promise.resolve().then(operation);

  return Promise.race([pending, aborted])
    .finally(() => signal.removeEventListener('abort', abort));
}

function sandboxRelativePath(path, options = {}) {
  const rawPath = String(path || '').trim().replace(/\\/g, '/');
  if (rawPath.includes('\0')) {
    throw new Error('Path contains invalid characters');
  }
  if (rawPath.startsWith('/') || /^[A-Za-z]:\//.test(rawPath)) {
    throw new Error('Path must be relative to the sandbox workspace');
  }
  const parts = rawPath.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) {
    throw new Error('Path cannot leave the sandbox workspace');
  }
  const normalizedPath = parts.join('/');
  if (!options.allowEmpty && !normalizedPath) {
    throw new Error('Path is required');
  }
  return normalizedPath;
}

function sandboxApiPath(path, options) {
  const safePath = sandboxRelativePath(path, options);
  return safePath ? `/${safePath}` : '/';
}

function joinSandboxRelativePath(...parts) {
  return sandboxRelativePath(
    parts
      .filter((part) => part !== null && part !== undefined && String(part).length > 0)
      .join('/'),
    { allowEmpty: true }
  );
}

function splitSandboxRelativePath(path) {
  const safePath = sandboxRelativePath(path);
  const parts = safePath.split('/');
  const name = parts.pop();
  return { dir: parts.join('/'), name };
}

function isE2bDirectoryEntry(entry) {
  return entry?.type === 'dir' || entry?.type === 'directory';
}

function isE2bNotFoundError(error) {
  const status = Number(
    error?.status ?? error?.statusCode ?? error?.response?.status
  );
  const code = String(error?.code || error?.name || '').toLowerCase();
  return status === 404
    || code === 'notfound'
    || code === 'notfounderror'
    || code === 'filenotfound'
    || code === 'directorynotfound';
}

async function getE2bEntry(sandbox, path) {
  const { dir, name } = splitSandboxRelativePath(path);
  try {
    const entries = await sandbox.files.list(sandboxApiPath(dir, { allowEmpty: true }));
    return entries.find((entry) => entry.name === name) || null;
  } catch (error) {
    if (isE2bNotFoundError(error)) return null;
    // Treating an auth/network failure as "missing" could make move overwrite
    // an existing target, so ambiguous listing failures must abort the move.
    throw error;
  }
}

async function copyE2bFile(sandbox, sourcePath, targetPath) {
  const content = await sandbox.files.read(sandboxApiPath(sourcePath), { format: 'blob' });
  const payload = content && typeof content.arrayBuffer === 'function'
    ? await content.arrayBuffer()
    : content;
  await sandbox.files.write(sandboxApiPath(targetPath), payload);
}

async function copyE2bDirectory(sandbox, sourcePath, targetPath) {
  await sandbox.files.makeDir(sandboxApiPath(targetPath), { force: true });
  const entries = await sandbox.files.list(sandboxApiPath(sourcePath));

  for (const entry of entries) {
    const childSource = joinSandboxRelativePath(sourcePath, entry.name);
    const childTarget = joinSandboxRelativePath(targetPath, entry.name);
    if (isE2bDirectoryEntry(entry)) {
      await copyE2bDirectory(sandbox, childSource, childTarget);
    } else {
      await copyE2bFile(sandbox, childSource, childTarget);
    }
  }
}

/**
 * List files/directories in the E2B sandbox.
 * @param {string} [path] - Directory path (empty for root)
 * @param {{recursive?: boolean}} [options] - Listing options
 * @returns {Promise<{id: string, name: string, type: string, size: number, path: string, parentDir: string, children: Array}|Array>}
 */
export async function listE2bFiles(path = '', options = {}) {
  const sandbox = await ensureSandbox();
  const safePath = sandboxRelativePath(path, { allowEmpty: true });
  const entries = await sandbox.files.list(
    sandboxApiPath(safePath, { allowEmpty: true }),
    options.recursive ? { depth: E2B_RECURSIVE_LIST_DEPTH } : undefined
  );
  const parentDir = safePath;
  return {
    id: 'root',
    name: '/',
    type: 'directory',
    ...(options.recursive ? { recursive: true } : {}),
    children: entries.map((entry) => ({
      id: `${isE2bDirectoryEntry(entry) ? 'dir' : 'file'}-${entry.path}`,
      name: entry.name,
      type: isE2bDirectoryEntry(entry) ? 'directory' : 'file',
      size: entry.type === 'file' ? (entry.size || 0) : 0,
      path: entry.path,
      parentDir,
      lastModified: entry.modifiedTime?.getTime?.() || entry.modifiedTime,
    })),
  };
}

/**
 * Create a file in the E2B sandbox.
 * @param {string} path - File path
 * @param {string} [content] - File content
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function createE2bFile(path, content = '') {
  const sandbox = await ensureSandbox();
  await sandbox.files.write(sandboxApiPath(path), content);
  return { success: true, message: 'File created' };
}

/**
 * Create a directory in the E2B sandbox.
 * @param {string} path - Directory path
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function createE2bDir(path) {
  const sandbox = await ensureSandbox();
  await sandbox.files.makeDir(sandboxApiPath(path), { force: true });
  return { success: true, message: 'Directory created' };
}

/**
 * Delete a file or directory in the E2B sandbox.
 * @param {string} path - Path to delete
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function deleteE2bFile(path) {
  const sandbox = await ensureSandbox();
  await sandbox.files.remove(sandboxApiPath(path));
  return { success: true, message: 'Deleted successfully' };
}

/**
 * Move a file or directory in the E2B sandbox.
 * @param {string} sourcePath - Source path
 * @param {string} targetPath - Destination path
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function moveE2bFile(sourcePath, targetPath) {
  const sandbox = await ensureSandbox();
  const safeSourcePath = sandboxRelativePath(sourcePath);
  const safeTargetPath = sandboxRelativePath(targetPath);

  if (safeSourcePath === safeTargetPath) {
    return { success: true, message: 'Already at target path' };
  }

  const sourceEntry = await getE2bEntry(sandbox, safeSourcePath);
  if (!sourceEntry) throw new Error('Source file or directory not found');

  const targetEntry = await getE2bEntry(sandbox, safeTargetPath);
  if (targetEntry) throw new Error('Destination already exists');

  if (isE2bDirectoryEntry(sourceEntry) && safeTargetPath.startsWith(`${safeSourcePath}/`)) {
    throw new Error('Cannot move a directory into itself');
  }

  const { dir: targetParent } = splitSandboxRelativePath(safeTargetPath);
  if (targetParent) {
    await sandbox.files.makeDir(sandboxApiPath(targetParent), { force: true });
  }

  let targetCreated = false;
  try {
    if (isE2bDirectoryEntry(sourceEntry)) {
      targetCreated = true;
      await copyE2bDirectory(sandbox, safeSourcePath, safeTargetPath);
    } else {
      await copyE2bFile(sandbox, safeSourcePath, safeTargetPath);
      targetCreated = true;
    }
    await sandbox.files.remove(sandboxApiPath(safeSourcePath));
    return { success: true, message: 'Moved successfully' };
  } catch (err) {
    if (targetCreated) {
      try { await sandbox.files.remove(sandboxApiPath(safeTargetPath)); } catch { /* ignore cleanup */ }
    }
    throw err;
  }
}

/**
 * Upload a file to the E2B sandbox.
 * @param {string} path - Destination path
 * @param {Blob|File} file - File to upload
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function uploadE2bFile(path, file) {
  const sandbox = await ensureSandbox();
  const content = await file.arrayBuffer();
  await sandbox.files.write(sandboxApiPath(path), content);
  return { success: true, message: 'File uploaded' };
}

/**
 * Download a file from the E2B sandbox.
 * @param {string} path - File path
 * @returns {Promise<Blob>}
 */
export async function downloadE2bFile(path) {
  const sandbox = await ensureSandbox();
  return sandbox.files.read(sandboxApiPath(path), { format: 'blob' });
}

/**
 * Read file content as text from the E2B sandbox.
 * @param {string} path - File path
 * @returns {Promise<string>}
 */
export async function readE2bFileText(path) {
  const sandbox = await ensureSandbox();
  return sandbox.files.read(sandboxApiPath(path), { format: 'text' });
}

/**
 * Write file content to the E2B sandbox (used by file editor).
 * @param {string} path - File path
 * @param {string} content - File content
 * @returns {Promise<void>}
 */
export async function writeE2bFileText(path, content) {
  const sandbox = await ensureSandbox();
  await sandbox.files.write(sandboxApiPath(path), content);
}

export const __e2bInternals = {
  createSandboxLifecycle,
  isE2bNotFoundError,
  openPersistentSandbox,
  runUntilAbort,
};
