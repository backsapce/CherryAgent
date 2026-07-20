/**
 * OPFS-based Virtual File System for Vertex Agent
 * Uses the Origin Private File System to persist data in the browser.
 */

import JSZip from 'jszip';
import yaml from 'js-yaml';
import { getWorkspaceDirName } from '../agents/agents.js';
import { reconcileSessionRecoveryJournal } from '../sessionRefresh.js';

const ROOT_DIR = 'vertex-agent';
const SYNC_DIR = '.sync';

export const ZIP_IMPORT_MAX_ENTRIES = 10_000;
export const ZIP_IMPORT_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const ZIP_IMPORT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const ZIP_IMPORT_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const SESSION_RECOVERY_MAX_BYTES = 64 * 1024 * 1024;
export const SESSION_RECOVERY_MAX_SESSIONS = 20_000;
export const SESSION_RECOVERY_MAX_MESSAGES = 200_000;
const ZIP_IMPORT_MAX_PATH_BYTES = 4096;
const ZIP_IMPORT_MAX_SEGMENT_BYTES = 255;
const ZIP_IMPORT_MAX_PATH_DEPTH = 64;

export class ZipImportValidationError extends Error {
  constructor(code, message, path = null) {
    super(message);
    this.name = 'ZipImportValidationError';
    this.code = code;
    this.path = path;
  }
}

const syncHooks = new Set();
let sessionMetadataWriteSnapshot = null;
const sessionMessageWriteSnapshots = new Map();
let sessionWriteCacheRoot = null;
const agentWorkspaceMutationQueues = new Map();

function withAgentWorkspaceMutation(agentId, scope, operation) {
  const key = JSON.stringify([agentId || null, scope]);
  const previous = agentWorkspaceMutationQueues.get(key) || Promise.resolve();
  const task = previous.then(operation);
  const settled = task.catch(() => {});
  agentWorkspaceMutationQueues.set(key, settled);
  settled.finally(() => {
    if (agentWorkspaceMutationQueues.get(key) === settled) {
      agentWorkspaceMutationQueues.delete(key);
    }
  });
  return task;
}

// Keep only a compact change fingerprint here. Retaining the full serialized
// message body duplicated every conversation (including image data URLs) for
// the lifetime of the tab and made session persistence a major heap consumer.
function sessionMessageFingerprint(serialized) {
  let hashA = 0x811c9dc5;
  let hashB = 0x9e3779b9;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    hashA = Math.imul(hashA ^ code, 0x01000193);
    hashB = Math.imul(hashB ^ code, 0x85ebca6b);
  }
  return `${serialized.length}:${hashA >>> 0}:${hashB >>> 0}`;
}

async function ensureSessionWriteCacheRoot(root) {
  let sameRoot = root === sessionWriteCacheRoot;
  if (!sameRoot && root?.isSameEntry && sessionWriteCacheRoot) {
    try { sameRoot = await root.isSameEntry(sessionWriteCacheRoot); } catch { /* reset below */ }
  }
  if (!sameRoot) {
    sessionMetadataWriteSnapshot = null;
    sessionMessageWriteSnapshots.clear();
  }
  sessionWriteCacheRoot = root;
}

// ─── Core Helpers ─────────────────────────────────────────────────────────────

function pathParts(path) {
  return String(path || '').split('/').filter(Boolean);
}

function normalizeLocalPath(path) {
  return pathParts(path).join('/');
}

export function normalizeWorkspaceRelativePath(path, options = {}) {
  const rawPath = String(path || '').trim().replace(/\\/g, '/');
  if (rawPath.includes('\0')) {
    throw new Error('Path contains invalid characters');
  }
  if (rawPath.startsWith('/') || /^[A-Za-z]:\//.test(rawPath)) {
    throw new Error('Path must be relative to the agent workspace');
  }

  const parts = rawPath.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) {
    throw new Error('Path cannot leave the agent workspace');
  }

  const normalizedPath = parts.join('/');
  if (!options.allowEmpty && !normalizedPath) {
    throw new Error('Path is required');
  }
  return normalizedPath;
}

function isInternalSyncPath(path) {
  return normalizeLocalPath(path).split('/')[0] === SYNC_DIR;
}

export function registerOpfsSyncHook(fn) {
  syncHooks.add(fn);
  return () => syncHooks.delete(fn);
}

export function notifyOpfsMutation(paths, type = 'write') {
  const changedPaths = [...new Set(
    (Array.isArray(paths) ? paths : [paths])
      .map(normalizeLocalPath)
      .filter((path) => path && !isInternalSyncPath(path))
  )];
  if (changedPaths.length === 0) return;

  for (const path of changedPaths) {
    if (path === 'session.json') sessionMetadataWriteSnapshot = null;
    const match = /^sessions\/([^/]+)\.json$/.exec(path);
    if (match) sessionMessageWriteSnapshots.delete(match[1]);
  }

  const event = { type, paths: changedPaths, at: Date.now() };
  for (const fn of syncHooks) {
    try { fn(event); } catch (err) { console.warn('OPFS sync hook failed:', err); }
  }
}

/**
 * Get the root directory handle for the application.
 */
export async function getRootDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ROOT_DIR, { create: true });
}

/**
 * Get a directory handle by path (creates if not exists).
 * @param {string[]} pathParts - Array of directory names
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function getDirectory(...pathParts) {
  let dir = await getRootDir();
  for (const part of pathParts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
}

async function getExistingDirectory(...pathParts) {
  let dir = await getRootDir();
  for (const part of pathParts) {
    dir = await dir.getDirectoryHandle(part);
  }
  return dir;
}

/**
 * Read a JSON file from a directory.
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} filename
 * @returns {Promise<any>}
 */
async function readJSON(dirHandle, filename) {
  let fileHandle;
  try {
    fileHandle = await dirHandle.getFileHandle(filename);
  } catch (error) {
    if (isMissingFileSystemEntry(error)) return null;
    throw error;
  }
  const file = await fileHandle.getFile();
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${filename} contains invalid JSON`, { cause: error });
  }
}

function isMissingFileSystemEntry(error) {
  return error?.name === 'NotFoundError'
    || /(?:file|entry|directory) not found/i.test(String(error?.message || ''));
}

function isDirectoryNotEmptyError(error) {
  return error?.name === 'InvalidModificationError'
    || /(?:not empty|contains entries|has children)/i.test(String(error?.message || ''));
}

const MISSING_SESSION_JSON = Symbol('missing-session-json');

async function readSessionJSON(dirHandle, filename) {
  let fileHandle;
  try {
    fileHandle = await dirHandle.getFileHandle(filename);
  } catch (error) {
    if (isMissingFileSystemEntry(error)) return MISSING_SESSION_JSON;
    throw error;
  }
  const file = await fileHandle.getFile();
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Session storage contains invalid JSON in ${filename}`, { cause: error });
  }
}

/**
 * Write data as JSON to a file.
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} filename
 * @param {any} data
 */
async function writeJSON(dirHandle, filename, data, options = {}) {
  return writeSerializedJSON(dirHandle, filename, JSON.stringify(data, null, 2), options);
}

async function writeSerializedJSON(dirHandle, filename, serialized, options = {}) {
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(serialized);
    await writable.close();
  } catch (error) {
    try { await writable.abort?.(); } catch { /* preserve the original error */ }
    throw error;
  }
  if (!options.internal) notifyOpfsMutation(options.localPath || filename, 'write');
}

/**
 * Read a file as text.
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} filename
 * @returns {Promise<string|null>}
 */
export async function readText(dirHandle, filename) {
  try {
    const fileHandle = await dirHandle.getFileHandle(filename);
    const file = await fileHandle.getFile();
    return await file.text();
  } catch (error) {
    if (isMissingFileSystemEntry(error)) return null;
    throw error;
  }
}

/**
 * Write text to a file.
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} filename
 * @param {string|Blob} content
 */
export async function writeText(dirHandle, filename, content, options = {}) {
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(content);
    await writable.close();
  } catch (error) {
    try { await writable.abort?.(); } catch { /* preserve the original error */ }
    throw error;
  }
  if (!options.internal) notifyOpfsMutation(options.localPath || filename, 'write');
}

export async function readPathBlob(localPath) {
  const parts = pathParts(localPath);
  const filename = parts.pop();
  const dir = parts.length > 0 ? await getExistingDirectory(...parts) : await getRootDir();
  const fileHandle = await dir.getFileHandle(filename);
  return fileHandle.getFile();
}

export async function readPathText(localPath) {
  const file = await readPathBlob(localPath);
  return file.text();
}

export async function readPathBytes(localPath) {
  const file = await readPathBlob(localPath);
  return new Uint8Array(await file.arrayBuffer());
}

export async function writePathBlob(localPath, content, options = {}) {
  const parts = pathParts(localPath);
  const filename = parts.pop();
  const dir = parts.length > 0 ? await getDirectory(...parts) : await getRootDir();
  await writeText(dir, filename, content, { ...options, localPath });
}

export async function writePathText(localPath, content, options = {}) {
  await writePathBlob(localPath, content, options);
}

export async function writePathBytes(localPath, bytes, options = {}) {
  await writePathBlob(localPath, bytes, options);
}

export async function deletePath(localPath, options = {}) {
  const parts = pathParts(localPath);
  const filename = parts.pop();
  if (!filename) return;
  try {
    const dir = parts.length > 0 ? await getExistingDirectory(...parts) : await getRootDir();
    await dir.removeEntry(filename, { recursive: true });
    if (!options.internal) notifyOpfsMutation(localPath, 'delete');
    return true;
  } catch (error) {
    if (isMissingFileSystemEntry(error)) return false;
    throw error;
  }
}

/**
 * Idempotently remove a file or empty directory without ever deleting
 * descendants. This is the safe final step after sync has verified a file
 * snapshot: if another writer replaces it with a populated directory, OPFS
 * rejects the removal and the caller can treat the shape change as a conflict.
 */
