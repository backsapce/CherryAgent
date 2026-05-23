/**
 * E2B cloud sandbox integration using the official E2B SDK.
 *
 * Flow: user provides API key -> find/create sandbox with metadata tag -> execute commands.
 * Sandbox is reused across sessions via metadata filter (vertexsandbox + random ID).
 * Commands are sent via E2B's WebSocket protocol (browser-compatible).
 */

import config from '../config/config';
import { Sandbox } from 'e2b';

const E2B_TEMPLATE = 'base';
const E2B_META_KEY = 'vertexsandbox';
const E2B_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

let _sandbox = null;   // Sandbox instance
let _status = 'none';  // 'none' | 'starting' | 'connected' | 'error'
let _error = null;
let _sandboxId = null;  // persistent sandbox ID (across sessions)

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
async function findExistingSandbox(apiKey) {
  try {
    const id = getOrCreateId();
    const paginator = await Sandbox.list({ apiKey, query:{metadata: { [E2B_META_KEY]: id } }});
    const firstPage = await paginator.nextItems()
    if (firstPage && firstPage.length > 0) {
      return firstPage[0]; // return the first matching sandbox
    }
  } catch {
    // listing failed, fall through to create
  }
  return null;
}

// ─── Sandbox lifecycle ───────────────────────────────────────────────────────

/**
 * Create or resume an E2B sandbox.
 * Reuses an existing sandbox tagged with our metadata, or creates a new one.
 */
export async function startSandbox() {
  if (_sandbox) return _sandbox;

  _status = 'starting';
  _error = null;

  try {
    const apiKey = config.get('e2b.apiKey');
    if (!apiKey) throw new Error('E2B API key not configured');

    const metaId = getOrCreateId();

    // Try to find and resume existing sandbox
    const existing = await findExistingSandbox(apiKey);
    if (existing) {
      _sandbox = await Sandbox.connect(existing.sandboxId, { apiKey });
      _sandboxId = existing.sandboxId;
      _status = 'connected';
      return _sandbox;
    }

    // No existing sandbox — create a new one
    _sandbox = await Sandbox.create({
      template: E2B_TEMPLATE,
      apiKey,
      metadata: { [E2B_META_KEY]: metaId },
      timeoutMs: E2B_TIMEOUT_MS,
    });

    _sandboxId = _sandbox.sandboxId;
    _status = 'connected';
    return _sandbox;
  } catch (err) {
    _status = 'error';
    _error = err.message;
    _sandbox = null;
    _sandboxId = null;
    throw err;
  }
}

/**
 * Close the current E2B sandbox.
 */
export async function stopSandbox() {
  if (!_sandbox) return;

  try {
    await _sandbox.kill();
  } catch {
    // ignore cleanup errors
  } finally {
    _sandbox = null;
    _sandboxId = null;
    _status = 'none';
    _error = null;
  }
}

/**
 * Execute a shell command in the E2B sandbox.
 * @param {string} cmd - Shell command to run.
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
export async function executeInSandbox(cmd) {
  await ensureSandbox();

  const result = await _sandbox.commands.run(cmd);

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
  return {
    enabled: hasKey,
    status: hasKey ? _status : 'none',
    sandboxId: _sandboxId || _sandbox?.sandboxId || null,
    error: _error,
  };
}

/**
 * Initialize E2B: if API key is set and no sandbox, start one.
 * @returns {Promise<{ connected: boolean }>}
 */
export async function initE2b() {
  const apiKey = config.get('e2b.apiKey');
  if (!apiKey) {
    _status = 'none';
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
  if (!_sandbox || _status !== 'connected') {
    await startSandbox();
  }
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

/**
 * List files/directories in the E2B sandbox.
 * @param {string} [path] - Directory path (empty for root)
 * @returns {Promise<{id: string, name: string, type: string, size: number, path: string, parentDir: string, children: Array}|Array>}
 */
export async function listE2bFiles(path = '') {
  await ensureSandbox();
  const safePath = sandboxRelativePath(path, { allowEmpty: true });
  const entries = await _sandbox.files.list(sandboxApiPath(safePath, { allowEmpty: true }));
  const parentDir = safePath;
  return {
    id: 'root',
    name: '/',
    type: 'directory',
    children: entries.map((entry) => ({
      id: `${entry.type === 'directory' ? 'dir' : 'file'}-${entry.path}`,
      name: entry.name,
      type: entry.type === 'dir' ? 'directory' : 'file',
      size: entry.type === 'file' ? (entry.size || 0) : 0,
      path: entry.path,
      parentDir,
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
  await ensureSandbox();
  await _sandbox.files.write(sandboxApiPath(path), content);
  return { success: true, message: 'File created' };
}

/**
 * Create a directory in the E2B sandbox.
 * @param {string} path - Directory path
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function createE2bDir(path) {
  await ensureSandbox();
  await _sandbox.files.makeDir(sandboxApiPath(path), { force: true });
  return { success: true, message: 'Directory created' };
}

/**
 * Delete a file or directory in the E2B sandbox.
 * @param {string} path - Path to delete
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function deleteE2bFile(path) {
  await ensureSandbox();
  await _sandbox.files.remove(sandboxApiPath(path));
  return { success: true, message: 'Deleted successfully' };
}

/**
 * Upload a file to the E2B sandbox.
 * @param {string} path - Destination path
 * @param {Blob|File} file - File to upload
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function uploadE2bFile(path, file) {
  await ensureSandbox();
  const content = await file.arrayBuffer();
  await _sandbox.files.write(sandboxApiPath(path), content);
  return { success: true, message: 'File uploaded' };
}

/**
 * Download a file from the E2B sandbox.
 * @param {string} path - File path
 * @returns {Promise<Blob>}
 */
export async function downloadE2bFile(path) {
  await ensureSandbox();
  return _sandbox.files.read(sandboxApiPath(path), { format: 'blob' });
}

/**
 * Read file content as text from the E2B sandbox.
 * @param {string} path - File path
 * @returns {Promise<string>}
 */
export async function readE2bFileText(path) {
  await ensureSandbox();
  return _sandbox.files.read(sandboxApiPath(path), { format: 'text' });
}

/**
 * Write file content to the E2B sandbox (used by file editor).
 * @param {string} path - File path
 * @param {string} content - File content
 * @returns {Promise<void>}
 */
export async function writeE2bFileText(path, content) {
  await ensureSandbox();
  await _sandbox.files.write(sandboxApiPath(path), content);
}
