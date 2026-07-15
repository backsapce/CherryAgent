/**
 * Config Adapter for Vertex Agent.
 *
 * Central configuration proxy that reads/writes a `config.yaml` file in OPFS.
 * All modules access configuration through this adapter so that changes
 * propagate everywhere via a subscribe/notify pattern.
 *
 * YAML structure:
 *   llm:
 *     provider: openai
 *     apiKey: sk-...
 *     baseUrl: null
 *     model: gpt-4o
 *
 * Usage:
 *   import config from './config/config';
 *
 *   await config.init();                       // load from OPFS
 *   const val = config.get('llm.provider');     // read a value
 *   await config.set('llm.provider', 'openai'); // write + persist + notify
 *
 *   config.subscribe((cfg) => { ... });         // listen for any change
 */

import yaml from 'js-yaml';
import { notifyOpfsMutation } from '../vfs/opfs.js';

// ─── OPFS helpers ───────────────────────────────────────────────────────────

const ROOT_DIR = 'vertex-agent';
const CONFIG_FILE = 'config.yaml';

async function getRootDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ROOT_DIR, { create: true });
}

async function readFile(dirHandle, filename) {
  try {
    const fh = await dirHandle.getFileHandle(filename);
    const file = await fh.getFile();
    return await file.text();
  } catch (error) {
    if (
      error?.name === 'NotFoundError'
      || /(?:file|entry) not found/i.test(String(error?.message || ''))
    ) return null;
    throw error;
  }
}

async function writeFile(dirHandle, filename, text) {
  const fh = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fh.createWritable();
  try {
    await writable.write(text);
    await writable.close();
  } catch (error) {
    try { await writable.abort?.(); } catch { /* preserve the original error */ }
    throw error;
  }
}

// ─── In-memory state ────────────────────────────────────────────────────────

let _data = {};                // full config object
let _listeners = new Set();    // subscriber callbacks
let _initialized = false;
let _resetting = false;
// All reads that can replace the in-memory snapshot and all writes share one
// queue. Otherwise an init() that started first can finish after a set(), or
// two writable streams can close out of order and leave disk behind memory.
let _operationTail = Promise.resolve();