export async function deletePathNonRecursive(localPath, options = {}) {
  const parts = pathParts(localPath);
  const filename = parts.pop();
  if (!filename) return false;
  let dir;
  try {
    dir = parts.length > 0 ? await getExistingDirectory(...parts) : await getRootDir();
  } catch (error) {
    if (isMissingFileSystemEntry(error)) return true;
    throw error;
  }
  try {
    // Deliberately omit `recursive`: a concurrent file-to-directory change
    // with new descendants must never turn a sync deletion into data loss.
    await dir.removeEntry(filename);
    if (!options.internal) notifyOpfsMutation(localPath, 'delete');
    return true;
  } catch (error) {
    if (isMissingFileSystemEntry(error)) return true;
    if (isDirectoryNotEmptyError(error)) return false;
    throw error;
  }
}

async function removeDirectoryTreeIfEmpty(parent, name) {
  let directory;
  try {
    directory = await parent.getDirectoryHandle(name);
  } catch (error) {
    if (isMissingFileSystemEntry(error)) return true;
    throw error;
  }
  for (const entry of await listEntries(directory)) {
    if (entry.kind !== 'directory') return false;
    if (!(await removeDirectoryTreeIfEmpty(directory, entry.name))) return false;
  }
  try {
    // Deliberately omit `recursive`. If a writer creates a descendant after
    // the scan, OPFS rejects this removal instead of deleting new user data.
    await parent.removeEntry(name);
    return true;
  } catch (error) {
    if (isMissingFileSystemEntry(error)) return true;
    if (isDirectoryNotEmptyError(error)) return false;
    throw error;
  }
}

export async function deleteEmptyPathTree(localPath, options = {}) {
  const parts = pathParts(localPath);
  const name = parts.pop();
  if (!name) return false;
  let parent;
  try {
    parent = parts.length > 0 ? await getExistingDirectory(...parts) : await getRootDir();
  } catch (error) {
    if (isMissingFileSystemEntry(error)) return true;
    throw error;
  }
  const removed = await removeDirectoryTreeIfEmpty(parent, name);
  if (removed && !options.internal) notifyOpfsMutation(localPath, 'delete');
  return removed;
}

export async function hashBlob(blob) {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function listOpfsFiles(options = {}) {
  const root = await getRootDir();
  const files = [];

  async function walk(dir, prefix = '') {
    const entries = await listEntries(dir);
    const fileTasks = [];
    const dirTasks = [];
    for (const { name, kind } of entries) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (!options.includeSync && isInternalSyncPath(path)) continue;
      if (kind === 'directory') {
        // Recurse subdirectories concurrently. Each branch pushes its own
        // results, so the only ordering guarantee is that a directory's
        // direct files precede its descendants' files; all callers consume
        // the list as a set, never depending on traversal order.
        dirTasks.push((async () => {
          await walk(await dir.getDirectoryHandle(name), path);
        })());
      } else {
        // getFile() returns a lazy File reference (metadata only, no content
        // buffered), so reading many files concurrently stays memory-safe.
        fileTasks.push((async () => {
          const file = await (await dir.getFileHandle(name)).getFile();
          return { path, file, hash: options.hash ? await hashBlob(file) : null };
        })());
      }
    }
    const fileResults = await Promise.all(fileTasks);
    for (const { path, file, hash } of fileResults) {
      files.push({
        path,
        size: file.size,
        lastModified: file.lastModified,
        hash,
        ...(options.includeBlob ? { blob: file } : {}),
      });
    }
    await Promise.all(dirTasks);
  }

  await walk(root);
  return files;
}

export async function getOpfsDataStats(options = {}) {
  const files = await listOpfsFiles({ includeSync: true, ...options, hash: false });
  return {
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + (Number(file.size) || 0), 0),
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function mergeByIdentity(localItems, incomingItems) {
  const merged = [...localItems];
  const indexByKey = new Map();

  merged.forEach((item, index) => {
    if (!isPlainObject(item)) return;
    const key = item.id ?? item.name ?? item.url;
    if (key != null) indexByKey.set(String(key), index);
  });

  for (const incomingItem of incomingItems) {
    if (isPlainObject(incomingItem)) {
      const key = incomingItem.id ?? incomingItem.name ?? incomingItem.url;
      const existingIndex = key != null ? indexByKey.get(String(key)) : undefined;
      if (existingIndex != null) {
        merged[existingIndex] = mergeData(merged[existingIndex], incomingItem);
        continue;
      }
    }

    const exists = merged.some((item) => JSON.stringify(item) === JSON.stringify(incomingItem));
    if (!exists) merged.push(incomingItem);
  }

  return merged;
}

function mergeData(localValue, incomingValue) {
  if (localValue == null) return incomingValue;
  if (incomingValue == null) return localValue;

  if (Array.isArray(localValue) && Array.isArray(incomingValue)) {
    return mergeByIdentity(localValue, incomingValue);
  }

  if (isPlainObject(localValue) && isPlainObject(incomingValue)) {
    const merged = { ...localValue };
    for (const [key, incomingChild] of Object.entries(incomingValue)) {
      merged[key] = mergeData(localValue[key], incomingChild);
    }
    return merged;
  }

  return localValue;
}

function shouldMergeIncomingFile(path) {
  return [
    'config.yaml',
    'config.yml',
    'config.json',
    'session.json',
    'chat.json',
    'chats.json',
  ].includes(path) || /^(sessions|messages)\/[^/]+\.json$/.test(path);
}

function formatMergedFile(path, data) {
  if (path === 'config.yaml' || path === 'config.yml') {
    return yaml.dump(data, { lineWidth: 120, noRefs: true });
  }
  return JSON.stringify(data, null, 2);
}

function parseMergeableFile(path, text) {
  if (path === 'config.yaml' || path === 'config.yml') {
    try {
      return yaml.load(text) || {};
    } catch {
      return null;
    }
  }
  return parseJson(text);
}

/**
 * Merge incoming backup/sync content into existing content. The existing side
 * wins scalar conflicts; the incoming side contributes missing keys/items.
 */
export function mergeIncomingTextContent(existingText, incomingText, localPath) {
  const normalizedPath = (localPath || '').replace(/^\/+|\/+$/g, '');

  if (!shouldMergeIncomingFile(normalizedPath)) {
    return { content: incomingText, merged: false };
  }

  const incomingData = parseMergeableFile(normalizedPath, incomingText);
  if (incomingData == null) {
    return { content: incomingText, merged: false };
  }

  if (!existingText) {
    return { content: formatMergedFile(normalizedPath, incomingData), merged: false };
  }

  const localData = parseMergeableFile(normalizedPath, existingText);
  if (localData == null) {
    return { content: incomingText, merged: false };
  }

  return {
    content: formatMergedFile(normalizedPath, mergeData(localData, incomingData)),
    merged: true,
  };
}

/**
 * Write incoming backup/sync content. Known structured data files are merged
 * instead of overwritten so local config, sessions, and messages are preserved.
 */
export async function writeIncomingText(dirHandle, filename, content, localPath, options = {}) {
  const existingText = await readText(dirHandle, filename);
  const result = mergeIncomingTextContent(existingText, content, localPath || filename);
  await writeText(dirHandle, filename, result.content, {
    ...options,
    localPath: localPath || filename,
  });
  return { merged: result.merged };
}

export async function writeIncomingTextExact(dirHandle, filename, content) {
  await writeText(dirHandle, filename, content);
  return { merged: false };
}

/**
 * Delete a file from a directory.
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} filename
 */
export async function deleteEntry(dirHandle, filename) {
  try {
    await dirHandle.removeEntry(filename);
    return true;
  } catch (error) {
    if (isMissingFileSystemEntry(error)) return false;
    throw error;
  }
}

/**
 * List all entries in a directory.
 * @param {FileSystemDirectoryHandle} dirHandle
 * @returns {Promise<Array<{name: string, kind: 'file'|'directory'}>>}
 */
export async function listEntries(dirHandle) {
  const entries = [];
  for await (const [name, handle] of dirHandle) {
    entries.push({ name, kind: handle.kind });
  }
  return entries;
}

// ─── Session Operations ───────────────────────────────────────────────────────

const SESSION_FILE = 'session.json';
const LEGACY_CONVERSATION_FILES = ['chats.json', 'chat.json'];
const SESSIONS_DIR = 'sessions';
const LEGACY_MESSAGES_DIR = 'messages';
const SESSION_INDEX_FILES = new Set([SESSION_FILE, ...LEGACY_CONVERSATION_FILES]);
const MAX_SESSION_ID_BYTES = 250; // Leave room for the ".json" suffix in a 255-byte name.
const SESSION_RECOVERY_FILE = `${SYNC_DIR}/session-recovery.json`;

function sessionRecoveryError(reason, cause = undefined) {
  return new Error(`Session recovery journal is invalid: ${reason}`, cause ? { cause } : undefined);
}

function validateRecoverySessionId(value) {
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) return null;
  const id = String(value);
  if (
    !id
    || id !== id.trim()
    || id === '.'
    || id === '..'
    || id.includes('/')
    || id.includes('\\')
    || hasControlCharacter(id)
    || new TextEncoder().encode(id).byteLength > MAX_SESSION_ID_BYTES
  ) return null;
  return id;
}

function validateRecoverySessions(sessions, label) {
  if (!Array.isArray(sessions)) {
    throw sessionRecoveryError(`${label} must be an array`);
  }
  if (sessions.length > SESSION_RECOVERY_MAX_SESSIONS) {
    throw sessionRecoveryError(
      `${label} exceeds the ${SESSION_RECOVERY_MAX_SESSIONS}-session limit`
    );
  }
  const ids = new Set();
  let messageCount = 0;
  for (const session of sessions) {
    if (!isPlainObject(session)) {
      throw sessionRecoveryError(`${label} contains a non-object session`);
    }
    const id = validateRecoverySessionId(session.id);
    if (id == null) throw sessionRecoveryError(`${label} contains an unsafe session id`);
    if (ids.has(id)) throw sessionRecoveryError(`${label} contains a duplicate session id`);
    ids.add(id);
    // A missing messages property is a metadata-only session. Session bodies
    // are loaded lazily, so checkpoints must preserve that distinction from
    // an explicitly empty conversation.
    if (session.messages !== undefined && !Array.isArray(session.messages)) {
      throw sessionRecoveryError(`${label} contains an invalid message array`);
    }
    if (session.messages?.some((message) => !isPlainObject(message))) {
      throw sessionRecoveryError(`${label} contains a non-object message`);
    }
    messageCount += session.messages?.length || 0;
    if (messageCount > SESSION_RECOVERY_MAX_MESSAGES) {
      throw sessionRecoveryError(
        `${label} exceeds the ${SESSION_RECOVERY_MAX_MESSAGES}-message limit`
      );
    }
  }
}

