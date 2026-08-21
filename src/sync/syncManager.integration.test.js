import assert from 'node:assert/strict';
import test from 'node:test';
import yaml from 'js-yaml';
import {
  deletePath,
  exportToZip,
  importFromZip,
  readPathBytes,
  readPathText,
  registerOpfsSyncHook,
  saveSessions,
  writePathBytes,
  writePathText,
} from '../vfs/opfs.js';
import {
  __syncInternals,
  pullSync,
  pushSync,
  syncNow,
  testSyncConnection,
} from './syncManager.js';
import { objectKey } from './s3Backend.js';
import {
  createStructuredUpdate,
  formatStructuredContent,
  readStructuredUpdate,
} from './yjsMerge.js';

const SYNC_CONFIG = {
  providerPreset: 's3',
  region: 'us-east-1',
  bucket: 'test-bucket',
  prefix: 'cherry-agent',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  maxConcurrentRequests: 2,
};
const OSS_SYNC_CONFIG = {
  ...SYNC_CONFIG,
  providerPreset: 'aliyun-oss',
  region: 'cn-beijing',
};
const CURRENT_MANIFEST_FILE = 'manifest.v3.json';
const LEGACY_MANIFEST_FILE = 'manifest.json';

class MemoryFileHandle {
  kind = 'file';

  constructor(name) {
    this.name = name;
    this.blob = new Blob([]);
    this.lastModified = 1;
  }

  async getFile() {
    MemoryFileHandle.getFileCalls.set(
      this.name,
      (MemoryFileHandle.getFileCalls.get(this.name) || 0) + 1
    );
    return new File([this.blob], this.name, { lastModified: this.lastModified });
  }

  async createWritable() {
    const chunks = [];
    return {
      write: async (content) => chunks.push(content),
      close: async () => {
        this.blob = new Blob(chunks);
        this.lastModified = MemoryFileHandle.nextTimestamp++;
      },
    };
  }

  static nextTimestamp = 10_000;
  static getFileCalls = new Map();
}

class MemoryDirectoryHandle {
  kind = 'directory';

  constructor() {
    this.entries = new Map();
  }

  async getDirectoryHandle(name, options = {}) {
    const existing = this.entries.get(name);
    if (existing) {
      if (existing.kind !== 'directory') throw new Error(`${name} is not a directory`);
      return existing;
    }
    if (!options.create) throw new Error(`Directory not found: ${name}`);
    const directory = new MemoryDirectoryHandle();
    this.entries.set(name, directory);
    return directory;
  }

  async getFileHandle(name, options = {}) {
    const existing = this.entries.get(name);
    if (existing) {
      if (existing.kind !== 'file') throw new Error(`${name} is not a file`);
      return existing;
    }
    if (!options.create) throw new Error(`File not found: ${name}`);
    const file = new MemoryFileHandle(name);
    this.entries.set(name, file);
    return file;
  }