// ─── Internal helpers ───────────────────────────────────────────────────────

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function setOwn(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function isNotFoundError(error) {
  return error?.name === 'NotFoundError'
    || /(?:file|entry) not found/i.test(String(error?.message || ''));
}

/**
 * Serialize stateful config operations while allowing the queue to recover
 * after a rejected operation. The returned promise still exposes that
 * rejection to its caller.
 */
function enqueueOperation(operation) {
  const result = _operationTail.then(operation, operation);
  _operationTail = result.catch(() => {});
  return result;
}

function assertMutable() {
  if (_resetting) throw new Error('Configuration is locked for factory reset');
}

export function parseConfigDocument(raw) {
  if (raw == null || raw.trim() === '') return {};

  let parsed;
  try {
    parsed = yaml.load(raw);
  } catch (error) {
    throw new Error('config.yaml contains invalid YAML', { cause: error });
  }
  if (!isPlainObject(parsed)) {
    throw new Error('config.yaml must contain a YAML mapping');
  }
  return parsed;
}

/**
 * Deep-get a value by dot-separated path.
 *   getPath({ a: { b: 1 } }, 'a.b') → 1
 */
function getPath(obj, path) {
  if (!path) return obj;
  const keys = path.split('.');
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (!Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * Deep-set a value by dot-separated path (immutable — returns new root).
 */
function setPath(obj, path, value) {
  if (!path) return value;
  const keys = path.split('.');
  const root = { ...obj };
  let cur = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const current = Object.hasOwn(cur, k) ? cur[k] : undefined;
    const next = current != null && typeof current === 'object' ? { ...current } : {};
    // `target['__proto__'] = value` invokes Object.prototype's legacy setter.
    // Define every path component as data so imported/user-controlled names
    // cannot mutate the configuration object's prototype.
    setOwn(cur, k, next);
    cur = next;
  }
  setOwn(cur, keys[keys.length - 1], value);
  return root;
}

/** Notify all subscribers with a frozen snapshot. */
function notify() {
  const snapshot = structuredClone(_data);
  for (const fn of _listeners) {
    try { fn(snapshot); } catch (e) { console.error('Config listener error:', e); }
  }
}

/** Persist a candidate snapshot to OPFS as YAML. */
async function persist(data) {
  const text = yaml.dump(data, { lineWidth: 120, noRefs: true });
  const dir = await getRootDir();
  await writeFile(dir, CONFIG_FILE, text);
}


// ─── Public API ─────────────────────────────────────────────────────────────

const config = {
  /**
   * Initialize: load config.yaml from OPFS (call once at app startup).
   * Automatically migrates legacy llm-settings.json if present.
   * @returns {Promise<Object>} the full config object
   */
  async init() {
    assertMutable();
    return enqueueOperation(async () => {
      const wasInitialized = _initialized;
      const previousData = wasInitialized ? JSON.stringify(_data) : null;
      const dir = await getRootDir();
      const raw = await readFile(dir, CONFIG_FILE);
      const nextData = parseConfigDocument(raw);
      // Commit only after parsing and shape validation. A failed reload keeps
      // the last known-good in-memory config and leaves the file untouched.
      _data = nextData;
      _initialized = true;
      // init() is also used after a sync/import replaces files underneath this
      // adapter. Subscribers must see those external changes so runtime
      // services (notably auto-sync and LLM settings) can reconfigure.
      if (wasInitialized && previousData !== JSON.stringify(_data)) notify();
      return structuredClone(_data);
    });
  },

  /**
   * Whether init() has been called.
   */
  get initialized() {
    return _initialized;
  },

  /**
   * Get the entire config or a value by dot path.
   * @param {string} [path] - e.g. 'llm.provider' or 'llm'
   * @returns {*}
   */
  get(path) {
    const val = getPath(_data, path);
    // Return clones of objects so callers can't mutate internal state
    return val != null && typeof val === 'object' ? structuredClone(val) : val;
  },

  /**
   * Set a value by dot path, persist to OPFS, and notify subscribers.
   * @param {string} path  - e.g. 'llm.provider'
   * @param {*}      value
   */
  async set(path, value) {
    assertMutable();
    const valueSnapshot = structuredClone(value);
    return enqueueOperation(async () => {
      const nextData = setPath(_data, path, valueSnapshot);
      await persist(nextData);
      _data = nextData;
      notifyOpfsMutation(CONFIG_FILE, 'write');
      notify();
    });
  },

  /**
   * Merge an object at the given path (shallow merge).
   * Useful for updating multiple fields at once:
   *   config.merge('llm', { provider: 'openai', apiKey: 'sk-...' })
   */
  async merge(path, obj) {
    assertMutable();
    const objectSnapshot = structuredClone(obj);
    return enqueueOperation(async () => {
      const current = getPath(_data, path);
      const merged = current != null && typeof current === 'object'
        ? { ...current, ...objectSnapshot }
        : objectSnapshot;
      const nextData = setPath(_data, path, merged);
      await persist(nextData);
      _data = nextData;
      notifyOpfsMutation(CONFIG_FILE, 'write');
      notify();
    });
  },

  /**
   * Replace the entire config object.
   * @param {Object} data
   */
  async setAll(data) {
    assertMutable();
    const nextSnapshot = structuredClone(data);
    if (!isPlainObject(nextSnapshot)) {
      throw new TypeError('Configuration must be a mapping');
    }
    return enqueueOperation(async () => {
      await persist(nextSnapshot);
      _data = nextSnapshot;
      notifyOpfsMutation(CONFIG_FILE, 'write');
      notify();
    });
  },

  /**
   * Subscribe to config changes. Returns an unsubscribe function.
   * The listener receives the full config snapshot on every change.
   * @param {Function} listener - (config: Object) => void
   * @returns {Function} unsubscribe
   */
  subscribe(listener) {
    _listeners.add(listener);
    return () => _listeners.delete(listener);
  },

  /**
   * Delete the entire config.yaml from OPFS.
   */
  async clear() {
    assertMutable();
    return enqueueOperation(async () => {
      const dir = await getRootDir();
      let removed = false;
      try {
        await dir.removeEntry(CONFIG_FILE);
        removed = true;
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
      _data = {};
      if (removed) notifyOpfsMutation(CONFIG_FILE, 'delete');
      notify();
    });
  },

  /**
   * Fence factory reset against queued and future config writes. Operations
   * already queued finish first; then config is removed and all later
   * mutations are rejected until reload (or cancelFactoryReset on failure).
   */
  async clearForFactoryReset() {
    assertMutable();
    _resetting = true;
    try {
      return await enqueueOperation(async () => {
        const dir = await getRootDir();
        let removed = false;
        try {
          await dir.removeEntry(CONFIG_FILE);
          removed = true;
        } catch (error) {
          if (!isNotFoundError(error)) throw error;
        }
        _data = {};
        if (removed) notifyOpfsMutation(CONFIG_FILE, 'delete');
        notify();
      });
    } catch (error) {
      _resetting = false;
      throw error;
    }
  },

  cancelFactoryReset() {
    _resetting = false;
  },
};

export default config;