async function loadSessionIndex(root) {
  let sessions = await readSessionJSON(root, SESSION_FILE);
  const loadedPrimaryIndex = sessions !== MISSING_SESSION_JSON;
  if (sessions === MISSING_SESSION_JSON) {
    for (const legacyFile of LEGACY_CONVERSATION_FILES) {
      sessions = await readSessionJSON(root, legacyFile);
      if (sessions !== MISSING_SESSION_JSON) break;
    }
  }
  if (sessions === MISSING_SESSION_JSON) sessions = [];
  if (!Array.isArray(sessions)) {
    throw new Error(`${SESSION_FILE} must contain a JSON array`);
  }
  for (const session of sessions) {
    if (session?.id == null) {
      throw new Error(`${SESSION_FILE} contains a session without an id`);
    }
  }
  return { sessions, loadedPrimaryIndex };
}

/** Load only list metadata. Message bodies remain in OPFS until selected. */
export async function loadSessionMetadata() {
  const root = await getRootDir();
  await ensureSessionWriteCacheRoot(root);
  const { sessions, loadedPrimaryIndex } = await loadSessionIndex(root);
  sessionMetadataWriteSnapshot = loadedPrimaryIndex ? JSON.stringify(sessions) : null;
  return sessions;
}

/** Load one session's message body on demand. */
export async function loadSessionMessages(sessionId) {
  const root = await getRootDir();
  await ensureSessionWriteCacheRoot(root);
  const id = String(sessionId);
  const sessionDir = await getDirectory(SESSIONS_DIR);
  let messages = await readSessionJSON(sessionDir, `${id}.json`);
  const loadedPrimaryMessages = messages !== MISSING_SESSION_JSON;
  if (messages === MISSING_SESSION_JSON) {
    const legacyDir = await getDirectory(LEGACY_MESSAGES_DIR);
    messages = await readSessionJSON(legacyDir, `${id}.json`);
  }
  if (messages === MISSING_SESSION_JSON) messages = [];
  if (!Array.isArray(messages)) {
    throw new Error(`Session messages for ${id} must contain a JSON array`);
  }
  if (loadedPrimaryMessages) {
    sessionMessageWriteSnapshots.set(id, sessionMessageFingerprint(JSON.stringify(messages)));
  }
  return messages;
}

export function validateSessionRecoveryJournal(journal) {
  if (!isPlainObject(journal) || journal.version !== 1) {
    throw sessionRecoveryError('unsupported or missing version');
  }
  validateRecoverySessions(journal.baseline, 'baseline');
  validateRecoverySessions(journal.sessions, 'sessions');
  return journal;
}

export async function readSessionRecoveryJournal() {
  let file;
  try {
    file = await readPathBlob(SESSION_RECOVERY_FILE);
  } catch (error) {
    if (isMissingFileSystemEntry(error)) return null;
    throw error;
  }
  if (file.size > SESSION_RECOVERY_MAX_BYTES) {
    throw sessionRecoveryError(`file exceeds the ${SESSION_RECOVERY_MAX_BYTES}-byte limit`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw sessionRecoveryError('file is not valid UTF-8', error);
  }
  let journal;
  try {
    journal = JSON.parse(text);
  } catch (error) {
    throw sessionRecoveryError('file is not valid JSON', error);
  }
  return validateSessionRecoveryJournal(journal);
}

export async function writeSessionRecoveryJournal({ baseline, sessions }) {
  const journal = {
    version: 1,
    baseline,
    sessions,
  };
  validateSessionRecoveryJournal(journal);
  const text = JSON.stringify(journal);
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > SESSION_RECOVERY_MAX_BYTES) {
    throw sessionRecoveryError(`file exceeds the ${SESSION_RECOVERY_MAX_BYTES}-byte limit`);
  }
  await writePathText(SESSION_RECOVERY_FILE, text, { internal: true });
}

export async function clearSessionRecoveryJournal() {
  await deletePath(SESSION_RECOVERY_FILE, { internal: true });
}

/**
 * Load all sessions with their messages.
 * @returns {Promise<Array>}
 */
export async function loadSessions() {
  const root = await getRootDir();
  await ensureSessionWriteCacheRoot(root);
  const { sessions, loadedPrimaryIndex } = await loadSessionIndex(root);
  const sessionDir = await getDirectory(SESSIONS_DIR);
  let legacyDir = null;

  const loaded = new Array(sessions.length);
  let nextSessionIndex = 0;
  let loadError = null;
  const loadWorkers = Array.from(
    // file.text() and JSON.parse() temporarily hold both the serialized body
    // and parsed messages. Loading every session with Promise.all doubled the
    // peak for large histories, so keep that transient working set bounded.
    { length: Math.min(2, sessions.length) },
    async () => {
      while (!loadError && nextSessionIndex < sessions.length) {
        const index = nextSessionIndex;
        nextSessionIndex += 1;
        const session = sessions[index];
        try {
          let messages = await readSessionJSON(sessionDir, `${session.id}.json`);
          const loadedPrimaryMessages = messages !== MISSING_SESSION_JSON;
          if (messages === MISSING_SESSION_JSON) {
            legacyDir ||= await getDirectory(LEGACY_MESSAGES_DIR);
            messages = await readSessionJSON(legacyDir, `${session.id}.json`);
          }
          if (messages !== MISSING_SESSION_JSON && !Array.isArray(messages)) {
            throw new Error(`Session messages for ${session.id} must contain a JSON array`);
          }
          loaded[index] = {
            session: {
              ...session,
              messages: messages === MISSING_SESSION_JSON ? [] : messages,
            },
            loadedPrimaryMessages,
          };
        } catch (error) {
          loadError ||= error;
        }
      }
    }
  );
  await Promise.all(loadWorkers);
  if (loadError) throw loadError;

  sessionMetadataWriteSnapshot = loadedPrimaryIndex ? JSON.stringify(sessions) : null;
  sessionMessageWriteSnapshots.clear();
  for (const { session, loadedPrimaryMessages } of loaded) {
    if (loadedPrimaryMessages) {
      const serialized = JSON.stringify(session.messages || []);
      sessionMessageWriteSnapshots.set(String(session.id), sessionMessageFingerprint(serialized));
    }
  }
  return loaded.map(({ session }) => session);
}

/**
 * Save all sessions.
 * @param {Array} sessions - Array of session objects with messages
 */
export async function saveSessions(sessions) {
  const root = await getRootDir();
  await ensureSessionWriteCacheRoot(root);
  const sessionDir = await getDirectory(SESSIONS_DIR);
  const nextSessionsById = new Map();
  const nextMessagesById = new Map();

  for (const session of sessions) {
    if (session?.id != null) {
      const { messages: _messages, ...rest } = session;
      const id = String(session.id);
      nextSessionsById.set(id, rest);
      // Missing means this body was never loaded. Do not confuse it with an
      // explicitly empty conversation and overwrite the existing OPFS file.
      if (Object.prototype.hasOwnProperty.call(session, 'messages')) {
        nextMessagesById.set(id, session.messages || []);
      }
    }
  }

  const metadata = [...nextSessionsById.values()];
  const metadataSnapshot = JSON.stringify(metadata);
  const changedPaths = [];
  const metadataChanged = metadataSnapshot !== sessionMetadataWriteSnapshot;

  const messageEntries = [...nextMessagesById];
  const writtenMessageSnapshots = [];
  let nextIndex = 0;
  let firstError = null;
  const workers = Array.from(
    // Each worker temporarily owns a serialized conversation. Two workers
    // keep OPFS responsive without multiplying large image/chat bodies eightfold.
    { length: Math.min(2, messageEntries.length) },
    async () => {
      while (!firstError && nextIndex < messageEntries.length) {
        const index = nextIndex;
        nextIndex += 1;
        const [id, messages] = messageEntries[index];
        try {
          const serialized = JSON.stringify(messages);
          const fingerprint = sessionMessageFingerprint(serialized);
          if (fingerprint === sessionMessageWriteSnapshots.get(id)) continue;
          await writeSerializedJSON(sessionDir, `${id}.json`, serialized, { internal: true });
          changedPaths.push(`${SESSIONS_DIR}/${id}.json`);
          writtenMessageSnapshots.push([id, fingerprint]);
        } catch (err) {
          firstError ||= err;
        }
      }
    }
  );
  await Promise.all(workers);
  if (firstError) throw firstError;
  // Publish the index last. If the browser closes mid-save, an orphaned
  // message file is recoverable on retry; an index pointing at a missing new
  // message file would make that session appear empty and risk overwriting it.
  if (metadataChanged) {
    await writeJSON(root, SESSION_FILE, metadata, { internal: true });
    changedPaths.unshift(SESSION_FILE);
  }

  notifyOpfsMutation(changedPaths, 'write');
  if (changedPaths.includes(SESSION_FILE)) sessionMetadataWriteSnapshot = metadataSnapshot;
  for (const [id, fingerprint] of writtenMessageSnapshots) {
    sessionMessageWriteSnapshots.set(id, fingerprint);
  }
}

/**
 * Delete a session.
 * @param {Array} sessions - All sessions
 * @param {string} sessionId - ID of session to delete
 * @returns {Array} Remaining sessions
 */