  async removeEntry(name, options = {}) {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Entry not found: ${name}`);
    if (entry.kind === 'directory' && entry.entries.size > 0 && !options.recursive) {
      const error = new Error(`Directory is not empty: ${name}`);
      error.name = 'InvalidModificationError';
      throw error;
    }
    this.entries.delete(name);
  }

  async *[Symbol.asyncIterator]() {
    yield* this.entries;
  }
}

function useMemoryOpfs(originRoot = new MemoryDirectoryHandle()) {
  Object.defineProperty(globalThis.navigator, 'storage', {
    configurable: true,
    value: { getDirectory: async () => originRoot },
  });
  return originRoot;
}

function copyBytes(bytes) {
  return bytes == null ? null : new Uint8Array(bytes);
}

async function bodyBytes(body) {
  if (body instanceof Uint8Array) return copyBytes(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return new TextEncoder().encode(String(body));
}

async function sha256Text(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function rawManifestEntry(path, content, updatedAt = '2026-01-01T00:00:00.000Z') {
  const hash = await sha256Text(content);
  return {
    structured: false,
    deleted: false,
    hash,
    hashType: 'content',
    size: new TextEncoder().encode(content).byteLength,
    updatedAt,
    revision: 1,
    objectKey: objectKey(OSS_SYNC_CONFIG, __syncInternals.objectPath(path, hash)),
  };
}

function causalManifest(clientId, generation, seen, files) {
  return {
    version: 2,
    updatedAt: '2026-01-01T00:00:00.000Z',
    shardMeta: { clientId, generation, seen: { ...seen, [clientId]: generation } },
    files,
  };
}

class MemoryBackend {
  constructor() {
    this.objects = new Map();
    this.etags = new Map();
    this.requests = [];
    this.revision = 0;
    this.beforeManifestPut = null;
    this.exposeEtags = true;
  }

  etag(key) {
    return this.etags.get(key) || null;
  }

  setJson(key, data) {
    this.objects.set(key, new TextEncoder().encode(JSON.stringify(data)));
    this.etags.set(key, `"${++this.revision}"`);
  }

  json(key) {
    const bytes = this.objects.get(key);
    return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
  }

  resetRequests() {
    this.requests.length = 0;
  }

  count(operation, key = null) {
    return this.requests.filter((request) => (
      request.operation === operation && (key == null || request.key === key)
    )).length;
  }

  countPayloadPuts() {
    return this.requests.filter((request) => (
      request.operation === 'putBytes' && !request.key.includes('/.probe/')
    )).length;
  }

  async getJsonWithMetadata(key, fallback = null, options = {}) {
    this.requests.push({ operation: 'getJson', key, options });
    if (options.ifNoneMatch && options.ifNoneMatch === this.etag(key)) {
      return {
        data: fallback,
        etag: this.exposeEtags ? this.etag(key) : null,
        lastModified: null,
        contentLength: 0,
        notModified: true,
        exists: true,
      };
    }
    return {
      data: this.json(key) ?? fallback,
      etag: this.exposeEtags ? this.etag(key) : null,
      lastModified: null,
      contentLength: this.objects.get(key)?.byteLength ?? null,
      notModified: false,
      exists: this.objects.has(key),
    };
  }

  async putJson(key, data, options = {}) {
    this.requests.push({ operation: 'putJson', key, options });
    if (
      this.beforeManifestPut
      && (key.endsWith(`/${CURRENT_MANIFEST_FILE}`) || key.includes('/manifests/'))
    ) {
      const hook = this.beforeManifestPut;
      this.beforeManifestPut = null;
      await hook({ key, data, options, backend: this });
    }
    const currentEtag = this.etag(key);
    if (options.ifNoneMatch === '*' && this.objects.has(key)) throw preconditionError();
    if (options.ifMatch && options.ifMatch !== currentEtag) throw preconditionError();
    this.setJson(key, data);
    return { etag: this.exposeEtags ? this.etag(key) : null, versionId: null };
  }

  async getBytes(key, options = {}) {
    this.requests.push({ operation: 'getBytes', key, options });
    const bytes = copyBytes(this.objects.get(key));
    if (bytes && options.maxBytes != null && bytes.byteLength > options.maxBytes) {
      throw new Error(`Object exceeds maxBytes: ${key}`);
    }
    return bytes;
  }

  async putBytes(key, body, contentType = 'application/octet-stream', options = {}) {
    if (contentType && typeof contentType === 'object') {
      options = contentType;
    }
    this.requests.push({ operation: 'putBytes', key, options });
    const currentEtag = this.etag(key);
    if (options.ifNoneMatch === '*' && this.objects.has(key)) throw preconditionError();
    if (options.ifMatch && options.ifMatch !== currentEtag) throw preconditionError();
    this.objects.set(key, await bodyBytes(body));
    this.etags.set(key, `"${++this.revision}"`);
    return { etag: this.exposeEtags ? this.etag(key) : null, versionId: null };
  }

  async list(prefix, options = {}) {
    this.requests.push({ operation: 'list', key: prefix, options });
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .slice(0, options.maxObjects || Infinity)
      .map((key) => ({
        key,
        etag: this.etag(key),
        size: this.objects.get(key)?.byteLength ?? null,
        lastModified: null,
      }));
  }

  async delete(key, options = {}) {
    this.requests.push({ operation: 'delete', key, options });
    if (options.ifMatch && options.ifMatch !== this.etag(key)) throw preconditionError();
    this.objects.delete(key);
    this.etags.delete(key);
  }

  async test() {
    return true;
  }
}

function preconditionError() {
  const error = new Error('Precondition failed');
  error.name = 'PreconditionFailed';
  error.$metadata = { httpStatusCode: 412 };
  return error;
}

function installBackend(backend) {
  return __syncInternals.setSyncBackendFactoryForTests(() => backend);
}

async function pathMissing(path) {
  try {
    await readPathText(path);
    return false;
  } catch {
    return true;
  }
}

test('a warm no-op sync reads one manifest and uploads no payload or manifest', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  try {
    await writePathText('files/note.md', 'hello', { internal: true });
    await syncNow(SYNC_CONFIG);
    assert.equal(backend.count('getJson', manifestKey), 1);
    assert.equal(backend.count('putJson', manifestKey), 1);
    assert.equal(backend.countPayloadPuts(), 1);
    // The creator performs one follow-up opposite-mode check, after which the
    // steady-state path is a single conditional GET.
    await syncNow(SYNC_CONFIG);
    const stateBeforeNoOp = JSON.parse(await readPathText('.sync/state.json'));

    backend.resetRequests();
    MemoryFileHandle.getFileCalls.clear();
    const nextLocalTimestamp = MemoryFileHandle.nextTimestamp;
    const result = await syncNow(SYNC_CONFIG);
    assert.equal(result.pushed.uploaded, 0);
    assert.equal(backend.count('getJson', manifestKey), 1);
    assert.equal(backend.count('putJson', manifestKey), 0);
    assert.equal(backend.count('putJson'), 0);
    assert.equal(backend.countPayloadPuts(), 0);
    assert.equal(backend.requests.find((request) => request.operation === 'getJson').options.ifNoneMatch != null, true);
    assert.equal(MemoryFileHandle.getFileCalls.get('note.md'), 1);
    const stateAfterNoOp = JSON.parse(await readPathText('.sync/state.json'));
    delete stateBeforeNoOp.lastSyncAt;
    delete stateAfterNoOp.lastSyncAt;
    assert.deepEqual(stateAfterNoOp, stateBeforeNoOp);
    assert.equal(MemoryFileHandle.nextTimestamp, nextLocalTimestamp);
  } finally {
    restoreBackend();
  }
});

test('an empty destination no-op does not rewrite local sync state', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  try {
    useMemoryOpfs();
    await syncNow(SYNC_CONFIG);
    await syncNow(SYNC_CONFIG);
    const stateBefore = await readPathText('.sync/state.json');

    backend.resetRequests();
    await syncNow(SYNC_CONFIG);
    assert.equal(await readPathText('.sync/state.json'), stateBefore);
    assert.equal(backend.count('getJson', manifestKey), 1);
    assert.equal(backend.count('putJson'), 0);
    assert.equal(backend.countPayloadPuts(), 0);
  } finally {
    restoreBackend();
  }
});

test('a truncated semantic sync state fails closed without touching local or remote data', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const corruptState = '{"version":2,"files":null,"pendingSensitiveDeletes":{}}';
  try {
    await writePathText('files/protected.md', 'keep me', { internal: true });
    await writePathText('.sync/state.json', corruptState, { internal: true });
    backend.resetRequests();

    await assert.rejects(syncNow(SYNC_CONFIG), /invalid files index/i);
    assert.equal(await readPathText('files/protected.md'), 'keep me');
    assert.equal(await readPathText('.sync/state.json'), corruptState);
    assert.equal(backend.requests.length, 0);
  } finally {
    restoreBackend();
  }
});

test('identical raw files share one upload and one download per sync run', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  try {
    useMemoryOpfs();
    await writePathText('files/copy-a.bin', 'same payload', { internal: true });
    await writePathText('files/copy-b.bin', 'same payload', { internal: true });
    const result = await syncNow(SYNC_CONFIG);
    const manifest = backend.json(manifestKey);
    const sharedKey = manifest.files['files/copy-a.bin'].objectKey;
    assert.equal(manifest.files['files/copy-b.bin'].objectKey, sharedKey);
    assert.equal(result.pushed.uploaded, 1);
    assert.equal(backend.count('putBytes', sharedKey), 1);

    useMemoryOpfs();
    backend.resetRequests();
    await pullSync(SYNC_CONFIG);
    assert.equal(await readPathText('files/copy-a.bin'), 'same payload');
    assert.equal(await readPathText('files/copy-b.bin'), 'same payload');
    assert.equal(backend.count('getBytes', sharedKey), 1);
  } finally {
    restoreBackend();
  }
});

test('a later identical file reuses an already referenced content-addressed object', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  try {
    await writePathText('files/original.bin', 'same bytes', { internal: true });
    await syncNow(SYNC_CONFIG);
    const originalKey = backend.json(manifestKey).files['files/original.bin'].objectKey;

    await writePathText('files/later-copy.bin', 'same bytes', { internal: true });
    backend.resetRequests();
    await syncNow(SYNC_CONFIG);

    const manifest = backend.json(manifestKey);
    assert.equal(manifest.files['files/later-copy.bin'].objectKey, originalKey);
    assert.equal(backend.countPayloadPuts(), 0);
  } finally {
    restoreBackend();
  }
});

test('deterministic structured snapshots deduplicate across later sync runs', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  const content = JSON.stringify({ items: [{ id: 'same', enabled: true }], count: 3 });
  try {
    await writePathText('files/first.json', content, { internal: true });
    await syncNow(SYNC_CONFIG);
    const firstKey = backend.json(manifestKey).files['files/first.json'].yjsKey;

    await writePathText('files/second.json', content, { internal: true });
    backend.resetRequests();
    await syncNow(SYNC_CONFIG);

    assert.equal(backend.json(manifestKey).files['files/second.json'].yjsKey, firstKey);
    assert.equal(backend.countPayloadPuts(), 0);
  } finally {
    restoreBackend();
  }
});

test('a manual push queues behind an active pull instead of aliasing its result', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  const originalGetJson = backend.getJsonWithMetadata.bind(backend);
  let releaseManifestRead;
  let markManifestReadStarted;
  const manifestReadStarted = new Promise((resolve) => { markManifestReadStarted = resolve; });
  const manifestReadGate = new Promise((resolve) => { releaseManifestRead = resolve; });
  let blocked = false;
  try {
    backend.setJson(manifestKey, {
      version: 2,
      integrityVersion: 3,
      updatedAt: '2026-01-01T00:00:00.000Z',
      files: {},
    });
    backend.getJsonWithMetadata = async (...args) => {
      if (!blocked && args[0] === manifestKey) {
        blocked = true;
        markManifestReadStarted();
        await manifestReadGate;
      }
      return originalGetJson(...args);
    };
    useMemoryOpfs();
    const pull = pullSync(SYNC_CONFIG);
    await manifestReadStarted;
    await writePathText('files/queued.md', 'queued push', { internal: true });
    const push = syncNow(SYNC_CONFIG);
    releaseManifestRead();
    await Promise.all([pull, push]);

    assert.ok(backend.json(manifestKey).files['files/queued.md']);
  } finally {
    releaseManifestRead?.();
    restoreBackend();
  }
});

test('OPFS backup round-trips nested binary data and excludes sync internals', async () => {
  useMemoryOpfs();
  const binary = new Uint8Array([0, 255, 1, 128, 42]);
  await writePathBytes('files/nested/blob.bin', binary, { internal: true });
  await writePathText('.sync/state.json', '{"mustNotExport":true}', { internal: true });
  const backup = await exportToZip();

  useMemoryOpfs();
  const events = [];
  const unsubscribe = registerOpfsSyncHook((event) => events.push(event));
  try {
    await importFromZip(backup);
  } finally {
    unsubscribe();
  }
  assert.deepEqual([...await readPathBytes('files/nested/blob.bin')], [...binary]);
  assert.equal(await pathMissing('.sync/state.json'), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'write');
  assert.deepEqual(events[0].paths, ['files/nested/blob.bin']);
});

test('saving many sessions emits one batched sync mutation', async () => {
  useMemoryOpfs();
  const events = [];
  const unsubscribe = registerOpfsSyncHook((event) => events.push(event));
  const sessions = [
    { id: 'one', title: 'One', messages: [{ role: 'user', content: '1' }] },
    { id: 'two', title: 'Two', messages: [{ role: 'user', content: '2' }] },
  ];
  try {
    await saveSessions(sessions);
    await saveSessions(sessions);
    await saveSessions([
      { ...sessions[0], messages: [...sessions[0].messages, { role: 'assistant', content: 'changed' }] },
      sessions[1],
    ]);
  } finally {
    unsubscribe();
  }
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].paths.sort(), [
    'session.json',
    'sessions/one.json',
    'sessions/two.json',
  ]);
  assert.deepEqual(events[1].paths, ['sessions/one.json']);
});

test('a missing established conditional manifest fails closed instead of re-importing stale data', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  try {
    await writePathText('files/cache.md', 'cached remote content', { internal: true });
    await syncNow(SYNC_CONFIG);
    await deletePath('files/cache.md', { internal: true });
    await backend.delete(manifestKey);
    const staleEntry = await rawManifestEntry('stale.txt', 'stale legacy data');
    backend.objects.set(staleEntry.objectKey, new TextEncoder().encode('stale legacy data'));
    backend.setJson(objectKey(SYNC_CONFIG, LEGACY_MANIFEST_FILE), {
      version: 2,
      updatedAt: '2025-01-01T00:00:00.000Z',
      files: { 'stale.txt': staleEntry },
    });

    // Simulate lost browser storage/a different browser. The append-only
    // committed authority marker must still prevent stale legacy resurrection.
    useMemoryOpfs();

    backend.resetRequests();
    await assert.rejects(
      pullSync(SYNC_CONFIG),
      /authoritative conditional manifest is missing/i
    );
    assert.equal(await pathMissing('files/cache.md'), true);
    assert.equal(await pathMissing('stale.txt'), true);
    assert.equal(backend.count('getBytes'), 0);
  } finally {
    restoreBackend();
  }
});

test('missing established causal shards fail closed instead of reviving a legacy manifest', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  try {
    await writePathText('seed.txt', 'establish authority', { internal: true });
    await syncNow(OSS_SYNC_CONFIG);
    const staleEntry = await rawManifestEntry('stale.txt', 'stale legacy data');
    backend.objects.set(staleEntry.objectKey, new TextEncoder().encode('stale legacy data'));
    backend.setJson(objectKey(OSS_SYNC_CONFIG, LEGACY_MANIFEST_FILE), {
      version: 2,
      updatedAt: '2025-01-01T00:00:00.000Z',
      files: { 'stale.txt': staleEntry },
    });
    for (const key of [...backend.objects.keys()]) {
      if (key.startsWith(shardPrefix)) {
        backend.objects.delete(key);
        backend.etags.delete(key);
      }
    }

    useMemoryOpfs();

    await assert.rejects(
      pullSync(OSS_SYNC_CONFIG),
      /authoritative sharded manifests are missing/i
    );
    assert.equal(await pathMissing('stale.txt'), true);
  } finally {
    restoreBackend();
  }
});

test('an authority creator detects a simultaneous opposite-mode publication', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  try {
    const shardKey = `${objectKey(SYNC_CONFIG, 'manifests')}/racing-device.json`;
    backend.beforeManifestPut = async ({ backend: store }) => {
      store.setJson(shardKey, causalManifest('racing-device', 1, {}, {}));
    };

    await assert.rejects(
      syncNow(SYNC_CONFIG),
      /already uses sharded manifests/i
    );
    assert.equal(
      JSON.parse(await readPathText('.sync/state.json')).pendingModeConfirmation,
      false
    );
    assert.equal(backend.objects.has(objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE)), true);
    assert.equal(
      backend.objects.has(objectKey(SYNC_CONFIG, 'authority/conditional.json')),
      true
    );
    assert.equal(
      backend.objects.has(objectKey(SYNC_CONFIG, 'authority/sharded.json')),
      true
    );

    useMemoryOpfs();
    await assert.rejects(pullSync(SYNC_CONFIG), /conflicting.*authorit/i);
    useMemoryOpfs();
    await assert.rejects(pullSync({ ...SYNC_CONFIG, manifestMode: 'sharded' }), /conflicting.*authorit/i);
  } finally {
    restoreBackend();
  }
});

test('a shared manifest fails closed when its ETag is not exposed', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  try {
    await writePathText('files/safe.md', 'first', { internal: true });
    await syncNow(SYNC_CONFIG);
    const committed = backend.json(manifestKey);

    await writePathText('files/safe.md', 'second', { internal: true });
    backend.exposeEtags = false;
    // Force a 200 response instead of a cached 304 so the missing exposed ETag
    // cannot be masked by the previously cached validator.
    backend.setJson(manifestKey, committed);
    backend.resetRequests();
    await assert.rejects(syncNow(SYNC_CONFIG), /ETag is not exposed/i);
    assert.deepEqual(backend.json(manifestKey), committed);
    assert.equal(backend.countPayloadPuts(), 0);
  } finally {
    restoreBackend();
  }
});

test('connection testing rejects a backend that ignores conditional writes', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const originalPutBytes = backend.putBytes.bind(backend);
  backend.putBytes = (key, body, contentType) => originalPutBytes(
    key,
    body,
    contentType,
    {}
  );
  const restoreBackend = installBackend(backend);
  try {
    await assert.rejects(
      testSyncConnection(SYNC_CONFIG),
      /ignored the conditional create header/i
    );
    assert.equal([...backend.objects.keys()].some((key) => key.includes('/.probe/')), false);
  } finally {
    restoreBackend();
  }
});

test('bucket/CNAME endpoint mode does not require a redundant bucket name', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  try {
    await testSyncConnection({
      ...SYNC_CONFIG,
      providerPreset: 'custom',
      bucket: '',
      endpoint: 'https://sync.example.com',
      bucketEndpoint: true,
    });
  } finally {
    restoreBackend();
  }
});

test('an established conditional destination needs no object-list permission', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  try {
    useMemoryOpfs();
    await writePathText('files/no-list.md', 'available', { internal: true });
    await syncNow(SYNC_CONFIG);
    assert.ok(backend.json(manifestKey));

    backend.list = async () => {
      throw new Error('ListBucket is intentionally denied');
    };
    useMemoryOpfs();
    backend.resetRequests();
    await assert.rejects(
      testSyncConnection(SYNC_CONFIG),
      /ListBucket is intentionally denied/
    );
    backend.resetRequests();
    await pullSync(SYNC_CONFIG);
    assert.equal(await readPathText('files/no-list.md'), 'available');
    assert.equal(backend.count('list'), 0);
  } finally {
    restoreBackend();
  }
});

test('conditional first-use scans past junk keys and rejects existing shard authority', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const shardPrefix = `${objectKey(SYNC_CONFIG, 'manifests')}/`;
  try {
    backend.objects.set(`${shardPrefix}!folder-marker`, new Uint8Array());
    backend.setJson(`${shardPrefix}real-device.json`, causalManifest(
      'real-device',
      1,
      {},
      {}
    ));
    useMemoryOpfs();
    backend.resetRequests();

    await assert.rejects(syncNow(SYNC_CONFIG), /already uses sharded manifests/i);
    assert.equal(backend.count('list', shardPrefix), 1);
    assert.equal(backend.count('putJson'), 0);
    assert.equal(backend.countPayloadPuts(), 0);
  } finally {
    restoreBackend();
  }
});

test('sharded first-use rejects an existing conditional authority without writing', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  const shardedConfig = { ...SYNC_CONFIG, manifestMode: 'sharded' };
  try {
    backend.setJson(manifestKey, { version: 2, integrityVersion: 3, files: {} });
    useMemoryOpfs();
    backend.resetRequests();

    await assert.rejects(syncNow(shardedConfig), /already uses conditional manifests/i);
    assert.equal(backend.count('putJson'), 0);
    assert.equal(backend.countPayloadPuts(), 0);
  } finally {
    restoreBackend();
  }
});

test('browser sharded sync fails closed when cross-tab Web Locks are unavailable', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const previousWindow = globalThis.window;
  const previousLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      value: undefined,
    });
    await assert.rejects(
      testSyncConnection({ ...SYNC_CONFIG, manifestMode: 'sharded' }),
      /requires the browser Web Locks API/i
    );
    assert.equal(backend.requests.length, 0);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: previousWindow,
    });
    if (previousLocks) Object.defineProperty(globalThis.navigator, 'locks', previousLocks);
    else delete globalThis.navigator.locks;
    restoreBackend();
  }
});

test('conditional migration imports legacy once and ignores later old-client manifest writes', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const legacyKey = objectKey(SYNC_CONFIG, LEGACY_MANIFEST_FILE);
  const currentKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  const initialPath = 'files/migrated.md';
  try {
    const initialHash = await sha256Text('safe');
    const initialObjectKey = objectKey(
      SYNC_CONFIG,
      __syncInternals.objectPath(initialPath, initialHash)
    );
    backend.objects.set(initialObjectKey, new TextEncoder().encode('safe'));
    backend.setJson(legacyKey, {
      version: 2,
      integrityVersion: 3,
      updatedAt: '2026-01-01T00:00:00.000Z',
      files: {
        [initialPath]: {
          structured: false,
          deleted: false,
          hash: initialHash,
          hashType: 'content',
          size: 4,
          updatedAt: '2026-01-01T00:00:00.000Z',
          objectKey: initialObjectKey,
        },
      },
    });

    useMemoryOpfs();
    await syncNow(SYNC_CONFIG);
    assert.ok(backend.json(currentKey)?.files[initialPath]);

    const staleHash = await sha256Text('stale');
    const staleObjectKey = objectKey(
      SYNC_CONFIG,
      __syncInternals.objectPath('files/stale.md', staleHash)
    );
    backend.objects.set(staleObjectKey, new TextEncoder().encode('stale'));
    backend.setJson(legacyKey, {
      version: 2,
      integrityVersion: 3,
      updatedAt: '2099-01-01T00:00:00.000Z',
      files: {
        'files/stale.md': {
          structured: false,
          deleted: false,
          hash: staleHash,
          hashType: 'content',
          size: 5,
          updatedAt: '2099-01-01T00:00:00.000Z',
          objectKey: staleObjectKey,
        },
      },
    });

    useMemoryOpfs();
    backend.resetRequests();
    await pullSync(SYNC_CONFIG);
    assert.equal(await readPathText(initialPath), 'safe');
    assert.equal(await pathMissing('files/stale.md'), true);
    assert.equal(backend.count('getJson', legacyKey), 0);
  } finally {
    restoreBackend();
  }
});

test('an unchanged local file accepts an exact remote tombstone instead of resurrecting it', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  try {
    await writePathText('files/deleted.md', 'delete me', { internal: true });
    await syncNow(SYNC_CONFIG);
    const manifest = backend.json(manifestKey);
    manifest.files['files/deleted.md'] = {
      ...manifest.files['files/deleted.md'],
      deleted: true,
      deletedAt: new Date(Date.now() + 1_000).toISOString(),
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
    };
    backend.setJson(manifestKey, manifest);

    backend.resetRequests();
    await syncNow(SYNC_CONFIG);
    assert.equal(await pathMissing('files/deleted.md'), true);
    assert.equal(backend.json(manifestKey).files['files/deleted.md'].deleted, true);
    assert.equal(backend.countPayloadPuts(), 0);
  } finally {
    restoreBackend();
  }
});

test('an unsynced local delete keeps its logical version while pull sees the older live file', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  const path = 'files/local-delete.md';
  try {
    await writePathText(path, 'delete locally', { internal: true });
    await syncNow(OSS_SYNC_CONFIG);
    await deletePath(path, { internal: true });
    await __syncInternals.rememberDeletedPaths([path], OSS_SYNC_CONFIG);

    await syncNow(OSS_SYNC_CONFIG);
    const shardKey = [...backend.objects.keys()].find((key) => key.startsWith(shardPrefix));
    const tombstone = backend.json(shardKey).files[path];
    assert.equal(tombstone.deleted, true);
    assert.equal(tombstone.revision, 2);
    assert.equal(tombstone.remoteDeleted, false);
    assert.equal(await pathMissing(path), true);
  } finally {
    restoreBackend();
  }
});

test('config sync includes LLM keys, strips device-only secrets, and stores one structured representation', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  try {
    const configData = {
      theme: 'dark',
      sync: { bucket: 'secret-bucket', accessKeyId: 'ak-secret', secretAccessKey: 'sk-secret' },
      agentTokens: { sandbox: 'agent-secret' },
      agents: [{ url: 'https://sandbox.test', name: 'Shared sandbox', status: 'connected' }],
      e2b: { apiKey: 'e2b-secret' },
      llm: { profiles: { p1: { id: 'p1', model: 'gpt', apiKey: 'llm-secret' } } },
    };
    await writePathText('config.yaml', yaml.dump(configData), { internal: true });
    await syncNow(SYNC_CONFIG);

    const entry = backend.json(manifestKey).files['config.yaml'];
    assert.equal(entry.redacted, true);
    assert.equal(entry.objectKey, undefined);
    assert.ok(entry.yjsKey);
    const remoteData = readStructuredUpdate(backend.objects.get(entry.yjsKey));
    assert.equal(remoteData.theme, 'dark');
    assert.equal(remoteData.sync, undefined);
    assert.deepEqual(remoteData.agentTokens, { sandbox: 'agent-secret' });
    assert.deepEqual(remoteData.agents, [{ url: 'https://sandbox.test', name: 'Shared sandbox' }]);
    assert.equal(remoteData.e2b, undefined);
    assert.equal(remoteData.llm.profiles.p1.apiKey, 'llm-secret');
    assert.equal(backend.countPayloadPuts(), 1);
    assert.equal((await readPathText('config.yaml')).includes('sk-secret'), true);
  } finally {
    restoreBackend();
  }
});

test('secret cleanup survives a transient failure and access-key rotation', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, LEGACY_MANIFEST_FILE);
  const path = 'config.yaml';
  const legacyKey = objectKey(SYNC_CONFIG, __syncInternals.yjsPath(path));
  const legacyData = {
    theme: 'dark',
    sync: { accessKeyId: 'legacy-ak', secretAccessKey: 'legacy-secret' },
  };
  let failedOnce = false;
  try {
    backend.objects.set(legacyKey, createStructuredUpdate(legacyData));
    backend.setJson(manifestKey, {
      version: 1,
      updatedAt: '2025-01-01T00:00:00.000Z',
      files: {
        [path]: {
          structured: true,
          deleted: false,
          size: new TextEncoder().encode(formatStructuredContent(path, legacyData)).byteLength,
          updatedAt: '2025-01-01T00:00:00.000Z',
          yjsKey: legacyKey,
        },
      },
    });
    const originalDelete = backend.delete.bind(backend);
    backend.delete = async (key, options = {}) => {
      if (key === legacyKey && !failedOnce) {
        failedOnce = true;
        throw new Error('transient delete failure');
      }
      return originalDelete(key, options);
    };

    useMemoryOpfs();
    await syncNow(SYNC_CONFIG);
    assert.equal(backend.objects.has(legacyKey), true);
    const queued = JSON.parse(await readPathText('.sync/state.json')).pendingSensitiveDeletes;
    assert.ok(queued[legacyKey]);

    await syncNow({ ...SYNC_CONFIG, accessKeyId: 'rotated-access-key' });
    assert.equal(backend.objects.has(legacyKey), false);
    assert.deepEqual(
      JSON.parse(await readPathText('.sync/state.json')).pendingSensitiveDeletes,
      {}
    );
  } finally {
    restoreBackend();
  }
});

test('deleting a legacy secret-bearing config journals and removes its payload', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  const path = 'config.yaml';
  try {
    const secretData = {
      theme: 'legacy',
      sync: { accessKeyId: 'old-ak', secretAccessKey: 'must-not-remain' },
    };
    const content = formatStructuredContent(path, secretData);
    const update = createStructuredUpdate(secretData);
    const payloadHash = await sha256Bytes(update);
    const secretKey = objectKey(SYNC_CONFIG, __syncInternals.yjsPath(path, payloadHash));
    backend.objects.set(secretKey, update);
    backend.setJson(manifestKey, {
      version: 2,
      integrityVersion: 3,
      updatedAt: '2025-01-01T00:00:00.000Z',
      files: {
        [path]: {
          structured: true,
          deleted: false,
          hash: await sha256Text(content),
          hashType: 'content',
          size: new TextEncoder().encode(content).byteLength,
          payloadHash,
          payloadSize: update.byteLength,
          yjsKey: secretKey,
          updatedAt: '2025-01-01T00:00:00.000Z',
          revision: 1,
          revisionBy: 'legacy-device',
        },
      },
    });

    useMemoryOpfs();
    await pullSync(SYNC_CONFIG);
    await deletePath(path, { internal: true });
    await __syncInternals.rememberDeletedPaths([path], SYNC_CONFIG);
    await syncNow(SYNC_CONFIG);

    assert.equal(backend.json(manifestKey).files[path].deleted, true);
    assert.equal(backend.objects.has(secretKey), false);
    assert.deepEqual(
      JSON.parse(await readPathText('.sync/state.json')).pendingSensitiveDeletes,
      {}
    );
  } finally {
    restoreBackend();
  }
});

test('sharded secret cleanup retains payloads that an offline shard can still reference', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  const path = 'config.yaml';
  try {
    const secretData = {
      theme: 'legacy',
      sync: { accessKeyId: 'offline-ak', secretAccessKey: 'offline-secret' },
    };
    const content = formatStructuredContent(path, secretData);
    const update = createStructuredUpdate(secretData);
    const payloadHash = await sha256Bytes(update);
    const secretKey = objectKey(OSS_SYNC_CONFIG, __syncInternals.yjsPath(path, payloadHash));
    backend.objects.set(secretKey, update);
    backend.setJson(`${shardPrefix}offline-device.1.json`, causalManifest(
      'offline-device',
      1,
      {},
      {
        [path]: {
          structured: true,
          deleted: false,
          hash: await sha256Text(content),
          hashType: 'content',
          size: new TextEncoder().encode(content).byteLength,
          payloadHash,
          payloadSize: update.byteLength,
          yjsKey: secretKey,
          updatedAt: '2025-01-01T00:00:00.000Z',
          revision: 1,
          revisionBy: 'offline-device',
        },
      }
    ));

    useMemoryOpfs();
    await pullSync(OSS_SYNC_CONFIG);
    await deletePath(path, { internal: true });
    await __syncInternals.rememberDeletedPaths([path], OSS_SYNC_CONFIG);
    await syncNow(OSS_SYNC_CONFIG);

    const currentShard = [...backend.objects.keys()]
      .filter((key) => key.startsWith(shardPrefix))
      .map((key) => backend.json(key))
      .find((manifest) => manifest?.shardMeta?.clientId !== 'offline-device');
    assert.equal(currentShard.files[path].deleted, true);
    assert.equal(backend.objects.has(secretKey), true);
    assert.ok(
      JSON.parse(await readPathText('.sync/state.json')).pendingSensitiveDeletes[secretKey]
    );
  } finally {
    restoreBackend();
  }
});

test('a content-addressed secret config payload is not retained as a merge base', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  const path = 'config.yaml';
  const secretData = {
    theme: 'dark',
    sync: { accessKeyId: 'old-ak', secretAccessKey: 'old-secret' },
  };
  try {
    const content = formatStructuredContent(path, secretData);
    const update = createStructuredUpdate(secretData);
    const payloadHash = await sha256Bytes(update);
    const oldKey = objectKey(SYNC_CONFIG, __syncInternals.yjsPath(path, payloadHash));
    backend.objects.set(oldKey, update);
    backend.setJson(manifestKey, {
      version: 2,
      integrityVersion: 3,
      updatedAt: '2025-01-01T00:00:00.000Z',
      files: {
        [path]: {
          structured: true,
          deleted: false,
          hash: await sha256Text(content),
          hashType: 'content',
          size: new TextEncoder().encode(content).byteLength,
          payloadHash,
          payloadSize: update.byteLength,
          yjsKey: oldKey,
          updatedAt: '2025-01-01T00:00:00.000Z',
          revision: 1,
          revisionBy: 'old-device',
        },
      },
    });

    useMemoryOpfs();
    await syncNow(SYNC_CONFIG);
    const sanitized = backend.json(manifestKey).files[path];
    assert.equal(sanitized.baseYjsKey, undefined);
    assert.notEqual(sanitized.yjsKey, oldKey);
    assert.equal(backend.objects.has(oldKey), false);
    assert.equal(readStructuredUpdate(backend.objects.get(sanitized.yjsKey)).sync, undefined);
  } finally {
    restoreBackend();
  }
});

test('a sanitized config primary drops and deletes its older secret-bearing base', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  const path = 'config.yaml';
  const storedPayload = async (data) => {
    const content = formatStructuredContent(path, data);
    const update = createStructuredUpdate(data);
    const payloadHash = await sha256Bytes(update);
    const yjsKey = objectKey(SYNC_CONFIG, __syncInternals.yjsPath(path, payloadHash));
    backend.objects.set(yjsKey, update);
    return {
      hash: await sha256Text(content),
      size: new TextEncoder().encode(content).byteLength,
      payloadHash,
      payloadSize: update.byteLength,
      yjsKey,
    };
  };
  try {
    const current = await storedPayload({ theme: 'dark' });
    const secretBase = await storedPayload({
      theme: 'light',
      sync: { secretAccessKey: 'must-be-deleted' },
    });
    backend.setJson(manifestKey, {
      version: 2,
      integrityVersion: 3,
      updatedAt: '2025-01-01T00:00:00.000Z',
      files: {
        [path]: {
          structured: true,
          deleted: false,
          hashType: 'content',
          ...current,
          baseYjsKey: secretBase.yjsKey,
          baseHash: secretBase.hash,
          baseSize: secretBase.size,
          basePayloadHash: secretBase.payloadHash,
          basePayloadSize: secretBase.payloadSize,
          updatedAt: '2025-01-01T00:00:00.000Z',
          revision: 2,
          revisionBy: 'old-device',
        },
      },
    });

    useMemoryOpfs();
    await syncNow(SYNC_CONFIG);
    const sanitized = backend.json(manifestKey).files[path];
    assert.equal(sanitized.yjsKey, current.yjsKey);
    assert.equal(sanitized.baseYjsKey, undefined);
    assert.equal(backend.objects.has(secretBase.yjsKey), false);
  } finally {
    restoreBackend();
  }
});

test('secret scrub survives a manifest CAS retry without persisting an optimistic baseline', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  const path = 'config.yaml';
  try {
    const secretData = {
      theme: 'remote',
      sync: { accessKeyId: 'remote-ak', secretAccessKey: 'remote-secret' },
    };
    const secretContent = formatStructuredContent(path, secretData);
    const secretUpdate = createStructuredUpdate(secretData);
    const secretPayloadHash = await sha256Bytes(secretUpdate);
    const secretKey = objectKey(
      SYNC_CONFIG,
      __syncInternals.yjsPath(path, secretPayloadHash)
    );
    backend.objects.set(secretKey, secretUpdate);
    backend.setJson(manifestKey, {
      version: 2,
      integrityVersion: 3,
      updatedAt: '2025-01-01T00:00:00.000Z',
      files: {
        [path]: {
          structured: true,
          deleted: false,
          hash: await sha256Text(secretContent),
          hashType: 'content',
          size: new TextEncoder().encode(secretContent).byteLength,
          payloadHash: secretPayloadHash,
          payloadSize: secretUpdate.byteLength,
          yjsKey: secretKey,
          updatedAt: '2025-01-01T00:00:00.000Z',
          revision: 1,
          revisionBy: 'old-device',
        },
      },
    });

    const remoteHash = await sha256Text('concurrent');
    const remoteKey = objectKey(
      SYNC_CONFIG,
      __syncInternals.objectPath('files/concurrent.txt', remoteHash)
    );
    backend.beforeManifestPut = async ({ backend: store }) => {
      store.objects.set(remoteKey, new TextEncoder().encode('concurrent'));
      const advanced = store.json(manifestKey);
      advanced.files['files/concurrent.txt'] = {
        structured: false,
        deleted: false,
        hash: remoteHash,
        hashType: 'content',
        size: 10,
        updatedAt: '2026-01-01T00:00:00.000Z',
        revision: 1,
        revisionBy: 'concurrent-device',
        objectKey: remoteKey,
      };
      store.setJson(manifestKey, advanced);
      throw preconditionError();
    };

    useMemoryOpfs();
    await writePathText(path, yaml.dump({
      theme: 'local',
      localOnly: true,
      sync: { accessKeyId: 'local-ak', secretAccessKey: 'local-secret' },
    }), { internal: true });
    await syncNow(SYNC_CONFIG);

    const localConfig = yaml.load(await readPathText(path));
    assert.equal(localConfig.localOnly, true);
    assert.equal(localConfig.sync.secretAccessKey, 'local-secret');
    assert.equal(await readPathText('files/concurrent.txt'), 'concurrent');
    const sanitized = backend.json(manifestKey).files[path];
    assert.equal(readStructuredUpdate(backend.objects.get(sanitized.yjsKey)).sync, undefined);
    assert.equal(backend.count('putBytes', sanitized.yjsKey), 1);
    assert.equal(backend.objects.has(secretKey), false);
    assert.deepEqual(
      JSON.parse(await readPathText('.sync/state.json')).pendingSensitiveDeletes,
      {}
    );

    backend.resetRequests();
    const warm = await syncNow(SYNC_CONFIG);
    assert.equal(warm.pushed.uploaded, 0);
    assert.equal(backend.countPayloadPuts(), 0);
  } finally {
    restoreBackend();
  }
});

test('structured metadata repair reuses an unchanged encoded payload', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  try {
    await writePathText('config.yaml', yaml.dump({ theme: 'dark' }), { internal: true });
    await syncNow(SYNC_CONFIG);
    const manifest = backend.json(manifestKey);
    const originalKey = manifest.files['config.yaml'].yjsKey;
    delete manifest.files['config.yaml'].redactionVersion;
    backend.setJson(manifestKey, manifest);

    backend.resetRequests();
    await syncNow(SYNC_CONFIG);
    const repaired = backend.json(manifestKey).files['config.yaml'];
    assert.equal(repaired.redactionVersion, 3);
    assert.equal(repaired.yjsKey, originalKey);
    assert.equal(backend.countPayloadPuts(), 0);
  } finally {
    restoreBackend();
  }
});

test('large scalar-heavy structured data round-trips with exact encoded metadata', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  const path = 'files/large-array.json';
  const data = { values: Array(100_000).fill(0) };
  try {
    useMemoryOpfs();
    await writePathText(path, JSON.stringify(data), { internal: true });
    await syncNow(SYNC_CONFIG);

    const entry = backend.json(manifestKey).files[path];
    assert.equal(entry.hashType, 'content');
    assert.match(entry.payloadHash, /^[a-f\d]{64}$/i);
    assert.equal(entry.payloadSize, backend.objects.get(entry.yjsKey).byteLength);
    assert.ok(entry.payloadSize < entry.size / 2);
    assert.equal(entry.yjsKey, objectKey(
      SYNC_CONFIG,
      __syncInternals.yjsPath(path, entry.payloadHash)
    ));

    useMemoryOpfs();
    await pullSync(SYNC_CONFIG);
    const restored = JSON.parse(await readPathText(path));
    assert.equal(restored.values.length, 100_000);
    assert.equal(restored.values[99_999], 0);
    const payloadRead = backend.requests.find((request) => (
      request.operation === 'getBytes' && request.key === entry.yjsKey
    ));
    assert.equal(payloadRead.options.maxBytes, entry.payloadSize);
  } finally {
    restoreBackend();
  }
});

test('pull rejects a missing raw content-addressed payload', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  const path = 'files/missing.bin';
  try {
    const hash = await sha256Text('missing');
    backend.setJson(manifestKey, {
      version: 2,
      integrityVersion: 3,
      updatedAt: '2026-01-01T00:00:00.000Z',
      files: {
        [path]: {
          structured: false,
          deleted: false,
          hash,
          hashType: 'content',
          size: 7,
          updatedAt: '2026-01-01T00:00:00.000Z',
          objectKey: objectKey(SYNC_CONFIG, __syncInternals.objectPath(path, hash)),
        },
      },
    });

    await assert.rejects(pullSync(SYNC_CONFIG), /payload is missing/i);
    assert.equal(await pathMissing(path), true);
  } finally {
    restoreBackend();
  }
});

test('pull rejects corrupt raw payload bytes before writing them to OPFS', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  const path = 'corrupt.txt';
  try {
    const entry = await rawManifestEntry(path, 'expected');
    backend.objects.set(entry.objectKey, new TextEncoder().encode('tampered'));
    backend.setJson(manifestKey, {
      version: 2,
      integrityVersion: 3,
      updatedAt: '2026-01-01T00:00:00.000Z',
      files: { [path]: entry },
    });

    await assert.rejects(pullSync(SYNC_CONFIG), /integrity validation/i);
    assert.equal(await pathMissing(path), true);
  } finally {
    restoreBackend();
  }
});

test('pull rejects a raw payload whose declared size is inflated', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  const path = 'files/wrong-size.txt';
  try {
    const entry = await rawManifestEntry(path, 'exact bytes');
    backend.objects.set(entry.objectKey, new TextEncoder().encode('exact bytes'));
    backend.setJson(manifestKey, {
      version: 2,
      integrityVersion: 3,
      updatedAt: '2026-01-01T00:00:00.000Z',
      files: { [path]: { ...entry, size: entry.size + 10 } },
    });

    await assert.rejects(pullSync(SYNC_CONFIG), /size does not match/i);
    assert.equal(await pathMissing(path), true);
  } finally {
    restoreBackend();
  }
});

test('a legacy raw entry without a declared size restores under the bounded fallback', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, LEGACY_MANIFEST_FILE);
  const path = 'files/legacy-raw.bin';
  const payloadKey = objectKey(SYNC_CONFIG, __syncInternals.objectPath(path));
  try {
    backend.objects.set(payloadKey, new TextEncoder().encode('legacy raw'));
    backend.setJson(manifestKey, {
      version: 1,
      updatedAt: '2025-01-01T00:00:00.000Z',
      files: {
        [path]: {
          structured: false,
          deleted: false,
          updatedAt: '2025-01-01T00:00:00.000Z',
          objectKey: payloadKey,
        },
      },
    });

    useMemoryOpfs();
    await pullSync(SYNC_CONFIG);
    assert.equal(await readPathText(path), 'legacy raw');
    const request = backend.requests.find((item) => (
      item.operation === 'getBytes' && item.key === payloadKey
    ));
    assert.equal(request.options.maxBytes, 512 * 1024 * 1024);
  } finally {
    restoreBackend();
  }
});

test('pull-only structured restore performs no remote writes', async () => {
  const backend = new MemoryBackend();
  let restoreBackend = installBackend(backend);
  try {
    useMemoryOpfs();
    await writePathText('files/data.json', JSON.stringify({ items: [{ id: 'a' }] }), { internal: true });
    await syncNow(SYNC_CONFIG);

    useMemoryOpfs();
    backend.resetRequests();
    const result = await pullSync(SYNC_CONFIG);
    assert.equal(result.downloaded, 1);
    assert.deepEqual(JSON.parse(await readPathText('files/data.json')), { items: [{ id: 'a' }] });
    assert.equal(backend.count('putJson'), 0);
    assert.equal(backend.countPayloadPuts(), 0);
    assert.equal(backend.count('delete'), 0);
  } finally {
    restoreBackend();
  }
});

test('a legacy v1 structured payload without encoded size migrates and reloads', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const legacyManifestKey = objectKey(SYNC_CONFIG, LEGACY_MANIFEST_FILE);
  const currentManifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  const path = 'files/legacy-v1.json';
  const legacyKey = objectKey(SYNC_CONFIG, __syncInternals.yjsPath(path));
  const data = { migrated: true, values: [1, 2, 3] };
  try {
    backend.objects.set(legacyKey, createStructuredUpdate(data));
    backend.setJson(legacyManifestKey, {
      version: 1,
      updatedAt: '2025-01-01T00:00:00.000Z',
      files: {
        [path]: {
          structured: true,
          deleted: false,
          size: new TextEncoder().encode(formatStructuredContent(path, data)).byteLength,
          updatedAt: '2025-01-01T00:00:00.000Z',
          yjsKey: legacyKey,
        },
      },
    });

    useMemoryOpfs();
    await syncNow(SYNC_CONFIG);
    const migrated = backend.json(currentManifestKey);
    assert.equal(migrated.integrityVersion, 3);
    assert.match(migrated.files[path].payloadHash, /^[a-f\d]{64}$/i);
    assert.notEqual(migrated.files[path].yjsKey, legacyKey);

    useMemoryOpfs();
    await pullSync(SYNC_CONFIG);
    assert.deepEqual(JSON.parse(await readPathText(path)), data);
  } finally {
    restoreBackend();
  }
});

test('pull rejects corrupt encoded structured payloads before materializing JSON', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  const path = 'session.json';
  try {
    const data = [{ id: 'session-a', title: 'Expected' }];
    const content = formatStructuredContent(path, data);
    const update = createStructuredUpdate(data);
    const payloadHash = await sha256Bytes(update);
    const yjsKey = objectKey(SYNC_CONFIG, __syncInternals.yjsPath(path, payloadHash));
    const corrupt = new Uint8Array(update);
    corrupt[corrupt.byteLength - 1] ^= 0xff;
    backend.objects.set(yjsKey, corrupt);
    backend.setJson(manifestKey, {
      version: 2,
      integrityVersion: 3,
      updatedAt: '2026-01-01T00:00:00.000Z',
      files: {
        [path]: {
          structured: true,
          deleted: false,
          hash: await sha256Text(content),
          hashType: 'content',
          size: new TextEncoder().encode(content).byteLength,
          payloadHash,
          payloadSize: update.byteLength,
          yjsKey,
          updatedAt: '2026-01-01T00:00:00.000Z',
          revision: 1,
          revisionBy: 'remote-device',
        },
      },
    });

    await assert.rejects(pullSync(SYNC_CONFIG), /structured encoded payload failed integrity/i);
    assert.equal(await pathMissing(path), true);
  } finally {
    restoreBackend();
  }
});

test('two legacy structured shard heads consolidate without creating an invalid mixed manifest', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  const path = 'files/legacy-heads.json';
  const fromA = { left: 1 };
  const fromB = { right: 2 };
  const keyA = `${objectKey(OSS_SYNC_CONFIG, __syncInternals.yjsPath(path))}.device-a`;
  const keyB = `${objectKey(OSS_SYNC_CONFIG, __syncInternals.yjsPath(path))}.device-b`;
  const legacyEntry = (data, yjsKey) => ({
    structured: true,
    deleted: false,
    size: new TextEncoder().encode(formatStructuredContent(path, data)).byteLength,
    updatedAt: '2025-01-01T00:00:00.000Z',
    yjsKey,
  });
  try {
    backend.objects.set(keyA, createStructuredUpdate(fromA));
    backend.objects.set(keyB, createStructuredUpdate(fromB));
    backend.setJson(`${shardPrefix}legacy-a.json`, {
      version: 1,
      updatedAt: '2025-01-01T00:00:00.000Z',
      files: { [path]: legacyEntry(fromA, keyA) },
    });
    backend.setJson(`${shardPrefix}legacy-b.json`, {
      version: 1,
      updatedAt: '2025-01-01T00:00:00.000Z',
      files: { [path]: legacyEntry(fromB, keyB) },
    });

    useMemoryOpfs();
    await syncNow(OSS_SYNC_CONFIG);
    assert.deepEqual(JSON.parse(await readPathText(path)), { left: 1, right: 2 });
    const shardKeys = [...backend.objects.keys()].filter((key) => key.startsWith(shardPrefix));
    assert.equal(shardKeys.length, 1);
    assert.equal(backend.json(shardKeys[0]).integrityVersion, 3);

    useMemoryOpfs();
    await pullSync(OSS_SYNC_CONFIG);
    assert.deepEqual(JSON.parse(await readPathText(path)), { left: 1, right: 2 });
  } finally {
    restoreBackend();
  }
});

test('pre-causal shards merge with the legacy manifest before the first causal checkpoint', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(OSS_SYNC_CONFIG, 'manifest.json');
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  try {
    const fromLegacy = await rawManifestEntry('legacy-only.md', 'legacy');
    const fromShard = await rawManifestEntry('shard-only.md', 'shard');
    backend.objects.set(fromLegacy.objectKey, new TextEncoder().encode('legacy'));
    backend.objects.set(fromShard.objectKey, new TextEncoder().encode('shard'));
    backend.setJson(manifestKey, {
      version: 2,
      updatedAt: '2026-01-02T00:00:00.000Z',
      files: { 'legacy-only.md': fromLegacy },
    });
    backend.setJson(`${shardPrefix}old-device.json`, {
      version: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      files: { 'shard-only.md': fromShard },
    });

    useMemoryOpfs();
    await syncNow(OSS_SYNC_CONFIG);
    assert.equal(await readPathText('legacy-only.md'), 'legacy');
    assert.equal(await readPathText('shard-only.md'), 'shard');
    const causal = [...backend.objects.keys()]
      .filter((key) => key.startsWith(shardPrefix))
      .map((key) => backend.json(key))
      .find((manifest) => manifest?.shardMeta);
    assert.ok(causal);
    assert.ok(causal.files['legacy-only.md']);
    assert.ok(causal.files['shard-only.md']);
  } finally {
    restoreBackend();
  }
});

test('manifest CAS conflict reloads and preserves disjoint remote and local additions', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  try {
    const remoteHash = await sha256Text('remote');
    const remoteKey = objectKey(
      SYNC_CONFIG,
      __syncInternals.objectPath('remote.txt', remoteHash)
    );
    backend.beforeManifestPut = async ({ backend: store }) => {
      store.objects.set(remoteKey, new TextEncoder().encode('remote'));
      store.setJson(manifestKey, {
        version: 2,
        updatedAt: new Date().toISOString(),
        files: {
          'remote.txt': {
            structured: false,
            deleted: false,
            hash: remoteHash,
            hashType: 'content',
            size: 6,
            updatedAt: new Date().toISOString(),
            objectKey: remoteKey,
          },
        },
      });
      throw preconditionError();
    };
    await writePathText('local.txt', 'local', { internal: true });

    await syncNow(SYNC_CONFIG);
    const finalPaths = Object.keys(backend.json(manifestKey).files).sort();
    assert.deepEqual(finalPaths, ['local.txt', 'remote.txt']);
    assert.equal(await readPathText('remote.txt'), 'remote');
    assert.ok(backend.count('putJson', manifestKey) >= 2);
    assert.equal(backend.countPayloadPuts(), 1);
  } finally {
    restoreBackend();
  }
});

test('a CAS retry never republishes the raw snapshot downloaded before the conflict', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  const path = 'shared.txt';
  try {
    const oldEntry = await rawManifestEntry(path, 'old remote');
    backend.objects.set(oldEntry.objectKey, new TextEncoder().encode('old remote'));
    backend.setJson(manifestKey, {
      version: 2,
      integrityVersion: 3,
      updatedAt: '2026-01-01T00:00:00.000Z',
      files: { [path]: oldEntry },
    });
    await writePathText('local.txt', 'local addition', { internal: true });

    const competingEntry = {
      ...await rawManifestEntry(path, 'competing remote', '2026-01-02T00:00:00.000Z'),
      revision: 2,
      revisionBy: 'competing-device',
    };
    backend.beforeManifestPut = async ({ backend: store }) => {
      store.objects.set(
        competingEntry.objectKey,
        new TextEncoder().encode('competing remote')
      );
      store.setJson(manifestKey, {
        version: 2,
        integrityVersion: 3,
        updatedAt: '2026-01-02T00:00:00.000Z',
        files: { [path]: competingEntry },
      });
      throw preconditionError();
    };

    await syncNow(SYNC_CONFIG);

    assert.equal(await readPathText(path), 'competing remote');
    assert.equal(backend.json(manifestKey).files[path].hash, competingEntry.hash);
    assert.ok(backend.json(manifestKey).files['local.txt']);
  } finally {
    restoreBackend();
  }
});

test('concurrent raw edits preserve both versions without overwriting the remote head', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  const path = 'files/concurrent.txt';
  try {
    await writePathText(path, 'base', { internal: true });
    await syncNow(SYNC_CONFIG);

    await writePathText(path, 'local edit', { internal: true });
    const remoteEntry = {
      ...await rawManifestEntry(path, 'remote edit', '2026-01-02T00:00:00.000Z'),
      revision: 2,
      revisionBy: 'remote-device',
    };
    backend.objects.set(remoteEntry.objectKey, new TextEncoder().encode('remote edit'));
    const advanced = backend.json(manifestKey);
    advanced.files[path] = remoteEntry;
    backend.setJson(manifestKey, advanced);

    const result = await syncNow(SYNC_CONFIG);
    assert.ok(result.pulled.conflicts >= 1);
    assert.equal(await readPathText(path), 'remote edit');
    assert.equal(backend.json(manifestKey).files[path].hash, remoteEntry.hash);
    const conflictPath = Object.keys(backend.json(manifestKey).files)
      .find((candidate) => candidate.startsWith('files/Sync Conflicts/'));
    assert.ok(conflictPath);
    assert.equal(await readPathText(conflictPath), 'local edit');
  } finally {
    restoreBackend();
  }
});

test('replacing a synced file with a directory converges without an invalid manifest', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  const parentPath = 'files/shape';
  const childPath = 'files/shape/child.txt';
  try {
    await writePathText(parentPath, 'old file', { internal: true });
    await syncNow(SYNC_CONFIG);

    await deletePath(parentPath, { internal: true });
    await writePathText(childPath, 'new child', { internal: true });
    // Push directly to exercise recovery even when mutation hooks were not
    // running to record the intermediate delete/restore sequence.
    await pushSync(SYNC_CONFIG);

    const committedPaths = Object.keys(backend.json(manifestKey).files);
    assert.deepEqual(committedPaths, [childPath]);

    useMemoryOpfs();
    await pullSync(SYNC_CONFIG);
    assert.equal(await readPathText(childPath), 'new child');
    assert.equal(await pathMissing(parentPath), true);
  } finally {
    restoreBackend();
  }
});

test('namespace reconciliation never recursively deletes a child created during cleanup', async () => {
  const origin = useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  const rootPath = 'files/racy-tree';
  const oldChildPath = `${rootPath}/old.txt`;
  const newChildPath = `${rootPath}/created-during-pull.txt`;
  try {
    await writePathText(oldChildPath, 'synced old child', { internal: true });
    await syncNow(SYNC_CONFIG);

    const remoteEntry = {
      ...await rawManifestEntry(rootPath, 'remote replacement'),
      revision: 2,
      revisionBy: 'remote-device',
    };
    backend.objects.set(remoteEntry.objectKey, new TextEncoder().encode('remote replacement'));
    backend.setJson(manifestKey, {
      version: 2,
      integrityVersion: 3,
      updatedAt: '2026-01-02T00:00:00.000Z',
      files: { [rootPath]: remoteEntry },
    });

    const appRoot = await origin.getDirectoryHandle('cherry-agent');
    const filesDirectory = await appRoot.getDirectoryHandle('files');
    const removeEntry = filesDirectory.removeEntry.bind(filesDirectory);
    let injected = false;
    filesDirectory.removeEntry = async (name, options = {}) => {
      if (name === 'racy-tree' && !options.recursive && !injected) {
        injected = true;
        await writePathText(newChildPath, 'new unsynced child', { internal: true });
      }
      return removeEntry(name, options);
    };

    await assert.rejects(pullSync(SYNC_CONFIG), /local path changed.*namespace conflict/i);
    assert.equal(injected, true);
    assert.equal(await readPathText(newChildPath), 'new unsynced child');
    assert.equal(await pathMissing(rootPath), true);
  } finally {
    restoreBackend();
  }
});

test('direct push never recursively deletes a file replaced by a populated directory', async () => {
  const origin = useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  const rootPath = 'files/direct-push-race';
  const childPath = `${rootPath}/created-during-push.txt`;
  try {
    await writePathText(rootPath, 'synced file', { internal: true });
    await syncNow(SYNC_CONFIG);
    const remote = backend.json(manifestKey);
    remote.files[rootPath] = {
      ...remote.files[rootPath],
      deleted: true,
      deletedAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      revision: 2,
      revisionBy: 'remote-device',
    };
    backend.setJson(manifestKey, remote);

    const appRoot = await origin.getDirectoryHandle('cherry-agent');
    const filesDirectory = await appRoot.getDirectoryHandle('files');
    const removeEntry = filesDirectory.removeEntry.bind(filesDirectory);
    let injected = false;
    filesDirectory.removeEntry = async (name, options = {}) => {
      if (name === 'direct-push-race' && !options.recursive && !injected) {
        injected = true;
        await removeEntry(name, { recursive: true });
        await writePathText(childPath, 'unsynced child', { internal: true });
      }
      return removeEntry(name, options);
    };

    await assert.rejects(pushSync(SYNC_CONFIG), /local path changed.*remote sync deletion/i);
    assert.equal(injected, true);
    assert.equal(await readPathText(childPath), 'unsynced child');
    assert.equal(backend.json(manifestKey).files[rootPath].deleted, true);
    assert.equal(JSON.parse(await readPathText('.sync/state.json')).files[rootPath].deleted, false);
  } finally {
    restoreBackend();
  }
});

test('structured identity-array deletion converges through the cached three-way base', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  try {
    const firstDevice = useMemoryOpfs();
    await writePathText('files/items.json', JSON.stringify({ items: [{ id: 'a' }, { id: 'b' }] }), { internal: true });
    await syncNow(SYNC_CONFIG);

    const secondDevice = useMemoryOpfs();
    await pullSync(SYNC_CONFIG);

    useMemoryOpfs(firstDevice);
    await writePathText('files/items.json', JSON.stringify({ items: [{ id: 'a' }] }), { internal: true });
    await syncNow(SYNC_CONFIG);

    useMemoryOpfs(secondDevice);
    await syncNow(SYNC_CONFIG);
    assert.deepEqual(JSON.parse(await readPathText('files/items.json')), { items: [{ id: 'a' }] });
  } finally {
    restoreBackend();
    await deletePath('.sync', { internal: true });
  }
});

test('a newer local child survives a remote directory tombstone', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(SYNC_CONFIG, CURRENT_MANIFEST_FILE);
  try {
    await writePathText('files/dir/note.md', 'original', { internal: true });
    await writePathText('files/dir/deleted-sibling.md', 'remove me', { internal: true });
    await syncNow(SYNC_CONFIG);

    await writePathText('files/dir/note.md', 'new local edit', { internal: true });
    const manifest = backend.json(manifestKey);
    manifest.files['files/dir'] = {
      structured: false,
      deleted: true,
      hash: null,
      deletedAt: new Date(5_000).toISOString(),
      updatedAt: new Date(5_000).toISOString(),
    };
    backend.setJson(manifestKey, manifest);

    await syncNow(SYNC_CONFIG);
    assert.equal(await readPathText('files/dir/note.md'), 'new local edit');
    assert.equal(await pathMissing('files/dir/deleted-sibling.md'), true);
    assert.equal(backend.json(manifestKey).files['files/dir'], undefined);
    assert.equal(backend.json(manifestKey).files['files/dir/note.md'].deleted, false);
    assert.equal(backend.json(manifestKey).files['files/dir/deleted-sibling.md'].deleted, true);

    useMemoryOpfs();
    await pullSync(SYNC_CONFIG);
    assert.equal(await readPathText('files/dir/note.md'), 'new local edit');
    assert.equal(await pathMissing('files/dir/deleted-sibling.md'), true);
  } finally {
    restoreBackend();
  }
});

test('OSS manifest shards preserve disjoint device updates when the legacy mirror is stale', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(OSS_SYNC_CONFIG, 'manifest.json');
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  try {
    useMemoryOpfs();
    await writePathText('device-a.md', 'from a', { internal: true });
    await syncNow(OSS_SYNC_CONFIG);

    useMemoryOpfs();
    await writePathText('device-b.md', 'from b', { internal: true });
    await syncNow(OSS_SYNC_CONFIG);

    const shardKeys = [...backend.objects.keys()].filter((key) => key.startsWith(shardPrefix));
    assert.equal(shardKeys.length, 1);
    assert.equal(backend.requests.some((request) => (
      request.operation === 'delete'
      && request.key.startsWith(shardPrefix)
      && !request.options.ifMatch
    )), true);

    backend.setJson(manifestKey, {
      version: 2,
      updatedAt: new Date().toISOString(),
      files: {},
    });

    useMemoryOpfs();
    await pullSync(OSS_SYNC_CONFIG);
    assert.equal(await readPathText('device-a.md'), 'from a');
    assert.equal(await readPathText('device-b.md'), 'from b');
  } finally {
    restoreBackend();
  }
});

test('a warm OSS no-op uses one listing and no manifest GET or remote write', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(OSS_SYNC_CONFIG, 'manifest.json');
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  try {
    await writePathText('oss-warm.md', 'cached', { internal: true });
    await syncNow(OSS_SYNC_CONFIG);
    await syncNow(OSS_SYNC_CONFIG);

    backend.resetRequests();
    const result = await syncNow(OSS_SYNC_CONFIG);
    assert.equal(result.pushed.uploaded, 0);
    assert.equal(backend.count('list', shardPrefix), 1);
    assert.equal(backend.count('getJson'), 0);
    assert.equal(backend.count('putJson', manifestKey), 0);
    assert.equal(backend.count('putJson'), 0);
    assert.equal(backend.countPayloadPuts(), 0);
  } finally {
    restoreBackend();
  }
});

test('a delayed older OSS shard write cannot overwrite a newer generation', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  try {
    const origin = useMemoryOpfs();
    await writePathText('files/generation.md', 'generation one', { internal: true });
    await syncNow(OSS_SYNC_CONFIG);
    const firstKey = [...backend.objects.keys()].find((key) => key.startsWith(shardPrefix));
    const firstManifest = backend.json(firstKey);

    await writePathText('files/generation.md', 'generation two', { internal: true });
    await syncNow(OSS_SYNC_CONFIG);
    const secondKey = [...backend.objects.keys()].find((key) => key.startsWith(shardPrefix));
    assert.notEqual(secondKey, firstKey);
    assert.equal(backend.json(secondKey).shardMeta.generation, 2);

    // Model an ambiguous/timed-out first request that reaches object storage
    // after its generation was cleaned up. The immutable key makes the old
    // snapshot merely dominated history, never an overwrite of generation 2.
    backend.setJson(firstKey, firstManifest);
    useMemoryOpfs();
    await pullSync(OSS_SYNC_CONFIG);
    assert.equal(await readPathText('files/generation.md'), 'generation two');

    useMemoryOpfs(origin);
  } finally {
    restoreBackend();
  }
});

test('an ambiguous shard timeout reserves its generation before retrying a unique key', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  let timedOutPublication = null;
  try {
    useMemoryOpfs();
    await writePathText('files/ambiguous.md', 'survives timeout', { internal: true });
    backend.beforeManifestPut = ({ key, data }) => {
      timedOutPublication = { key, data: structuredClone(data) };
      throw new Error('simulated ambiguous timeout');
    };

    await assert.rejects(syncNow(OSS_SYNC_CONFIG), /ambiguous timeout/i);
    assert.match(
      timedOutPublication.key.slice(shardPrefix.length),
      /^[A-Za-z0-9-]{1,128}\.1\.[a-f\d]{16}\.json$/
    );
    const reserved = JSON.parse(await readPathText('.sync/state.json'));
    assert.equal(reserved.shardGeneration, 1);

    await syncNow(OSS_SYNC_CONFIG);
    const successfulKey = [...backend.objects.keys()]
      .find((key) => key.startsWith(shardPrefix));
    const successful = backend.json(successfulKey);
    assert.notEqual(successfulKey, timedOutPublication.key);
    assert.equal(successful.shardMeta.generation, 2);
    assert.match(
      successfulKey.slice(shardPrefix.length),
      /^[A-Za-z0-9-]{1,128}\.2\.[a-f\d]{16}\.json$/
    );

    // The request reported as timed out may still arrive after the retry. Its
    // lower reserved dot is dominated by generation 2 and cannot overwrite it.
    backend.setJson(timedOutPublication.key, timedOutPublication.data);
    useMemoryOpfs();
    await pullSync(OSS_SYNC_CONFIG);
    assert.equal(await readPathText('files/ambiguous.md'), 'survives timeout');
  } finally {
    restoreBackend();
  }
});

test('nonce-addressed shard metadata must match its immutable object key', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  try {
    backend.setJson(`${shardPrefix}device-a.1.aaaaaaaaaaaaaaaa.json`, {
      ...causalManifest('device-a', 1, {}, {}),
      shardMeta: {
        clientId: 'device-a',
        generation: 1,
        attemptId: 'bbbbbbbbbbbbbbbb',
        seen: { 'device-a': 1 },
      },
    });
    useMemoryOpfs();
    await assert.rejects(
      pullSync(OSS_SYNC_CONFIG),
      /shard identity does not match its object key/i
    );
  } finally {
    restoreBackend();
  }
});

test('an established sharded destination cannot be reopened in conditional mode', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const shardedConfig = { ...SYNC_CONFIG, manifestMode: 'sharded' };
  try {
    useMemoryOpfs();
    await writePathText('files/mode-lock.md', 'safe', { internal: true });
    await syncNow(shardedConfig);
    backend.resetRequests();
    useMemoryOpfs();

    await assert.rejects(
      syncNow({ ...SYNC_CONFIG, manifestMode: 'conditional' }),
      /already uses sharded manifests/i
    );
    assert.equal(backend.count('putJson'), 0);
    assert.equal(backend.countPayloadPuts(), 0);
  } finally {
    restoreBackend();
  }
});

test('truly concurrent OSS shard heads preserve disjoint files', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  try {
    const entryA = await rawManifestEntry('concurrent-a.md', 'from a');
    const entryB = await rawManifestEntry('concurrent-b.md', 'from b');
    backend.objects.set(entryA.objectKey, new TextEncoder().encode('from a'));
    backend.objects.set(entryB.objectKey, new TextEncoder().encode('from b'));
    backend.setJson(`${shardPrefix}device-a.json`, causalManifest('device-a', 1, {}, {
      'concurrent-a.md': { ...entryA, revisionBy: 'device-a' },
    }));
    backend.setJson(`${shardPrefix}device-b.json`, causalManifest('device-b', 1, {}, {
      'concurrent-b.md': { ...entryB, revisionBy: 'device-b' },
    }));

    useMemoryOpfs();
    const result = await pullSync(OSS_SYNC_CONFIG);
    assert.equal(await readPathText('concurrent-a.md'), 'from a');
    assert.equal(await readPathText('concurrent-b.md'), 'from b');
    assert.equal(result.downloaded, 2);
    assert.equal(backend.count('putJson'), 0);
  } finally {
    restoreBackend();
  }
});

test('concurrent OSS file/directory shapes converge without bricking OPFS', async () => {
  useMemoryOpfs();
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  try {
    const parentPath = 'files/foo';
    const childPath = 'files/foo/bar.txt';
    const parent = {
      ...await rawManifestEntry(parentPath, 'parent file'),
      revision: 1,
      revisionBy: 'device-a',
    };
    backend.objects.set(parent.objectKey, new TextEncoder().encode('parent file'));
    backend.setJson(
      `${shardPrefix}device-a.json`,
      causalManifest('device-a', 1, {}, { [parentPath]: parent })
    );
    await pullSync(OSS_SYNC_CONFIG);
    assert.equal(await readPathText(parentPath), 'parent file');

    const child = {
      ...await rawManifestEntry(childPath, 'child file'),
      revision: 2,
      revisionBy: 'device-b',
    };
    backend.objects.set(child.objectKey, new TextEncoder().encode('child file'));
    backend.setJson(
      `${shardPrefix}device-b.json`,
      causalManifest('device-b', 1, {}, { [childPath]: child })
    );

    await syncNow(OSS_SYNC_CONFIG);
    assert.equal(await readPathText(childPath), 'child file');
    assert.equal(await pathMissing(parentPath), true);
    const localClientId = JSON.parse(await readPathText('.sync/state.json')).clientId;
    const consolidated = [...backend.objects.keys()]
      .filter((key) => key.startsWith(shardPrefix))
      .map((key) => backend.json(key))
      .find((manifest) => manifest?.shardMeta?.clientId
        === localClientId);
    assert.deepEqual(Object.keys(consolidated.files), [childPath]);
  } finally {
    restoreBackend();
  }
});

test('conditional shard cleanup preserves a shard that advances after listing', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  const shardAKey = `${shardPrefix}device-a.json`;
  const shardBKey = `${shardPrefix}device-b.json`;
  try {
    const entryA = await rawManifestEntry('race-a.md', 'from a');
    const entryB = await rawManifestEntry('race-b.md', 'from b');
    const advancedEntry = await rawManifestEntry('advanced.md', 'new b generation');
    backend.objects.set(entryA.objectKey, new TextEncoder().encode('from a'));
    backend.objects.set(entryB.objectKey, new TextEncoder().encode('from b'));
    backend.objects.set(advancedEntry.objectKey, new TextEncoder().encode('new b generation'));
    backend.setJson(shardAKey, causalManifest('device-a', 1, {}, {
      'race-a.md': { ...entryA, revisionBy: 'device-a' },
    }));
    backend.setJson(shardBKey, causalManifest('device-b', 1, {}, {
      'race-b.md': { ...entryB, revisionBy: 'device-b' },
    }));

    const originalDelete = backend.delete.bind(backend);
    let advancedDuringDelete = false;
    backend.delete = async (key, options = {}) => {
      if (key === shardBKey && options.ifMatch && !advancedDuringDelete) {
        advancedDuringDelete = true;
        backend.setJson(shardBKey, causalManifest('device-b', 2, {}, {
          'race-b.md': { ...entryB, revisionBy: 'device-b' },
          'advanced.md': { ...advancedEntry, revision: 2, revisionBy: 'device-b' },
        }));
      }
      return originalDelete(key, options);
    };

    useMemoryOpfs();
    await syncNow(OSS_SYNC_CONFIG);
    assert.equal(advancedDuringDelete, true);
    assert.equal(backend.objects.has(shardBKey), true);
    assert.equal(backend.json(shardBKey).shardMeta.generation, 2);

    useMemoryOpfs();
    await pullSync(OSS_SYNC_CONFIG);
    assert.equal(await readPathText('advanced.md'), 'new b generation');
  } finally {
    restoreBackend();
  }
});

test('shard cleanup is disabled when a backend ignores conditional delete', async () => {
  const backend = new MemoryBackend();
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  const entryA = await rawManifestEntry('ignored-delete-a.md', 'a');
  const entryB = await rawManifestEntry('ignored-delete-b.md', 'b');
  backend.objects.set(entryA.objectKey, new TextEncoder().encode('a'));
  backend.objects.set(entryB.objectKey, new TextEncoder().encode('b'));
  backend.setJson(`${shardPrefix}device-a.json`, causalManifest('device-a', 1, {}, {
    'ignored-delete-a.md': { ...entryA, revisionBy: 'device-a' },
  }));
  backend.setJson(`${shardPrefix}device-b.json`, causalManifest('device-b', 1, {}, {
    'ignored-delete-b.md': { ...entryB, revisionBy: 'device-b' },
  }));
  backend.delete = async (key, options = {}) => {
    backend.requests.push({ operation: 'delete', key, options });
    backend.objects.delete(key);
    backend.etags.delete(key);
  };
  const restoreBackend = installBackend(backend);
  try {
    useMemoryOpfs();
    await syncNow(OSS_SYNC_CONFIG);
    const shards = [...backend.objects.keys()].filter((key) => key.startsWith(shardPrefix));
    assert.equal(shards.length, 3);
    assert.equal(backend.requests.some((request) => (
      request.operation === 'delete' && request.key.startsWith(shardPrefix)
    )), false);
  } finally {
    restoreBackend();
  }
});

test('more than 128 pre-causal OSS shards consolidate into one authority', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  try {
    for (let index = 0; index < 129; index += 1) {
      const path = `bulk/file-${String(index).padStart(3, '0')}.md`;
      const content = `value-${index}`;
      const entry = await rawManifestEntry(path, content);
      backend.objects.set(entry.objectKey, new TextEncoder().encode(content));
      backend.setJson(`${shardPrefix}legacy-${String(index).padStart(3, '0')}.json`, {
        version: 1,
        updatedAt: '2025-01-01T00:00:00.000Z',
        files: { [path]: entry },
      });
    }

    useMemoryOpfs();
    await syncNow(OSS_SYNC_CONFIG);
    assert.equal(await readPathText('bulk/file-000.md'), 'value-0');
    assert.equal(await readPathText('bulk/file-128.md'), 'value-128');
    assert.equal(
      [...backend.objects.keys()].filter((key) => key.startsWith(shardPrefix)).length,
      1
    );
  } finally {
    restoreBackend();
  }
});

test('causal shard history survives physical cleanup and dominates a delayed old shard', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  const stalePath = 'files/stale-from-delayed-shard.md';
  const markerPath = 'files/local-marker.md';
  try {
    const staleEntry = {
      ...await rawManifestEntry(stalePath, 'stale value'),
      revisionBy: 'offline-device',
    };
    backend.objects.set(staleEntry.objectKey, new TextEncoder().encode('stale value'));
    const delayedKey = `${shardPrefix}offline-device.1.json`;
    const delayedManifest = causalManifest(
      'offline-device',
      1,
      {},
      { [stalePath]: staleEntry }
    );
    backend.setJson(delayedKey, delayedManifest);

    const origin = useMemoryOpfs();
    await writePathText(markerPath, 'local', { internal: true });
    await syncNow(OSS_SYNC_CONFIG);
    assert.equal(backend.objects.has(delayedKey), false);

    await deletePath(stalePath, { internal: true });
    await __syncInternals.rememberDeletedPaths([stalePath], OSS_SYNC_CONFIG);
    await syncNow(OSS_SYNC_CONFIG);

    const checkpointKey = [...backend.objects.keys()]
      .find((key) => key.startsWith(shardPrefix));
    const checkpoint = backend.json(checkpointKey);
    assert.equal(checkpoint.shardMeta.seen['offline-device'], 1);
    assert.equal(checkpoint.files[stalePath].deleted, true);

    // If the checkpoint itself disappears, local causal memory fails closed
    // instead of accepting the older shard as current authority.
    backend.objects.delete(checkpointKey);
    backend.etags.delete(checkpointKey);
    backend.setJson(delayedKey, delayedManifest);
    // An unrelated concurrent head cannot reconstruct the missing full
    // checkpoint. Accepting it alone would discard data or tombstones that
    // existed only in the remembered snapshot.
    backend.setJson(
      `${shardPrefix}unrelated-device.1.json`,
      causalManifest('unrelated-device', 1, {}, {})
    );
    useMemoryOpfs(origin);
    await assert.rejects(pullSync(OSS_SYNC_CONFIG), /older.*observed causal frontier/i);
    assert.equal(await pathMissing(stalePath), true);

    // A timed-out/offline generation becomes visible again after its physical
    // object was cleaned up. The retained dot keeps it below the checkpoint.
    backend.setJson(checkpointKey, checkpoint);
    backend.setJson(delayedKey, delayedManifest);
    useMemoryOpfs();
    await pullSync(OSS_SYNC_CONFIG);
    assert.equal(await pathMissing(stalePath), true);
    assert.equal(await readPathText(markerPath), 'local');
  } finally {
    restoreBackend();
  }
});

test('concurrent OSS structured edits merge against their common base and consolidate once', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  const path = 'files/concurrent.json';
  try {
    const base = { left: 0, right: 0, keep: true };
    const fromA = { left: 1, right: 0, keep: true };
    const fromB = { left: 0, right: 2, keep: true };
    const makeEntry = async (data, clientId) => {
      const content = formatStructuredContent(path, data);
      const hash = await sha256Text(content);
      const yjsKey = objectKey(OSS_SYNC_CONFIG, __syncInternals.yjsPath(path, hash));
      backend.objects.set(yjsKey, createStructuredUpdate(data));
      return {
        structured: true,
        deleted: false,
        hash,
        hashType: 'content',
        size: new TextEncoder().encode(content).byteLength,
        updatedAt: '2020-01-01T00:00:00.000Z',
        revision: 2,
        revisionBy: clientId,
        yjsKey,
      };
    };
    const baseContent = formatStructuredContent(path, base);
    const baseHash = await sha256Text(baseContent);
    const baseSize = new TextEncoder().encode(baseContent).byteLength;
    const baseYjsKey = objectKey(OSS_SYNC_CONFIG, __syncInternals.yjsPath(path, baseHash));
    backend.objects.set(baseYjsKey, createStructuredUpdate(base));
    const entryA = { ...(await makeEntry(fromA, 'device-a')), baseYjsKey, baseHash, baseSize };
    const entryB = { ...(await makeEntry(fromB, 'device-b')), baseYjsKey, baseHash, baseSize };
    backend.setJson(`${shardPrefix}device-a.json`, causalManifest('device-a', 1, {}, { [path]: entryA }));
    backend.setJson(`${shardPrefix}device-b.json`, causalManifest('device-b', 1, {}, { [path]: entryB }));

    const consolidatingDevice = useMemoryOpfs();
    const pulled = await pullSync(OSS_SYNC_CONFIG);
    assert.deepEqual(JSON.parse(await readPathText(path)), { left: 1, right: 2, keep: true });
    assert.equal(pulled.merged, 1);

    backend.resetRequests();
    const consolidated = await syncNow(OSS_SYNC_CONFIG);
    assert.equal(consolidated.pushed.uploaded, 1);
    const shards = [...backend.objects.keys()]
      .filter((key) => key.startsWith(shardPrefix))
      .map((key) => backend.json(key));
    const consolidation = shards.find((manifest) => (
      manifest.shardMeta.clientId !== 'device-a'
      && manifest.shardMeta.clientId !== 'device-b'
    ));
    assert.ok(consolidation);
    assert.equal(consolidation.files[path].structuredCandidates, undefined);
    assert.equal(consolidation.shardMeta.seen['device-a'], 1);
    assert.equal(consolidation.shardMeta.seen['device-b'], 1);

    useMemoryOpfs();
    const finalPull = await pullSync(OSS_SYNC_CONFIG);
    assert.deepEqual(JSON.parse(await readPathText(path)), { left: 1, right: 2, keep: true });
    assert.equal(finalPull.downloaded, 1);
    assert.equal(finalPull.merged, 0);

    useMemoryOpfs(consolidatingDevice);
    backend.resetRequests();
    const noOp = await syncNow(OSS_SYNC_CONFIG);
    assert.equal(noOp.pushed.uploaded, 0);
    assert.equal(backend.countPayloadPuts(), 0);
    assert.equal(backend.count('putJson'), 0);
  } finally {
    restoreBackend();
  }
});

test('structured heads with different bases keep independent edits without resurrecting a deletion', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  const path = 'files/stalled-branches.json';

  const payload = async (data) => {
    const content = formatStructuredContent(path, data);
    const update = createStructuredUpdate(data);
    const payloadHash = await sha256Bytes(update);
    const yjsKey = objectKey(
      OSS_SYNC_CONFIG,
      __syncInternals.yjsPath(path, payloadHash)
    );
    backend.objects.set(yjsKey, update);
    return {
      hash: await sha256Text(content),
      size: new TextEncoder().encode(content).byteLength,
      payloadHash,
      payloadSize: update.byteLength,
      yjsKey,
    };
  };

  const head = async (data, baseData, revision, revisionBy) => {
    const current = await payload(data);
    const base = await payload(baseData);
    return {
      structured: true,
      deleted: false,
      hashType: 'content',
      updatedAt: '2026-01-01T00:00:00.000Z',
      revision,
      revisionBy,
      ...current,
      baseYjsKey: base.yjsKey,
      baseHash: base.hash,
      baseSize: base.size,
      basePayloadHash: base.payloadHash,
      basePayloadSize: base.payloadSize,
    };
  };

  try {
    const fromA = await head(
      { a: 2, b: 0 },
      { keep: 'old', a: 1, b: 0 },
      3,
      'device-a'
    );
    const fromB = await head(
      { keep: 'old', a: 0, b: 3 },
      { keep: 'old', a: 0, b: 0 },
      2,
      'device-b'
    );
    backend.setJson(`${shardPrefix}device-a.json`, {
      ...causalManifest('device-a', 1, {}, { [path]: fromA }),
      integrityVersion: 3,
    });
    backend.setJson(`${shardPrefix}device-b.json`, {
      ...causalManifest('device-b', 1, {}, { [path]: fromB }),
      integrityVersion: 3,
    });

    useMemoryOpfs();
    await pullSync(OSS_SYNC_CONFIG);
    assert.deepEqual(JSON.parse(await readPathText(path)), { a: 2, b: 3 });
  } finally {
    restoreBackend();
  }
});

test('a causally restored OSS child clears an applied parent tombstone despite clock skew', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  const childPath = 'files/dir/child.md';
  const siblingPath = 'files/dir/sibling.md';
  const parentPath = 'files/dir';
  try {
    const child = await rawManifestEntry(childPath, 'child');
    const sibling = await rawManifestEntry(siblingPath, 'sibling');
    backend.objects.set(child.objectKey, new TextEncoder().encode('child'));
    backend.objects.set(sibling.objectKey, new TextEncoder().encode('sibling'));
    const deletingShardKey = `${shardPrefix}device-a.json`;
    backend.setJson(deletingShardKey, causalManifest('device-a', 1, {}, {
      [childPath]: { ...child, revisionBy: 'device-a' },
      [siblingPath]: { ...sibling, revisionBy: 'device-a' },
    }));

    useMemoryOpfs();
    await pullSync(OSS_SYNC_CONFIG);
    backend.setJson(deletingShardKey, causalManifest('device-a', 2, {}, {
      [parentPath]: {
        deleted: true,
        deletedAt: '2099-01-01T00:00:00.000Z',
        updatedAt: '2099-01-01T00:00:00.000Z',
        revision: 2,
        revisionBy: 'device-a',
        hash: null,
      },
    }));
    await pullSync(OSS_SYNC_CONFIG);
    assert.equal(await pathMissing(childPath), true);
    assert.equal(await pathMissing(siblingPath), true);

    backend.setJson(`${shardPrefix}device-b.json`, causalManifest('device-b', 1, {
      'device-a': 2,
    }, {
      [childPath]: {
        ...child,
        updatedAt: '2020-01-01T00:00:00.000Z',
        revision: 3,
        revisionBy: 'device-b',
      },
      [siblingPath]: {
        deleted: true,
        deletedAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        revision: 3,
        revisionBy: 'device-b',
        hash: sibling.hash,
      },
    }));

    await pullSync(OSS_SYNC_CONFIG);
    assert.equal(await readPathText(childPath), 'child');
    assert.equal(await pathMissing(siblingPath), true);
    assert.ok(backend.objects.has(deletingShardKey), 'the dominated deleting shard remains present');
  } finally {
    restoreBackend();
  }
});

test('production restore markers beat a concurrent shard that inherited the parent tombstone', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  const childPath = 'files/real-dir/child.md';
  const siblingPath = 'files/real-dir/sibling.md';
  const parentPath = 'files/real-dir';
  try {
    const restoringDevice = useMemoryOpfs();
    await writePathText(childPath, 'child restored', { internal: true });
    await writePathText(siblingPath, 'sibling removed', { internal: true });
    await syncNow(OSS_SYNC_CONFIG);
    const initialShardKey = [...backend.objects.keys()].find((key) => key.startsWith(shardPrefix));
    const initialShard = backend.json(initialShardKey);
    const restoringClientId = initialShard.shardMeta.clientId;

    backend.setJson(`${shardPrefix}deleting-device.json`, causalManifest('deleting-device', 1, {
      [restoringClientId]: initialShard.shardMeta.generation,
    }, {
      [parentPath]: {
        deleted: true,
        deletedAt: '2099-01-01T00:00:00.000Z',
        updatedAt: '2099-01-01T00:00:00.000Z',
        revision: 2,
        revisionBy: 'deleting-device',
        hash: null,
      },
    }));

    useMemoryOpfs(restoringDevice);
    await pullSync(OSS_SYNC_CONFIG);
    assert.equal(await pathMissing(childPath), true);
    assert.equal(await pathMissing(siblingPath), true);

    // Recreate through a path that did not run the mutation hook. The push
    // preflight must still recognize this as a restoration rather than delete it.
    await writePathText(childPath, 'child restored', { internal: true });
    await syncNow(OSS_SYNC_CONFIG);
    const restoredShard = [...backend.objects.keys()]
      .filter((key) => key.startsWith(shardPrefix))
      .map((key) => backend.json(key))
      .filter((manifest) => manifest?.shardMeta?.clientId === restoringClientId)
      .sort((left, right) => right.shardMeta.generation - left.shardMeta.generation)[0];
    assert.equal(restoredShard.files[parentPath].restored, true);
    assert.ok(restoredShard.files[parentPath].revision > 2);
    assert.equal(restoredShard.files[siblingPath].deleted, true);

    const unrelated = await rawManifestEntry('unrelated.md', 'concurrent');
    backend.objects.set(unrelated.objectKey, new TextEncoder().encode('concurrent'));
    backend.setJson(`${shardPrefix}stale-carrier.json`, causalManifest('stale-carrier', 1, {
      [restoringClientId]: initialShard.shardMeta.generation,
      'deleting-device': 1,
    }, {
      [parentPath]: {
        deleted: true,
        deletedAt: '2099-01-01T00:00:00.000Z',
        updatedAt: '2099-01-01T00:00:00.000Z',
        revision: 2,
        revisionBy: 'deleting-device',
        hash: null,
      },
      'unrelated.md': { ...unrelated, revisionBy: 'stale-carrier' },
    }));

    useMemoryOpfs();
    await pullSync(OSS_SYNC_CONFIG);
    assert.equal(await readPathText(childPath), 'child restored');
    assert.equal(await pathMissing(siblingPath), true);
    assert.equal(await readPathText('unrelated.md'), 'concurrent');
    assert.equal(backend.requests.filter((request) => (
      request.operation === 'getBytes' && request.key.endsWith('/files/real-dir')
    )).length, 0);
  } finally {
    restoreBackend();
  }
});

test('OSS imports but never rewrites the mutable legacy mirror', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(OSS_SYNC_CONFIG, 'manifest.json');
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  const path = 'files/legacy.json';
  const legacyKey = objectKey(OSS_SYNC_CONFIG, __syncInternals.yjsPath(path));
  const legacyData = { safe: true, count: 1 };
  const legacyContent = formatStructuredContent(path, legacyData);
  backend.objects.set(legacyKey, createStructuredUpdate(legacyData));
  backend.setJson(manifestKey, {
    version: 1,
    updatedAt: '2025-01-01T00:00:00.000Z',
    files: {
      [path]: {
        structured: true,
        deleted: false,
        size: new TextEncoder().encode(legacyContent).byteLength,
        updatedAt: '2025-01-01T00:00:00.000Z',
        yjsKey: legacyKey,
      },
    },
  });
  const legacyMirror = backend.json(manifestKey);
  try {
    useMemoryOpfs();
    await syncNow(OSS_SYNC_CONFIG);
    assert.equal([...backend.objects.keys()].filter((key) => key.startsWith(shardPrefix)).length, 1);
    assert.deepEqual(backend.json(manifestKey), legacyMirror);
    assert.equal(backend.count('putJson', manifestKey), 0);

    const shardKey = [...backend.objects.keys()].find((key) => key.startsWith(shardPrefix));
    const authoritativeEntry = backend.json(shardKey).files[path];
    assert.notEqual(authoritativeEntry.yjsKey, legacyKey);

    // Emulate an old client mutating the object referenced by manifest.json.
    backend.objects.set(legacyKey, createStructuredUpdate({ safe: false, count: 999 }));
    useMemoryOpfs();
    await pullSync(OSS_SYNC_CONFIG);
    assert.deepEqual(JSON.parse(await readPathText(path)), legacyData);
  } finally {
    restoreBackend();
  }
});

test('a tombstone-only legacy OSS manifest is consolidated into a causal shard', async () => {
  const backend = new MemoryBackend();
  const restoreBackend = installBackend(backend);
  const manifestKey = objectKey(OSS_SYNC_CONFIG, 'manifest.json');
  const shardPrefix = `${objectKey(OSS_SYNC_CONFIG, 'manifests')}/`;
  const tombstone = {
    deleted: true,
    deletedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 2,
    revisionBy: 'legacy-device',
    hash: null,
  };
  try {
    backend.setJson(manifestKey, {
      version: 2,
      updatedAt: '2026-01-01T00:00:00.000Z',
      files: { 'files/removed.md': tombstone },
    });
    const legacyBefore = backend.json(manifestKey);

    useMemoryOpfs();
    await syncNow(OSS_SYNC_CONFIG);
    const shardKeys = [...backend.objects.keys()].filter((key) => key.startsWith(shardPrefix));
    assert.equal(shardKeys.length, 1);
    assert.equal(backend.json(shardKeys[0]).files['files/removed.md'].deleted, true);
    assert.deepEqual(backend.json(manifestKey), legacyBefore);
  } finally {
    restoreBackend();
  }
});