export async function deleteSession(sessions, sessionId) {
  const root = await getRootDir();
  await ensureSessionWriteCacheRoot(root);
  const sessionDir = await getDirectory(SESSIONS_DIR);
  const existingSessions = (await readJSON(root, SESSION_FILE)) || [];
  const remainingById = new Map();

  for (const session of existingSessions) {
    if (session?.id != null && String(session.id) !== String(sessionId)) {
      remainingById.set(String(session.id), session);
    }
  }

  for (const session of sessions) {
    if (session?.id != null && String(session.id) !== String(sessionId)) {
      const { messages: _messages, ...rest } = session;
      remainingById.set(String(session.id), rest);
    }
  }

  const remaining = [...remainingById.values()];

  await writeJSON(
    root,
    SESSION_FILE,
    remaining,
    { localPath: SESSION_FILE }
  );
  try {
    if (await deleteEntry(sessionDir, `${sessionId}.json`)) {
      notifyOpfsMutation(`${SESSIONS_DIR}/${sessionId}.json`, 'delete');
    }
  } catch (error) {
    // The index write above is the deletion commit. A body that cannot be
    // cleaned immediately is an unreachable orphan; rejecting here would keep
    // the session in React and a later save could resurrect the index entry.
    console.warn(`Failed to clean deleted session body ${sessionId}:`, error);
  }
  try {
    const legacyDir = await getExistingDirectory(LEGACY_MESSAGES_DIR);
    if (await deleteEntry(legacyDir, `${sessionId}.json`)) {
      notifyOpfsMutation(`${LEGACY_MESSAGES_DIR}/${sessionId}.json`, 'delete');
    }
  } catch (error) {
    if (!isMissingFileSystemEntry(error)) {
      console.warn(`Failed to clean legacy deleted session body ${sessionId}:`, error);
    }
  }

  sessionMetadataWriteSnapshot = JSON.stringify(remaining);
  sessionMessageWriteSnapshots.delete(String(sessionId));
  return remaining;
}

/**
 * Clear all data.
 */
export async function clearAll() {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(ROOT_DIR, { recursive: true });
  } catch (error) {
    if (!isMissingFileSystemEntry(error)) throw error;
  }
  sessionMetadataWriteSnapshot = null;
  sessionMessageWriteSnapshots.clear();
  sessionWriteCacheRoot = null;
}

// ─── Export/Import ────────────────────────────────────────────────────────────

async function hasStoredSessionIndex(root) {
  for (const filename of SESSION_INDEX_FILES) {
    try {
      await root.getFileHandle(filename);
      return true;
    } catch (error) {
      if (!isMissingFileSystemEntry(error)) throw error;
    }
  }
  return false;
}

function canonicalSessionExport(sessions) {
  const metadata = [];
  const bodies = [];
  const ids = new Set();

  for (const session of sessions) {
    if (!isPlainObject(session) || !Object.prototype.hasOwnProperty.call(session, 'id')) {
      throw new ZipImportValidationError(
        'INVALID_CONTENT',
        'Stored session index contains a session without a safe object record',
        SESSION_FILE
      );
    }
    const id = validateSessionId(session.id, SESSION_FILE);
    if (ids.has(id)) {
      throw new ZipImportValidationError(
        'DUPLICATE_SESSION_ID',
        `Stored session index contains duplicate id "${id}"`,
        SESSION_FILE
      );
    }
    ids.add(id);
    validateSessionMessageArray(session.messages, `${SESSIONS_DIR}/${id}.json`);
    const { messages, ...sessionMetadata } = session;
    metadata.push(sessionMetadata);
    bodies.push({ id, messages });
  }

  return { metadata, bodies };
}

async function sessionExportSnapshot(root, options) {
  const hasIndex = await hasStoredSessionIndex(root);
  let storedSessions = null;
  let storedSessionError = null;

  if (hasIndex) {
    try {
      storedSessions = await loadSessions();
    } catch (error) {
      storedSessionError = error;
    }
  }

  if (options.materializeSessionRecovery === true) {
    const journal = await readSessionRecoveryJournal();
    if (journal) {
      const sessions = storedSessions == null
        ? journal.sessions
        : reconcileSessionRecoveryJournal(storedSessions, journal).sessions;
      return canonicalSessionExport(sessions);
    }
  }

  if (storedSessionError) throw storedSessionError;
  return storedSessions == null ? null : canonicalSessionExport(storedSessions);
}

function isRuntimeSessionStoragePath(path) {
  const normalized = normalizeLocalPath(path);
  const [topLevel] = normalized.split('/');
  return SESSION_INDEX_FILES.has(normalized)
    || topLevel === SESSIONS_DIR
    || topLevel === LEGACY_MESSAGES_DIR;
}

/**
 * Export all data to a zip file.
 * `materializeSessionRecovery` validates the private crash journal and writes
 * its recovered view as normal session index/body files; `.sync` itself is
 * never included in either export mode.
 * @param {{materializeSessionRecovery?: boolean}} [options]
 * @returns {Promise<Blob>}
 */
export async function exportToZip(options = {}) {
  const root = await getRootDir();
  const zip = new JSZip();
  const sessionSnapshot = await sessionExportSnapshot(root, options);

  async function collect(dir, prefix = '') {
    for (const { name, kind } of await listEntries(dir)) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (isInternalSyncPath(path)) continue;
      // Session indexes and bodies are emitted from one validated snapshot
      // below. Skipping their raw files prevents an unreachable body left by an
      // interrupted save or best-effort cleanup from poisoning the backup.
      if (isRuntimeSessionStoragePath(path)) continue;
      if (kind === 'file') {
        const file = await (await dir.getFileHandle(name)).getFile();
        zip.file(path, new Uint8Array(await file.arrayBuffer()));
      } else {
        await collect(await dir.getDirectoryHandle(name), path);
      }
    }
  }

  await collect(root);
  if (sessionSnapshot) {
    zip.file(SESSION_FILE, JSON.stringify(sessionSnapshot.metadata, null, 2), {
      createFolders: false,
    });
    for (const { id, messages } of sessionSnapshot.bodies) {
      zip.file(
        `${SESSIONS_DIR}/${id}.json`,
        JSON.stringify(messages, null, 2)
      );
    }
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

function zipImportLimit(value, hardLimit, name) {
  if (value == null) return hardLimit;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new ZipImportValidationError(
      'INVALID_LIMIT',
      `${name} must be a non-negative safe integer`
    );
  }
  // Callers may lower limits for more constrained environments, but cannot
  // raise the hard browser-safety caps.
  return Math.min(limit, hardLimit);
}

function zipImportLimits(options = {}) {
  return {
    maxEntries: zipImportLimit(options.maxEntries, ZIP_IMPORT_MAX_ENTRIES, 'maxEntries'),
    maxFileBytes: zipImportLimit(options.maxFileBytes, ZIP_IMPORT_MAX_FILE_BYTES, 'maxFileBytes'),
    maxTotalBytes: zipImportLimit(options.maxTotalBytes, ZIP_IMPORT_MAX_TOTAL_BYTES, 'maxTotalBytes'),
    maxArchiveBytes: zipImportLimit(
      options.maxArchiveBytes,
      ZIP_IMPORT_MAX_ARCHIVE_BYTES,
      'maxArchiveBytes'
    ),
  };
}

function zipPathError(code, path, reason) {
  return new ZipImportValidationError(code, `Unsafe ZIP entry path "${path}": ${reason}`, path);
}

function hasControlCharacter(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validateZipEntryPath(path, isDirectory, source = 'name') {
  if (typeof path !== 'string' || path.length === 0) {
    throw zipPathError('UNSAFE_PATH', String(path || ''), `${source} is empty`);
  }
  if (hasControlCharacter(path)) {
    throw zipPathError('UNSAFE_PATH', path, `${source} contains control characters`);
  }
  if (path.includes('\\')) {
    throw zipPathError('UNSAFE_PATH', path, `${source} contains backslashes`);
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw zipPathError('UNSAFE_PATH', path, `${source} is absolute`);
  }

  let comparablePath = path;
  if (isDirectory && comparablePath.endsWith('/')) comparablePath = comparablePath.slice(0, -1);
  if (!isDirectory && comparablePath.endsWith('/')) {
    throw zipPathError('UNSAFE_PATH', path, `${source} has a directory suffix`);
  }
  if (!comparablePath) {
    throw zipPathError('UNSAFE_PATH', path, `${source} does not name an entry`);
  }

  const parts = comparablePath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw zipPathError('UNSAFE_PATH', path, `${source} contains empty or traversal components`);
  }
  if (parts[0].toLowerCase() === SYNC_DIR) {
    throw new ZipImportValidationError(
      'RESERVED_PATH',
      `ZIP entry targets the reserved ${SYNC_DIR} namespace: ${path}`,
      path
    );
  }
  const encoder = new TextEncoder();
  if (encoder.encode(comparablePath).byteLength > ZIP_IMPORT_MAX_PATH_BYTES) {
    throw zipPathError('UNSAFE_PATH', path, 'path is too long');
  }
  if (parts.length > ZIP_IMPORT_MAX_PATH_DEPTH) {
    throw zipPathError('UNSAFE_PATH', path, 'path is too deeply nested');
  }
  if (parts.some((part) => encoder.encode(part).byteLength > ZIP_IMPORT_MAX_SEGMENT_BYTES)) {
    throw zipPathError('UNSAFE_PATH', path, 'path component is too long');
  }
  return parts.join('/');
}

function declaredZipEntrySize(file, path) {
  const value = file?._data?.uncompressedSize;
  if (value == null) return null;
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new ZipImportValidationError(
      'INVALID_SIZE',
      `ZIP entry has an invalid uncompressed size: ${path}`,
      path
    );
  }
  return size;
}

function zipSizeError(code, path, size, limit, label) {
  return new ZipImportValidationError(
    code,
    `ZIP ${label} exceeds the ${limit} byte limit at "${path}" (${size} bytes)`,
    path
  );
}

function readZipEntryBytes(file, path, declaredSize, acceptedBytes, limits) {
  const maximumForEntry = Math.min(limits.maxFileBytes, limits.maxTotalBytes - acceptedBytes);
  const initialSize = declaredSize ?? 0;

  return new Promise((resolve, reject) => {
    const helper = file.internalStream('uint8array');
    let output = new Uint8Array(initialSize);
    let total = 0;
    let settled = false;

    function finishWithError(error) {
      if (settled) return;
      settled = true;
      output = null;
      helper.pause();
      reject(error);
      // Pausing stops decompression promptly for archives whose central-directory
      // size is false or missing. JSZip does not expose a public cancel method.
    }

    helper
      .on('data', (chunk) => {
        if (settled) return;
        const bytes = chunk instanceof Uint8Array
          ? chunk
          : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        const nextTotal = total + bytes.byteLength;
        if (nextTotal > limits.maxFileBytes) {
          finishWithError(zipSizeError(
            'FILE_TOO_LARGE', path, nextTotal, limits.maxFileBytes, 'entry'
          ));
          return;
        }
        if (acceptedBytes + nextTotal > limits.maxTotalBytes) {
          finishWithError(zipSizeError(
            'TOTAL_TOO_LARGE', path, acceptedBytes + nextTotal, limits.maxTotalBytes, 'content'
          ));
          return;
        }
        if (nextTotal > maximumForEntry) {
          finishWithError(zipSizeError(
            'TOTAL_TOO_LARGE', path, acceptedBytes + nextTotal, limits.maxTotalBytes, 'content'
          ));
          return;
        }
        if (nextTotal > output.byteLength) {
          const expanded = new Uint8Array(Math.min(
            maximumForEntry,
            Math.max(nextTotal, Math.max(1, output.byteLength * 2))
          ));
          expanded.set(output.subarray(0, total));
          output = expanded;
        }
        output.set(bytes, total);
        total = nextTotal;
      })
      .on('error', (error) => finishWithError(error))
      .on('end', () => {
        if (settled) return;
        if (declaredSize != null && total !== declaredSize) {
          finishWithError(new ZipImportValidationError(
            'SIZE_MISMATCH',
            `ZIP entry uncompressed size does not match its metadata: ${path}`,
            path
          ));
          return;
        }
        settled = true;
        resolve(output.subarray(0, total));
      })
      .resume();
  });
}

function validateSessionId(value, path) {
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) {
    throw new ZipImportValidationError(
      'UNSAFE_SESSION_ID',
      `Session id must be a string or safe integer in ZIP entry: ${path}`,
      path
    );
  }
  const id = String(value);
  if (
    !id
    || id !== id.trim()
    || id === '.'
    || id === '..'
    || id.includes('/')
    || id.includes('\\')
    || hasControlCharacter(id)
    || new TextEncoder().encode(id).byteLength > MAX_SESSION_ID_BYTES
  ) {
    throw new ZipImportValidationError(
      'UNSAFE_SESSION_ID',
      `Session id cannot be represented safely as an OPFS file name in ZIP entry: ${path}`,
      path
    );
  }
  return id;
}

function validateSessionMessageArray(messages, path) {
  if (!Array.isArray(messages) || messages.some((message) => !isPlainObject(message))) {
    throw new ZipImportValidationError(
      'INVALID_CONTENT',
      `Session message data must be an array of objects in ZIP entry: ${path}`,
      path
    );
  }
}

function sessionBodyId(path) {
  const parts = path.split('/');
  if (![SESSIONS_DIR, LEGACY_MESSAGES_DIR].includes(parts[0])) return null;
  if (parts.length !== 2 || !parts[1].endsWith('.json')) {
    throw new ZipImportValidationError(
      'INVALID_SESSION_PATH',
      `Session storage contains an unsupported ZIP entry path: ${path}`,
      path
    );
  }
  const filenameId = parts[1].slice(0, -'.json'.length);
  return validateSessionId(filenameId, path);
}

function validatePreparedMergeableEntry(path, bytes) {
  const bodyId = sessionBodyId(path);
  if (!shouldMergeIncomingFile(path) && bodyId == null) return null;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ZipImportValidationError(
      'INVALID_CONTENT',
      `ZIP entry is not valid UTF-8 text: ${path}`,
      path
    );
  }
  const data = parseMergeableFile(path, text);
  const expectsArray = [
    'session.json',
    'chat.json',
    'chats.json',
  ].includes(path) || /^(sessions|messages)\/[^/]+\.json$/.test(path);
  const valid = expectsArray ? Array.isArray(data) : isPlainObject(data);
  if (!valid) {
    throw new ZipImportValidationError(
      'INVALID_CONTENT',
      `ZIP entry has invalid structured content: ${path}`,
      path
    );
  }
  if (bodyId != null) validateSessionMessageArray(data, path);
  return SESSION_INDEX_FILES.has(path) || bodyId != null ? data : null;
}

function validatePreparedSessionData(prepared) {
  const indexedIds = new Set();
  const bodyIds = new Set();
  let hasSessionIndex = false;

  for (const entry of prepared) {
    if (SESSION_INDEX_FILES.has(entry.path)) {
      hasSessionIndex = true;
      const idsInIndex = new Set();
      for (const session of entry.structuredData) {
        if (!isPlainObject(session)) {
          throw new ZipImportValidationError(
            'INVALID_CONTENT',
            `Session index entries must be objects in ZIP entry: ${entry.path}`,
            entry.path
          );
        }
        if (!Object.prototype.hasOwnProperty.call(session, 'id')) {
          throw new ZipImportValidationError(
            'UNSAFE_SESSION_ID',
            `Session index entry is missing an id in ZIP entry: ${entry.path}`,
            entry.path
          );
        }
        const id = validateSessionId(session.id, entry.path);
        if (idsInIndex.has(id)) {
          throw new ZipImportValidationError(
            'DUPLICATE_SESSION_ID',
            `Session index contains duplicate id "${id}" in ZIP entry: ${entry.path}`,
            entry.path
          );
        }
        idsInIndex.add(id);
        indexedIds.add(id);
        if (Object.prototype.hasOwnProperty.call(session, 'messages')) {
          validateSessionMessageArray(session.messages, entry.path);
        }
      }
      continue;
    }

    const id = sessionBodyId(entry.path);
    if (id != null) bodyIds.add(id);
  }

  if (bodyIds.size > 0 && !hasSessionIndex) {
    const [id] = bodyIds;
    throw new ZipImportValidationError(
      'INCONSISTENT_SESSION_DATA',
      `Session message body "${id}" has no session index in the ZIP archive`
    );
  }
  for (const id of indexedIds) {
    if (!bodyIds.has(id)) {
      throw new ZipImportValidationError(
        'INCONSISTENT_SESSION_DATA',
        `Session index id "${id}" has no matching message body in the ZIP archive`
      );
    }
  }
  for (const id of bodyIds) {
    if (!indexedIds.has(id)) {
      throw new ZipImportValidationError(
        'INCONSISTENT_SESSION_DATA',
        `Session message body "${id}" has no matching index entry in the ZIP archive`
      );
    }
  }
}

async function preflightZipImport(zip, options = {}) {
  const limits = zipImportLimits(options);
  const rawEntries = Object.entries(zip.files);
  if (rawEntries.length > limits.maxEntries) {
    throw new ZipImportValidationError(
      'TOO_MANY_ENTRIES',
      `ZIP contains ${rawEntries.length} entries; the limit is ${limits.maxEntries}`
    );
  }

  const entries = [];
  const pathKinds = new Map();
  let declaredTotal = 0;

  // Validate every name and all declared sizes before decompressing anything.
  for (const [path, file] of rawEntries) {
    const normalizedPath = validateZipEntryPath(path, file.dir, 'name');
    const fileNamePath = validateZipEntryPath(file.name, file.dir, 'file name');
    if (normalizedPath !== fileNamePath) {
      throw zipPathError('UNSAFE_PATH', path, 'JSZip entry names disagree');
    }
    if (file.unsafeOriginalName != null) {
      validateZipEntryPath(file.unsafeOriginalName, file.dir, 'unsafeOriginalName');
    }

    const kind = file.dir ? 'directory' : 'file';
    const existingKind = pathKinds.get(normalizedPath);
    if (existingKind && existingKind !== kind) {
      throw zipPathError('PATH_CONFLICT', path, 'the same path is both a file and directory');
    }
    pathKinds.set(normalizedPath, kind);

    if (file.dir) continue;
    const declaredSize = declaredZipEntrySize(file, normalizedPath);
    if (declaredSize != null && declaredSize > limits.maxFileBytes) {
      throw zipSizeError(
        'FILE_TOO_LARGE', normalizedPath, declaredSize, limits.maxFileBytes, 'entry'
      );
    }
    if (declaredSize != null) {
      declaredTotal += declaredSize;
      if (declaredTotal > limits.maxTotalBytes) {
        throw zipSizeError(
          'TOTAL_TOO_LARGE', normalizedPath, declaredTotal, limits.maxTotalBytes, 'content'
        );
      }
    }
    entries.push({ path: normalizedPath, file, declaredSize });
  }

  const filePaths = new Set(entries.map((entry) => entry.path));
  for (const path of filePaths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const ancestor = parts.slice(0, i).join('/');
      if (filePaths.has(ancestor)) {
        throw zipPathError('PATH_CONFLICT', path, `file ancestor "${ancestor}" blocks the path`);
      }
    }
  }

  // Decompress and verify all actual sizes before opening OPFS for writes.
  const prepared = [];
  let actualTotal = 0;
  for (const entry of entries) {
    const bytes = await readZipEntryBytes(
      entry.file,
      entry.path,
      entry.declaredSize,
      actualTotal,
      limits
    );
    const structuredData = validatePreparedMergeableEntry(entry.path, bytes);
    actualTotal += bytes.byteLength;
    prepared.push({ path: entry.path, bytes, structuredData });
  }
  validatePreparedSessionData(prepared);
  return prepared;
}

function isFileSystemTypeMismatch(error) {
  return error?.name === 'TypeMismatchError'
    || /is not a (?:file|directory)/i.test(String(error?.message || ''));
}

async function validateImportDestinationPaths(preparedEntries) {
  const root = await getRootDir();
  for (const { path } of preparedEntries) {
    const parts = path.split('/');
    const fileName = parts.pop();
    let dir = root;
    let parentMissing = false;
    for (const part of parts) {
      try {
        dir = await dir.getDirectoryHandle(part);
      } catch (error) {
        if (isFileSystemTypeMismatch(error)) {
          throw new ZipImportValidationError(
            'PATH_CONFLICT',
            `Existing file blocks ZIP path: ${path}`,
            path
          );
        }
        if (isMissingFileSystemEntry(error)) {
          parentMissing = true;
          break;
        }
        throw error;
      }
    }
    if (parentMissing) continue;
    try {
      await dir.getDirectoryHandle(fileName);
      throw new ZipImportValidationError(
        'PATH_CONFLICT',
        `Existing directory blocks ZIP file: ${path}`,
        path
      );
    } catch (error) {
      if (error instanceof ZipImportValidationError) throw error;
      if (isMissingFileSystemEntry(error) || isFileSystemTypeMismatch(error)) continue;
      throw error;
    }
  }
}

/**
 * Import data from a zip file.
 * @param {Blob} blob
 */
export async function importFromZip(blob, options = {}) {
  const limits = zipImportLimits(options);
  const archiveBytes = typeof Blob !== 'undefined' && blob instanceof Blob
    ? blob.size
    : (blob?.byteLength ?? null);
  if (
    archiveBytes != null
    && (!Number.isSafeInteger(Number(archiveBytes)) || Number(archiveBytes) > limits.maxArchiveBytes)
  ) {
    throw new ZipImportValidationError(
      'ARCHIVE_TOO_LARGE',
      `ZIP archive exceeds the ${limits.maxArchiveBytes} byte compressed-input limit`
    );
  }
  const zipInput = typeof Blob !== 'undefined' && blob instanceof Blob
    ? await blob.arrayBuffer()
    : blob;
  const zip = await JSZip.loadAsync(zipInput);
  const preparedEntries = await preflightZipImport(zip, { ...options, ...limits });
  await validateImportDestinationPaths(preparedEntries);
  const importedPaths = [];

  try {
    // Message bodies precede their indexes so an interrupted import cannot
    // expose a new session whose message file has not been written yet.
    const orderedEntries = [...preparedEntries].sort((left, right) => {
      const indexWeight = (path) => (
        ['session.json', 'chat.json', 'chats.json'].includes(path) ? 1 : 0
      );
      return indexWeight(left.path) - indexWeight(right.path);
    });
    for (const { path, bytes } of orderedEntries) {
      const parts = path.split('/');
      const fileName = parts.pop();
      const dir = await getDirectory(...parts);
      if (shouldMergeIncomingFile(path)) {
        await writeIncomingText(
          dir,
          fileName,
          new TextDecoder().decode(bytes),
          path,
          { internal: true }
        );
      } else {
        await writeText(dir, fileName, bytes, { internal: true });
      }
      importedPaths.push(path);
    }
  } finally {
    // A quota or I/O failure can still occur after preflight. Always expose
    // completed writes so caches and sync state cannot silently miss them.
    notifyOpfsMutation(importedPaths, 'write');
  }
}

// ─── File Manager Operations ──────────────────────────────────────────────────

/**
 * Load files from a directory (depth 1).
 * @param {string} [dirName] - Directory name relative to root (undefined for root)
 * @returns {Promise<{id: string, name: string, type: string, children: Array}|Array>}
 */
export async function loadFiles(dirName) {
  const dir = dirName ? await getDirectory(...dirName.split('/')) : await getRootDir();
  const children = [];

  for (const { name, kind } of await listEntries(dir)) {
    if (kind === 'file') {
      const file = await (await dir.getFileHandle(name)).getFile();
      children.push({
        id: `file-${dirName || 'root'}-${name}`,
        name,
        type: 'file',
        size: file.size,
        lastModified: file.lastModified,
        fileName: name,
        category: dirName || 'root',
        parentDir: dirName,
      });
    } else {
      const subdir = await dir.getDirectoryHandle(name);
      const subChildren = [];
      for (const { name: subName, kind: subKind } of await listEntries(subdir)) {
        if (subKind === 'file') {
          const subFile = await (await subdir.getFileHandle(subName)).getFile();
          subChildren.push({
            id: `file-${dirName ? `${dirName}/${name}` : name}-${subName}`,
            name: subName,
            type: 'file',
            size: subFile.size,
            lastModified: subFile.lastModified,
            fileName: subName,
            category: dirName ? `${dirName}/${name}` : name,
            parentDir: dirName ? `${dirName}/${name}` : name,
          });
        } else {
          subChildren.push({
            id: `dir-${dirName ? `${dirName}/${name}` : name}-${subName}`,
            name: subName,
            type: 'directory',
            children: [],
            parentDir: dirName ? `${dirName}/${name}` : name,
          });
        }
      }
      children.push({
        id: `dir-${dirName || 'root'}-${name}`,
        name,
        type: 'directory',
        children: subChildren,
        parentDir: dirName,
      });
    }
  }

  // Return tree structure for root, array for subdirectories
  return dirName
    ? children
    : { id: 'root', name: '/', type: 'directory', children };
}

/**
 * Load contents of a directory (alias for loadFiles with dirName).
 * @param {string} dirName - Directory name relative to root
 * @returns {Promise<Array>}
 */

/**
 * Save a file to a directory.
 * @param {string} fileName - Name of the file
 * @param {Blob} blob - The file blob
 * @param {string} [dirName] - Directory name relative to root (undefined for 'files' default)
 */
export async function saveFile(fileName, blob, dirName) {
  const dir = dirName === null
    ? await getRootDir()
    : dirName
    ? await getDirectory(...pathParts(dirName))
    : await getDirectory('files');
  const localPath = dirName === null ? fileName : dirName ? `${normalizeLocalPath(dirName)}/${fileName}` : `files/${fileName}`;
  await writeText(dir, fileName, blob, { localPath });
}

/**
 * Delete a file or directory.
 * @param {string} fileName
 * @param {string} category - 'root', 'sessions', 'uploads', or directory path (e.g. 'folder/subfolder')
 * @param {boolean} isDirectory - whether to delete recursively
 */
export async function deleteFile(fileName, category, isDirectory = false) {
  const dir =
    category === 'root' || category === null
      ? await getRootDir()
      : category === 'sessions'
      ? await getDirectory('sessions')
      : category === 'messages'
      ? await getDirectory('messages')
      : category === 'files'
      ? await getDirectory('files')
      : category
      ? await getDirectory(...category.split('/').filter(Boolean))
      : await getDirectory('files');

  await dir.removeEntry(fileName, { recursive: isDirectory });
  const localPath = category === 'root' || category === null
    ? fileName
    : category ? `${normalizeLocalPath(category)}/${fileName}` : `files/${fileName}`;
  notifyOpfsMutation(localPath, 'delete');
}

async function localEntryExists(dirHandle, name) {
  try {
    await dirHandle.getFileHandle(name);
    return true;
  } catch { /* ignore */ }

  try {
    await dirHandle.getDirectoryHandle(name);
    return true;
  } catch { /* ignore */ }

  return false;
}

async function copyLocalDirectory(sourceDir, targetDir) {
  for (const { name, kind } of await listEntries(sourceDir)) {
    if (kind === 'directory') {
      const sourceChild = await sourceDir.getDirectoryHandle(name);
      const targetChild = await targetDir.getDirectoryHandle(name, { create: true });
      await copyLocalDirectory(sourceChild, targetChild);
      continue;
    }

    const file = await (await sourceDir.getFileHandle(name)).getFile();
    await writeText(targetDir, name, file, { internal: true });
  }
}

/**
 * Move a file or directory to an existing target directory.
 * @param {string} sourcePath - Path relative to OPFS root
 * @param {string} targetDirName - Target directory path relative to OPFS root
 * @param {boolean} isDirectory - Whether the source is a directory
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function moveFile(sourcePath, targetDirName, isDirectory = false) {
  const safeSourcePath = normalizeLocalPath(sourcePath);
  const safeTargetDir = normalizeLocalPath(targetDirName);
  const sourceParts = pathParts(safeSourcePath);
  const sourceName = sourceParts.pop();

  if (!sourceName) throw new Error('Source path is required');

  const sourceParentPath = sourceParts.join('/');
  if (sourceParentPath === safeTargetDir) {
    return { success: true, message: 'Already in target directory' };
  }

  if (isDirectory && (safeTargetDir === safeSourcePath || safeTargetDir.startsWith(`${safeSourcePath}/`))) {
    throw new Error('Cannot move a directory into itself');
  }

  const targetPath = normalizeLocalPath(safeTargetDir ? `${safeTargetDir}/${sourceName}` : sourceName);
  if (targetPath === safeSourcePath) {
    return { success: true, message: 'Already in target directory' };
  }

  const sourceParent = sourceParts.length > 0
    ? await getExistingDirectory(...sourceParts)
    : await getRootDir();
  const targetParent = safeTargetDir
    ? await getExistingDirectory(...pathParts(safeTargetDir))
    : await getRootDir();

  if (await localEntryExists(targetParent, sourceName)) {
    throw new Error('Destination already exists');
  }

  let targetCreated = false;
  try {
    if (isDirectory) {
      const sourceDir = await sourceParent.getDirectoryHandle(sourceName);
      const targetDir = await targetParent.getDirectoryHandle(sourceName, { create: true });
      targetCreated = true;
      await copyLocalDirectory(sourceDir, targetDir);
      await sourceParent.removeEntry(sourceName, { recursive: true });
      notifyOpfsMutation(safeSourcePath, 'delete');
      notifyOpfsMutation(targetPath, 'mkdir');
      return { success: true, message: 'Directory moved' };
    }

    const file = await (await sourceParent.getFileHandle(sourceName)).getFile();
    await writeText(targetParent, sourceName, file, { internal: true });
    targetCreated = true;
    await sourceParent.removeEntry(sourceName);
    notifyOpfsMutation(safeSourcePath, 'delete');
    notifyOpfsMutation(targetPath, 'write');
    return { success: true, message: 'File moved' };
  } catch (err) {
    if (targetCreated) {
      try { await targetParent.removeEntry(sourceName, { recursive: true }); } catch { /* ignore cleanup */ }
    }
    throw err;
  }
}

/**
 * Get a file as Blob.
 * @param {string} fileName
 * @param {string} category - 'root', 'sessions', 'uploads', or directory name
 * @returns {Promise<Blob>}
 */
export async function getFileBlob(fileName, category) {
  const dir =
    category === 'root' || category === null
      ? await getRootDir()
      : category === 'sessions'
      ? await getDirectory('sessions')
      : category === 'messages'
      ? await getDirectory('messages')
      : category === 'files'
      ? await getDirectory('files')
      : category
      ? await getDirectory(...pathParts(category))
      : await getDirectory('files');

  const fileHandle = await dir.getFileHandle(fileName);
  return fileHandle.getFile();
}

/**
 * Create a new file in a directory.
 * @param {string} fileName - Name of the file to create
 * @param {string} [dirName] - Directory name relative to root (undefined for root)
 * @returns {Promise<void>}
 */
export async function createFile(fileName, dirName) {
  const dir = dirName ? await getDirectory(...pathParts(dirName)) : await getRootDir();
  await writeText(dir, fileName, '', { localPath: dirName ? `${normalizeLocalPath(dirName)}/${fileName}` : fileName });
}

/**
 * Create a new directory.
 * @param {string} dirName - Name of the directory to create
 * @param {string} [parentDirName] - Parent directory name relative to root (undefined for root)
 * @returns {Promise<void>}
 */
export async function createDirectory(dirName, parentDirName) {
  const parentDir = parentDirName ? await getDirectory(...pathParts(parentDirName)) : await getRootDir();
  await parentDir.getDirectoryHandle(dirName, { create: true });
  notifyOpfsMutation(parentDirName ? `${normalizeLocalPath(parentDirName)}/${dirName}` : dirName, 'mkdir');
}

/**
 * Read text content from a file.
 * @param {string} fileName - Name of the file to read
 * @param {string} [dirName] - Directory name relative to root (undefined for root)
 * @returns {Promise<string>}
 */
export async function readFileContent(fileName, dirName) {
  const dir = dirName ? await getDirectory(...pathParts(dirName)) : await getRootDir();
  const fileHandle = await dir.getFileHandle(fileName);
  const file = await fileHandle.getFile();
  return await file.text();
}

/**
 * Save text content to a file.
 * @param {string} fileName - Name of the file to save
 * @param {string} content - Text content to save
 * @param {string} [dirName] - Directory name relative to root (undefined for root)
 * @returns {Promise<void>}
 */
export async function saveFileContent(fileName, content, dirName) {
  const dir = dirName ? await getDirectory(...pathParts(dirName)) : await getRootDir();
  await writeText(dir, fileName, content, { localPath: dirName ? `${normalizeLocalPath(dirName)}/${fileName}` : fileName });
}

// ─── Memory Operations ────────────────────────────────────────────────────────

const MEMORY_DIR = 'memory';
const MEMORY_FILE = 'MEMORY.md';
const USER_FILE = 'USER.md';

/**
 * Read a memory file from OPFS.
 * @param {string} filename - MEMORY.md or USER.md
 * @returns {Promise<string>}
 */
export async function readMemoryFile(filename) {
  try {
    const dir = await getDirectory(MEMORY_DIR);
    return await readText(dir, filename);
  } catch {
    return null;
  }
}

/**
 * Write a memory file to OPFS (overwrite).
 * @param {string} filename - MEMORY.md or USER.md
 * @param {string} content
 */
export async function writeMemoryFile(filename, content) {
  const dir = await getDirectory(MEMORY_DIR);
  await writeText(dir, filename, content, { localPath: `${MEMORY_DIR}/${filename}` });
}

/**
 * Delete a memory file.
 * @param {string} filename - MEMORY.md or USER.md
 */
export async function deleteMemoryFile(filename) {
  try {
    const dir = await getDirectory(MEMORY_DIR);
    if (await deleteEntry(dir, filename)) {
      notifyOpfsMutation(`${MEMORY_DIR}/${filename}`, 'delete');
    }
  } catch (error) {
    if (!isMissingFileSystemEntry(error)) throw error;
  }
}

// ─── Skill Operations ─────────────────────────────────────────────────────────

const SKILLS_DIR = 'skills';

/**
 * List all skill directories.
 * @returns {Promise<Array<{ name: string, hasReferences: boolean }>>}
 */
export async function listSkillDirs() {
  try {
    const dir = await getDirectory(SKILLS_DIR);
    const skills = [];
    for (const { name, kind } of await listEntries(dir)) {
      if (kind === 'directory') {
        const skillDir = await dir.getDirectoryHandle(name);
        let hasReferences = false;
        for (const entry of await listEntries(skillDir)) {
          if (entry.name === 'references' && entry.kind === 'directory') {
            hasReferences = true;
            break;
          }
        }
        skills.push({ name, hasReferences });
      }
    }
    return skills;
  } catch {
    return [];
  }
}

/**
 * Read a file from a skill directory.
 * @param {string} skillName - Skill directory name
 * @param {string} filename - File to read (e.g., SKILL.md)
 * @returns {Promise<string|null>}
 */
export async function readSkillFile(skillName, filename) {
  try {
    const dir = await getDirectory(SKILLS_DIR, skillName);
    return await readText(dir, filename);
  } catch {
    return null;
  }
}

/**
 * Write a file to a skill directory.
 * @param {string} skillName - Skill directory name
 * @param {string} filename - File to write (e.g., SKILL.md)
 * @param {string} content
 */
export async function writeSkillFile(skillName, filename, content) {
  const dir = await getDirectory(SKILLS_DIR, skillName);
  await writeText(dir, filename, content, { localPath: `${SKILLS_DIR}/${skillName}/${filename}` });
}

/**
 * Delete a skill directory.
 * @param {string} skillName
 */
export async function deleteSkillDir(skillName) {
  try {
    const dir = await getDirectory(SKILLS_DIR);
    await dir.removeEntry(skillName, { recursive: true });
    notifyOpfsMutation(`${SKILLS_DIR}/${skillName}`, 'delete');
  } catch (error) {
    if (!isMissingFileSystemEntry(error)) throw error;
  }
}

/**
 * List files in a skill's references directory.
 * @param {string} skillName
 * @returns {Promise<Array<{ name: string }>>}
 */
export async function listSkillRefs(skillName) {
  try {
    const dir = await getDirectory(SKILLS_DIR, skillName, 'references');
    const refs = [];
    for (const { name, kind } of await listEntries(dir)) {
      if (kind === 'file') refs.push({ name });
    }
    return refs;
  } catch {
    return [];
  }
}

/**
 * Read a reference file from a skill.
 * @param {string} skillName
 * @param {string} filename
 * @returns {Promise<string|null>}
 */
export async function readSkillRef(skillName, filename) {
  try {
    const dir = await getDirectory(SKILLS_DIR, skillName, 'references');
    return await readText(dir, filename);
  } catch {
    return null;
  }
}

/**
 * Write a reference file in a skill.
 * @param {string} skillName
 * @param {string} filename
 * @param {string} content
 */
export async function writeSkillRef(skillName, filename, content) {
  const dir = await getDirectory(SKILLS_DIR, skillName, 'references');
  await writeText(dir, filename, content, { localPath: `${SKILLS_DIR}/${skillName}/references/${filename}` });
}

// ─── Agent Workspace Operations ───────────────────────────────────────────────

const WORKSPACE_DIR = 'workspace';

/**
 * Resolve the workspace directory name for an agent (uses the stable agent ID).
 * @param {string} agentId
 * @returns {Promise<string>}
 */
async function resolveWorkspaceName(agentId) {
  try {
    return await getWorkspaceDirName(agentId);
  } catch {
    return agentId;
  }
}

/**
 * Get a directory handle within an agent's workspace.
 * @param {string} agentId
 * @param  {...string} pathParts
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function getAgentDir(agentId, ...pathParts) {
  const name = await resolveWorkspaceName(agentId);
  return getDirectory(WORKSPACE_DIR, name, ...pathParts);
}

async function getExistingAgentDir(agentId, ...pathParts) {
  const name = await resolveWorkspaceName(agentId);
  return getExistingDirectory(WORKSPACE_DIR, name, ...pathParts);
}

/**
 * Get the memory directory for an agent.
 * @param {string} agentId
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function getAgentMemoryDir(agentId) {
  const name = await resolveWorkspaceName(agentId);
  return getDirectory(WORKSPACE_DIR, name, 'memory');
}

/**
 * Get the skills directory for an agent.
 * @param {string} agentId
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function getAgentSkillsDir(agentId) {
  const name = await resolveWorkspaceName(agentId);
  return getDirectory(WORKSPACE_DIR, name, 'skills');
}

/**
 * Get the files directory for an agent.
 * @param {string} agentId
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function getAgentFilesDir(agentId) {
  const name = await resolveWorkspaceName(agentId);
  return getDirectory(WORKSPACE_DIR, name, 'files');
}

/**
 * Read the agent's AGENTS.md identity file.
 * @param {string} agentId
 * @returns {Promise<string|null>}
 */
export async function readAgentAgentsFile(agentId) {
  try {
    const dir = await getAgentDir(agentId);
    return await readText(dir, 'AGENTS.md');
  } catch {
    return null;
  }
}

/**
 * Write the agent's AGENTS.md identity file.
 * @param {string} agentId
 * @param {string} content
 */
export async function writeAgentAgentsFile(agentId, content) {
  const dir = await getAgentDir(agentId);
  const name = await resolveWorkspaceName(agentId);
  await writeText(dir, 'AGENTS.md', content, { localPath: `${WORKSPACE_DIR}/${name}/AGENTS.md` });
}

// Agent-scoped memory operations

export async function readAgentMemoryFile(agentId, filename) {
  try {
    const dir = await getAgentMemoryDir(agentId);
    return await readText(dir, filename);
  } catch {
    return null;
  }
}

export async function writeAgentMemoryFile(agentId, filename, content) {
  const dir = await getAgentMemoryDir(agentId);
  const name = await resolveWorkspaceName(agentId);
  await writeText(dir, filename, content, { localPath: `${WORKSPACE_DIR}/${name}/memory/${filename}` });
}

export async function deleteAgentMemoryFile(agentId, filename) {
  try {
    const dir = await getAgentMemoryDir(agentId);
    if (await deleteEntry(dir, filename)) {
      const name = await resolveWorkspaceName(agentId);
      notifyOpfsMutation(`${WORKSPACE_DIR}/${name}/memory/${filename}`, 'delete');
    }
  } catch (error) {
    if (!isMissingFileSystemEntry(error)) throw error;
  }
}

// Agent-scoped skill operations

export async function listAgentSkillDirs(agentId) {
  try {
    const dir = await getAgentSkillsDir(agentId);
    const skills = [];
    for (const { name, kind } of await listEntries(dir)) {
      if (kind === 'directory') {
        const skillDir = await dir.getDirectoryHandle(name);
        let hasReferences = false;
        for (const entry of await listEntries(skillDir)) {
          if (entry.name === 'references' && entry.kind === 'directory') {
            hasReferences = true;
            break;
          }
        }
        skills.push({ name, hasReferences });
      }
    }
    return skills;
  } catch {
    return [];
  }
}

export async function readAgentSkillFile(agentId, skillName, filename) {
  try {
    const dir = await getAgentSkillsDir(agentId);
    const skillDir = await dir.getDirectoryHandle(skillName);
    return await readText(skillDir, filename);
  } catch {
    return null;
  }
}

export async function writeAgentSkillFile(agentId, skillName, filename, content) {
  return withAgentWorkspaceMutation(agentId, 'skills', async () => {
    const dir = await getAgentSkillsDir(agentId);
    const skillDir = await dir.getDirectoryHandle(skillName, { create: true });
    const name = await resolveWorkspaceName(agentId);
    await writeText(skillDir, filename, content, { localPath: `${WORKSPACE_DIR}/${name}/skills/${skillName}/${filename}` });
  });
}

export async function deleteAgentSkillDir(agentId, skillName) {
  return withAgentWorkspaceMutation(agentId, 'skills', async () => {
    try {
      const dir = await getAgentSkillsDir(agentId);
      await dir.removeEntry(skillName, { recursive: true });
      const name = await resolveWorkspaceName(agentId);
      notifyOpfsMutation(`${WORKSPACE_DIR}/${name}/skills/${skillName}`, 'delete');
    } catch (error) {
      if (!isMissingFileSystemEntry(error)) throw error;
    }
  });
}

export async function listAgentSkillRefs(agentId, skillName) {
  try {
    const dir = await getAgentSkillsDir(agentId);
    const skillDir = await dir.getDirectoryHandle(skillName);
    const refsDir = await skillDir.getDirectoryHandle('references');
    const refs = [];
    for (const { name, kind } of await listEntries(refsDir)) {
      if (kind === 'file') refs.push({ name });
    }
    return refs;
  } catch {
    return [];
  }
}

export async function readAgentSkillRef(agentId, skillName, filename) {
  try {
    const dir = await getAgentSkillsDir(agentId);
    const skillDir = await dir.getDirectoryHandle(skillName);
    const refsDir = await skillDir.getDirectoryHandle('references');
    return await readText(refsDir, filename);
  } catch {
    return null;
  }
}

export async function writeAgentSkillRef(agentId, skillName, filename, content) {
  return withAgentWorkspaceMutation(agentId, 'skills', async () => {
    const dir = await getAgentSkillsDir(agentId);
    const skillDir = await dir.getDirectoryHandle(skillName, { create: true });
    const refsDir = await skillDir.getDirectoryHandle('references', { create: true });
    const name = await resolveWorkspaceName(agentId);
    await writeText(refsDir, filename, content, { localPath: `${WORKSPACE_DIR}/${name}/skills/${skillName}/references/${filename}` });
  });
}

export async function listAgentSkillFiles(agentId, path = '') {
  const safePath = normalizeWorkspaceRelativePath(path, { allowEmpty: true });
  const dir = safePath
    ? await getExistingAgentDir(agentId, 'skills', ...pathParts(safePath))
    : await getExistingAgentDir(agentId, 'skills');
  const children = [];
  for (const { name, kind } of await listEntries(dir)) {
    if (kind === 'file') {
      const file = await (await dir.getFileHandle(name)).getFile();
      children.push({
        id: `skill-file-${agentId}-${safePath ? `${safePath}/` : ''}${name}`,
        name,
        type: 'file',
        size: file.size,
        lastModified: file.lastModified,
      });
    } else {
      children.push({
        id: `skill-dir-${agentId}-${safePath ? `${safePath}/` : ''}${name}`,
        name,
        type: 'directory',
        children: [],
      });
    }
  }
  return children;
}

export async function readAgentSkillPath(agentId, path) {
  const safePath = normalizeWorkspaceRelativePath(path);
  const parts = pathParts(safePath);
  const fileName = parts.pop();
  const dir = parts.length > 0
    ? await getExistingAgentDir(agentId, 'skills', ...parts)
    : await getExistingAgentDir(agentId, 'skills');
  return await readText(dir, fileName);
}

export async function getAgentSkillFileInfo(agentId, path) {
  const safePath = normalizeWorkspaceRelativePath(path);
  const parts = pathParts(safePath);
  const fileName = parts.pop();
  const dir = parts.length > 0
    ? await getExistingAgentDir(agentId, 'skills', ...parts)
    : await getExistingAgentDir(agentId, 'skills');
  const fileHandle = await dir.getFileHandle(fileName);
  const file = await fileHandle.getFile();
  return {
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
  };
}

export async function writeAgentSkillPath(agentId, path, content) {
  const safePath = normalizeWorkspaceRelativePath(path);
  return withAgentWorkspaceMutation(agentId, 'skills', async () => {
    const parts = pathParts(safePath);
    const fileName = parts.pop();
    const dir = parts.length > 0
      ? await getAgentDir(agentId, 'skills', ...parts)
      : await getAgentSkillsDir(agentId);
    const name = await resolveWorkspaceName(agentId);
    await writeText(dir, fileName, content, { localPath: `${WORKSPACE_DIR}/${name}/skills/${safePath}` });
  });
}

// Agent-scoped file operations

export async function listAgentFiles(agentId, path = '') {
  const safePath = normalizeWorkspaceRelativePath(path, { allowEmpty: true });
  const dir = safePath
    ? await getAgentDir(agentId, 'files', ...pathParts(safePath))
    : await getAgentFilesDir(agentId);
  const children = [];
  for (const { name, kind } of await listEntries(dir)) {
    if (kind === 'file') {
      const file = await (await dir.getFileHandle(name)).getFile();
      children.push({
        id: `file-${agentId}-${safePath ? `${safePath}/` : ''}${name}`,
        name,
        type: 'file',
        size: file.size,
        lastModified: file.lastModified,
      });
    } else {
      children.push({
        id: `dir-${agentId}-${safePath ? `${safePath}/` : ''}${name}`,
        name,
        type: 'directory',
        children: [],
      });
    }
  }
  return children;
}

export async function readAgentFile(agentId, path) {
  const safePath = normalizeWorkspaceRelativePath(path);
  const parts = pathParts(safePath);
  const fileName = parts.pop();
  const dir = parts.length > 0
    ? await getAgentDir(agentId, 'files', ...parts)
    : await getAgentFilesDir(agentId);
  return await readText(dir, fileName);
}

export async function readAgentFileBlob(agentId, path) {
  const safePath = normalizeWorkspaceRelativePath(path);
  const parts = pathParts(safePath);
  const fileName = parts.pop();
  const dir = parts.length > 0
    ? await getAgentDir(agentId, 'files', ...parts)
    : await getAgentFilesDir(agentId);
  const fileHandle = await dir.getFileHandle(fileName);
  return fileHandle.getFile();
}

export async function getAgentFileInfo(agentId, path) {
  const safePath = normalizeWorkspaceRelativePath(path);
  const parts = pathParts(safePath);
  const fileName = parts.pop();
  const dir = parts.length > 0
    ? await getAgentDir(agentId, 'files', ...parts)
    : await getAgentFilesDir(agentId);
  const fileHandle = await dir.getFileHandle(fileName);
  const file = await fileHandle.getFile();
  return {
    name: file.name,
    type: file.type,
    size: file.size,
    lastModified: file.lastModified,
  };
}

export async function writeAgentFile(agentId, path, content) {
  const safePath = normalizeWorkspaceRelativePath(path);
  return withAgentWorkspaceMutation(agentId, 'files', async () => {
    const parts = pathParts(safePath);
    const fileName = parts.pop();
    const dir = parts.length > 0
      ? await getAgentDir(agentId, 'files', ...parts)
      : await getAgentFilesDir(agentId);
    const name = await resolveWorkspaceName(agentId);
    await writeText(dir, fileName, content, { localPath: `${WORKSPACE_DIR}/${name}/files/${safePath}` });
  });
}

export async function createAgentFile(agentId, path, isDirectory = false) {
  const safePath = normalizeWorkspaceRelativePath(path);
  return withAgentWorkspaceMutation(agentId, 'files', async () => {
    const parts = pathParts(safePath);
    const name = parts.pop();
    const dir = parts.length > 0
      ? await getAgentDir(agentId, 'files', ...parts)
      : await getAgentFilesDir(agentId);
    if (isDirectory) {
      await dir.getDirectoryHandle(name, { create: true });
      const workspaceName = await resolveWorkspaceName(agentId);
      notifyOpfsMutation(`${WORKSPACE_DIR}/${workspaceName}/files/${safePath}`, 'mkdir');
    } else {
      const workspaceName = await resolveWorkspaceName(agentId);
      await writeText(dir, name, '', { localPath: `${WORKSPACE_DIR}/${workspaceName}/files/${safePath}` });
    }
  });
}

export async function deleteAgentFile(agentId, path) {
  const safePath = normalizeWorkspaceRelativePath(path);
  return withAgentWorkspaceMutation(agentId, 'files', async () => {
    const parts = pathParts(safePath);
    const name = parts.pop();
    const dir = parts.length > 0
      ? await getAgentDir(agentId, 'files', ...parts)
      : await getAgentFilesDir(agentId);
    try {
      await dir.removeEntry(name, { recursive: true });
      const workspaceName = await resolveWorkspaceName(agentId);
      notifyOpfsMutation(`${WORKSPACE_DIR}/${workspaceName}/files/${safePath}`, 'delete');
    } catch (error) {
      if (!isMissingFileSystemEntry(error)) throw error;
    }
  });
}
