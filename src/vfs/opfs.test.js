import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import {
  ZIP_IMPORT_MAX_ENTRIES,
  ZIP_IMPORT_MAX_FILE_BYTES,
  ZIP_IMPORT_MAX_TOTAL_BYTES,
  SESSION_RECOVERY_MAX_BYTES,
  SESSION_RECOVERY_MAX_SESSIONS,
  ZipImportValidationError,
  clearSessionRecoveryJournal,
  deletePathNonRecursive,
  deleteSession,
  exportToZip,
  importFromZip,
  loadSessions,
  readSessionRecoveryJournal,
  readText,
  readPathBytes,
  readPathText,
  saveSessions,
  validateSessionRecoveryJournal,
  writeSessionRecoveryJournal,
  writePathText,
} from './opfs.js';

class MemoryFileHandle {
  kind = 'file';

  constructor(name) {
    this.name = name;
    this.blob = new Blob([]);
    this.lastModified = 1;
  }

  async getFile() {
    return new File([this.blob], this.name, { lastModified: this.lastModified });
  }

  async createWritable() {
    const chunks = [];
    return {
      write: async (content) => chunks.push(content),
      close: async () => {
        this.blob = new Blob(chunks);
        this.lastModified += 1;
      },
    };
  }
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
    const existing = this.entries.get(name);
    if (!existing) throw new Error(`Entry not found: ${name}`);
    if (existing.kind === 'directory' && existing.entries.size > 0 && !options.recursive) {
      throw new DOMException('Directory contains entries', 'InvalidModificationError');
    }
    this.entries.delete(name);
  }

  async *[Symbol.asyncIterator]() {
    yield* this.entries;
  }
}

function useMemoryOpfs() {
  const originRoot = new MemoryDirectoryHandle();
  if (!globalThis.navigator) {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {},
    });
  }
  Object.defineProperty(globalThis.navigator, 'storage', {
    configurable: true,
    value: { getDirectory: async () => originRoot },
  });
  return originRoot;
}

async function zipBytes(entries) {
  const zip = new JSZip();
  for (const entry of entries) {
    zip.file(entry.path, entry.data ?? null, {
      createFolders: entry.createFolders ?? true,
      dir: Boolean(entry.dir),
    });
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

function setCentralDirectoryUncompressedSize(bytes, size) {
  const signature = [0x50, 0x4b, 0x01, 0x02];
  for (let i = 0; i <= bytes.length - signature.length; i += 1) {
    if (signature.every((value, offset) => bytes[i + offset] === value)) {
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(i + 24, size, true);
      return bytes;
    }
  }
  throw new Error('Central-directory entry not found');
}

async function expectValidationError(input, root, code, options = undefined) {
  await assert.rejects(
    importFromZip(input, options),
    (error) => error instanceof ZipImportValidationError
      && error.code === code
      && error.message.length > 0
  );
  assert.equal(root.entries.size, 0, 'preflight rejection must happen before OPFS is opened');
}

test('ZIP import preserves nested binary bytes', async () => {
  useMemoryOpfs();
  const binary = new Uint8Array([0, 255, 1, 128, 42, 13]);
  const input = await zipBytes([
    { path: 'files/nested/blob.bin', data: binary },
  ]);

  await importFromZip(input);

  assert.deepEqual([...await readPathBytes('files/nested/blob.bin')], [...binary]);
});

test('non-recursive sync deletion never removes concurrent descendants', async () => {
  useMemoryOpfs();
  await writePathText('files/raced/child.txt', 'new user data', { internal: true });

  assert.equal(
    await deletePathNonRecursive('files/raced', { internal: true }),
    false
  );
  assert.equal(await readPathText('files/raced/child.txt'), 'new user data');
});

test('non-recursive sync deletion is idempotent for files and missing paths', async () => {
  useMemoryOpfs();
  await writePathText('files/old.txt', 'old', { internal: true });

  assert.equal(await deletePathNonRecursive('files/old.txt', { internal: true }), true);
  assert.equal(await deletePathNonRecursive('files/old.txt', { internal: true }), true);
  await assert.rejects(readPathText('files/old.txt'), /not found/i);
});

test('malformed session storage fails closed and is left untouched', async () => {
  useMemoryOpfs();
  const malformed = '{"id":';
  await writePathText('session.json', malformed, { internal: true });

  await assert.rejects(loadSessions(), /invalid JSON in session\.json/i);
  assert.equal(await readPathText('session.json'), malformed);
});

test('parseable non-array session storage is not mistaken for a missing index', async () => {
  useMemoryOpfs();
  await writePathText('session.json', 'null', { internal: true });

  await assert.rejects(loadSessions(), /session\.json must contain a JSON array/i);
  assert.equal(await readPathText('session.json'), 'null');
});

test('generic text reads propagate storage I/O failures instead of treating them as missing', async () => {
  const origin = useMemoryOpfs();
  await writePathText('memory/MEMORY.md', 'important', { internal: true });
  const appRoot = await origin.getDirectoryHandle('vertex-agent');
  const memoryDir = await appRoot.getDirectoryHandle('memory');
  const handle = await memoryDir.getFileHandle('MEMORY.md');
  handle.getFile = async () => {
    const error = new Error('transient OPFS read failure');
    error.name = 'UnknownError';
    throw error;
  };

  await assert.rejects(readText(memoryDir, 'MEMORY.md'), /transient OPFS read failure/);
});

test('session deletion stays committed when orphan-body cleanup fails', async () => {
  const origin = useMemoryOpfs();
  const sessions = [
    { id: 'delete-me', title: 'Delete', messages: [{ role: 'user', content: 'gone' }] },
    { id: 'keep-me', title: 'Keep', messages: [{ role: 'user', content: 'safe' }] },
  ];
  await saveSessions(sessions);
  const appRoot = await origin.getDirectoryHandle('vertex-agent');
  const sessionDir = await appRoot.getDirectoryHandle('sessions');
  const removeEntry = sessionDir.removeEntry.bind(sessionDir);
  sessionDir.removeEntry = async (name, options) => {
    if (name === 'delete-me.json') throw new Error('cleanup denied');
    return removeEntry(name, options);
  };
  const originalWarn = console.warn;
  let backup;
  console.warn = () => {};
  try {
    const remaining = await deleteSession(sessions, 'delete-me');
    assert.deepEqual(remaining.map(({ id }) => id), ['keep-me']);
    assert.deepEqual((await loadSessions()).map(({ id }) => id), ['keep-me']);
    assert.equal(sessionDir.entries.has('delete-me.json'), true);
    backup = await exportToZip();
    const zip = await JSZip.loadAsync(await backup.arrayBuffer());
    assert.equal(zip.file('sessions/delete-me.json'), null);
    assert.ok(zip.file('sessions/keep-me.json'));
  } finally {
    console.warn = originalWarn;
  }

  useMemoryOpfs();
  await importFromZip(backup);
  assert.deepEqual(
    (await loadSessions()).map(({ id, messages }) => ({ id, content: messages[0]?.content })),
    [{ id: 'keep-me', content: 'safe' }]
  );
});

test('unchanged session messages are not rewritten after save or reload', async () => {
  const origin = useMemoryOpfs();
  const sessions = [{
    id: 'stable',
    title: 'Stable',
    messages: [{ role: 'user', content: 'large body '.repeat(1000) }],
  }];

  await saveSessions(sessions);
  const appRoot = await origin.getDirectoryHandle('vertex-agent');
  const sessionDir = await appRoot.getDirectoryHandle('sessions');
  const bodyHandle = await sessionDir.getFileHandle('stable.json');
  const firstModified = bodyHandle.lastModified;

  await saveSessions(structuredClone(sessions));
  assert.equal(bodyHandle.lastModified, firstModified);

  const reloaded = await loadSessions();
  await saveSessions(structuredClone(reloaded));
  assert.equal(bodyHandle.lastModified, firstModified);

  reloaded[0].messages.push({ role: 'assistant', content: 'changed' });
  await saveSessions(reloaded);
  assert.ok(bodyHandle.lastModified > firstModified);
});

test('session recovery journal round-trips strictly and remains local to .sync', async () => {
  useMemoryOpfs();
  const baseline = [{ id: 'one', title: 'Before', messages: [] }];
  const sessions = [{
    id: 'one',
    title: 'After',
    messages: [{ id: 'message-one', role: 'user', content: 'recover me' }],
  }];

  await writeSessionRecoveryJournal({ baseline, sessions });
  assert.deepEqual(await readSessionRecoveryJournal(), {
    version: 1,
    baseline,
    sessions,
  });

  const backup = await exportToZip();
  const zip = await JSZip.loadAsync(await backup.arrayBuffer());
  assert.equal(zip.file('.sync/session-recovery.json'), null);
  assert.equal(zip.file('session.json'), null);

  const recoveryBackup = await exportToZip({ materializeSessionRecovery: true });
  const recoveryZip = await JSZip.loadAsync(await recoveryBackup.arrayBuffer());
  assert.equal(recoveryZip.file('.sync/session-recovery.json'), null);
  assert.deepEqual(
    JSON.parse(await recoveryZip.file('session.json').async('string')),
    [{ id: 'one', title: 'After' }]
  );
  assert.deepEqual(
    JSON.parse(await recoveryZip.file('sessions/one.json').async('string')),
    sessions[0].messages
  );

  await clearSessionRecoveryJournal();
  assert.equal(await readSessionRecoveryJournal(), null);

  useMemoryOpfs();
  await importFromZip(recoveryBackup);
  assert.deepEqual(await loadSessions(), sessions);
});

test('recovery export replaces corrupt primary session files with a validated journal', async () => {
  useMemoryOpfs();
  const journalSessions = [{
    id: 'recover-corrupt-primary',
    title: 'Recovered',
    updatedAtMs: 300,
    messages: [{ id: 'recovered-message', role: 'user', content: 'journal survives' }],
  }];
  await writePathText('session.json', '{"truncated":', { internal: true });
  await writePathText(
    'sessions/unreachable.json',
    '[{"id":"unreachable","role":"user","content":"must not leak"}]',
    { internal: true }
  );
  await writeSessionRecoveryJournal({ baseline: [], sessions: journalSessions });

  const backup = await exportToZip({ materializeSessionRecovery: true });
  const zip = await JSZip.loadAsync(await backup.arrayBuffer());
  assert.equal(zip.file('.sync/session-recovery.json'), null);
  assert.equal(zip.file('sessions/unreachable.json'), null);
  assert.deepEqual(
    JSON.parse(await zip.file('session.json').async('string')).map(({ id }) => id),
    ['recover-corrupt-primary']
  );

  useMemoryOpfs();
  await importFromZip(backup);
  assert.deepEqual(await loadSessions(), journalSessions);
});

test('ordinary export drops an interrupted orphan body when no index was published', async () => {
  useMemoryOpfs();
  await writePathText(
    'sessions/interrupted.json',
    '[{"id":"draft","role":"user","content":"uncommitted"}]',
    { internal: true }
  );
  await writePathText('files/committed.txt', 'keep', { internal: true });

  const backup = await exportToZip();
  const zip = await JSZip.loadAsync(await backup.arrayBuffer());
  assert.equal(zip.file('sessions/interrupted.json'), null);
  assert.equal(zip.file('session.json'), null);
  assert.equal(await zip.file('files/committed.txt').async('string'), 'keep');

  useMemoryOpfs();
  await importFromZip(backup);
  assert.equal(await readPathText('files/committed.txt'), 'keep');
  assert.deepEqual(await loadSessions(), []);
});

test('corrupt recovery journals fail closed without changing their bytes', async () => {
  useMemoryOpfs();
  const corrupt = '{"version":1,"baseline":[';
  await writePathText('.sync/session-recovery.json', corrupt, { internal: true });
  await writePathText('files/ordinary.txt', 'still exportable', { internal: true });

  await assert.rejects(readSessionRecoveryJournal(), /recovery journal is invalid.*JSON/i);
  await assert.rejects(
    exportToZip({ materializeSessionRecovery: true }),
    /recovery journal is invalid.*JSON/i
  );
  assert.equal(await readPathText('.sync/session-recovery.json'), corrupt);

  const ordinaryBackup = await exportToZip();
  const ordinaryZip = await JSZip.loadAsync(await ordinaryBackup.arrayBuffer());
  assert.equal(ordinaryZip.file('.sync/session-recovery.json'), null);
  assert.equal(await ordinaryZip.file('files/ordinary.txt').async('string'), 'still exportable');
});

test('recovery journal validation rejects unsafe, duplicate, and excessive session records', () => {
  const validSession = (id) => ({ id, messages: [] });
  for (const sessions of [
    [{ id: '../escape', messages: [] }],
    [validSession(1), validSession('1')],
    Array.from(
      { length: SESSION_RECOVERY_MAX_SESSIONS + 1 },
      (_value, index) => validSession(`session-${index}`)
    ),
  ]) {
    assert.throws(
      () => validateSessionRecoveryJournal({ version: 1, baseline: [], sessions }),
      /recovery journal is invalid/i
    );
  }
});

test('oversized recovery journals are rejected before their content is read', async () => {
  const origin = useMemoryOpfs();
  await writePathText('.sync/session-recovery.json', '{}', { internal: true });
  const appRoot = await origin.getDirectoryHandle('vertex-agent');
  const syncDir = await appRoot.getDirectoryHandle('.sync');
  const handle = await syncDir.getFileHandle('session-recovery.json');
  let contentRead = false;
  handle.getFile = async () => ({
    size: SESSION_RECOVERY_MAX_BYTES + 1,
    arrayBuffer: async () => {
      contentRead = true;
      throw new Error('must not read');
    },
  });

  await assert.rejects(readSessionRecoveryJournal(), /exceeds.*byte limit/i);
  assert.equal(contentRead, false);
});

test('unsafeOriginalName traversal rejects the whole archive before valid files are written', async () => {
  const root = useMemoryOpfs();
  const input = await zipBytes([
    { path: 'safe.bin', data: new Uint8Array([1]), createFolders: false },
    { path: '../escape.bin', data: new Uint8Array([2]), createFolders: false },
  ]);

  await expectValidationError(input, root, 'UNSAFE_PATH');
});

test('absolute, drive, backslash, and non-canonical paths are rejected', async (t) => {
  for (const path of ['/absolute.bin', 'C:/drive.bin', 'folder\\escape.bin', 'folder//empty.bin']) {
    await t.test(path, async () => {
      const root = useMemoryOpfs();
      const input = await zipBytes([
        { path, data: new Uint8Array([1]), createFolders: false },
      ]);
      await expectValidationError(input, root, 'UNSAFE_PATH');
    });
  }
});

test('overlong and deeply nested ZIP paths are rejected before OPFS access', async (t) => {
  for (const path of [
    `${'x'.repeat(256)}.txt`,
    `${Array.from({ length: 65 }, () => 'd').join('/')}/file.txt`,
  ]) {
    await t.test(path.slice(0, 80), async () => {
      const root = useMemoryOpfs();
      const input = await zipBytes([{ path, data: 'blocked', createFolders: false }]);
      await expectValidationError(input, root, 'UNSAFE_PATH');
    });
  }
});

test('compressed ZIP input size is checked before reading the archive or opening OPFS', async () => {
  const root = useMemoryOpfs();
  const input = await zipBytes([{ path: 'valid.txt', data: 'content', createFolders: false }]);
  await expectValidationError(input, root, 'ARCHIVE_TOO_LARGE', { maxArchiveBytes: 1 });
});

test('reserved .sync content rejects the whole archive instead of being silently skipped', async () => {
  const root = useMemoryOpfs();
  const input = await zipBytes([
    { path: 'valid.bin', data: new Uint8Array([1]), createFolders: false },
    { path: '.sync/state.json', data: '{}', createFolders: false },
  ]);

  await expectValidationError(input, root, 'RESERVED_PATH');
});

test('invalid structured backup content rejects the archive before any write', async () => {
  const root = useMemoryOpfs();
  const input = await zipBytes([
    { path: 'valid.bin', data: new Uint8Array([1]), createFolders: false },
    { path: 'session.json', data: '{broken', createFolders: false },
  ]);

  await expectValidationError(input, root, 'INVALID_CONTENT');
});

test('ZIP session indexes reject null and non-object records before any write', async (t) => {
  for (const record of [null, 'session', 42, []]) {
    await t.test(JSON.stringify(record), async () => {
      const root = useMemoryOpfs();
      const input = await zipBytes([
        { path: 'valid.bin', data: 'untouched', createFolders: false },
        { path: 'session.json', data: JSON.stringify([record]), createFolders: false },
      ]);

      await expectValidationError(input, root, 'INVALID_CONTENT');
    });
  }
});

test('ZIP session indexes reject missing, unsafe, and duplicate ids before any write', async (t) => {
  const cases = [
    { name: 'missing', sessions: [{}], code: 'UNSAFE_SESSION_ID' },
    { name: 'null', sessions: [{ id: null }], code: 'UNSAFE_SESSION_ID' },
    { name: 'empty', sessions: [{ id: '' }], code: 'UNSAFE_SESSION_ID' },
    { name: 'traversal', sessions: [{ id: '../escape' }], code: 'UNSAFE_SESSION_ID' },
    { name: 'separator', sessions: [{ id: 'folder/session' }], code: 'UNSAFE_SESSION_ID' },
    { name: 'control', sessions: [{ id: 'bad\u0000id' }], code: 'UNSAFE_SESSION_ID' },
    {
      name: 'duplicate canonical id',
      sessions: [{ id: 1 }, { id: '1' }],
      code: 'DUPLICATE_SESSION_ID',
    },
  ];

  for (const { name, sessions, code } of cases) {
    await t.test(name, async () => {
      const root = useMemoryOpfs();
      const input = await zipBytes([
        { path: 'valid.bin', data: 'untouched', createFolders: false },
        { path: 'session.json', data: JSON.stringify(sessions), createFolders: false },
      ]);

      await expectValidationError(input, root, code);
    });
  }
});

test('ZIP session indexes and body files must describe the same ids', async (t) => {
  const cases = [
    {
      name: 'indexed session without a body',
      entries: [{ path: 'session.json', data: '[{"id":"one"}]', createFolders: false }],
    },
    {
      name: 'body without an index',
      entries: [{ path: 'sessions/one.json', data: '[]' }],
    },
    {
      name: 'orphan body beside a different indexed session',
      entries: [
        { path: 'session.json', data: '[{"id":"one"}]', createFolders: false },
        { path: 'sessions/two.json', data: '[]' },
      ],
    },
  ];

  for (const { name, entries } of cases) {
    await t.test(name, async () => {
      const root = useMemoryOpfs();
      await expectValidationError(
        await zipBytes([{ path: 'valid.bin', data: 'untouched', createFolders: false }, ...entries]),
        root,
        'INCONSISTENT_SESSION_DATA'
      );
    });
  }
});

test('ZIP session message bodies reject non-object records before any write', async (t) => {
  for (const message of [null, 'message', 42, []]) {
    await t.test(JSON.stringify(message), async () => {
      const root = useMemoryOpfs();
      const input = await zipBytes([
        { path: 'session.json', data: '[{"id":"one"}]', createFolders: false },
        { path: 'sessions/one.json', data: JSON.stringify([message]) },
      ]);

      await expectValidationError(input, root, 'INVALID_CONTENT');
    });
  }
});

test('ZIP session storage rejects body paths that cannot map to one session id', async (t) => {
  const cases = [
    { path: 'sessions/.json', code: 'UNSAFE_SESSION_ID' },
    { path: 'sessions/nested/one.json', code: 'INVALID_SESSION_PATH' },
    { path: 'messages/one.txt', code: 'INVALID_SESSION_PATH' },
  ];
  for (const { path, code } of cases) {
    await t.test(path, async () => {
      const root = useMemoryOpfs();
      const input = await zipBytes([
        { path: 'session.json', data: '[]', createFolders: false },
        { path, data: '[]' },
      ]);

      await expectValidationError(input, root, code);
    });
  }
});

test('ZIP import preserves a valid mixed current and legacy session backup', async () => {
  useMemoryOpfs();
  const input = await zipBytes([
    {
      path: 'session.json',
      data: JSON.stringify([
        { id: 'current', title: 'Current' },
        { id: 'legacy', title: 'Legacy' },
      ]),
      createFolders: false,
    },
    {
      path: 'sessions/current.json',
      data: JSON.stringify([{ role: 'user', content: 'current message' }]),
    },
    {
      path: 'messages/legacy.json',
      data: JSON.stringify([{ role: 'assistant', content: 'legacy message' }]),
    },
  ]);

  await importFromZip(input);

  const sessions = await loadSessions();
  assert.deepEqual(
    sessions.map(({ id, messages }) => ({ id, content: messages[0]?.content })),
    [
      { id: 'current', content: 'current message' },
      { id: 'legacy', content: 'legacy message' },
    ]
  );
});

test('ZIP import preserves an empty session index backup', async () => {
  useMemoryOpfs();
  const input = await zipBytes([
    { path: 'session.json', data: '[]', createFolders: false },
  ]);

  await importFromZip(input);
  assert.deepEqual(await loadSessions(), []);
});

test('entry-count limit is enforced before writes', async () => {
  const root = useMemoryOpfs();
  const input = await zipBytes([
    { path: 'one.bin', data: '1', createFolders: false },
    { path: 'two.bin', data: '2', createFolders: false },
    { path: 'three.bin', data: '3', createFolders: false },
  ]);

  await expectValidationError(input, root, 'TOO_MANY_ENTRIES', { maxEntries: 2 });
});

test('per-file uncompressed-size limit is enforced before writes', async () => {
  const root = useMemoryOpfs();
  const input = await zipBytes([
    { path: 'small.bin', data: new Uint8Array([1]), createFolders: false },
    { path: 'large.bin', data: new Uint8Array([1, 2, 3, 4, 5]), createFolders: false },
  ]);

  await expectValidationError(input, root, 'FILE_TOO_LARGE', {
    maxFileBytes: 4,
    maxTotalBytes: 20,
  });
});

test('aggregate uncompressed-size limit is enforced before writes', async () => {
  const root = useMemoryOpfs();
  const input = await zipBytes([
    { path: 'first.bin', data: new Uint8Array([1, 2, 3]), createFolders: false },
    { path: 'second.bin', data: new Uint8Array([4, 5, 6]), createFolders: false },
  ]);

  await expectValidationError(input, root, 'TOTAL_TOO_LARGE', {
    maxFileBytes: 5,
    maxTotalBytes: 5,
  });
});

test('actual decompressed bytes are bounded when ZIP metadata understates the size', async () => {
  const root = useMemoryOpfs();
  const zip = new JSZip();
  zip.file('misreported.bin', new Uint8Array(10), { createFolders: false });
  const input = setCentralDirectoryUncompressedSize(
    await zip.generateAsync({ type: 'uint8array', compression: 'STORE' }),
    1
  );

  await expectValidationError(input, root, 'FILE_TOO_LARGE', {
    maxFileBytes: 5,
    maxTotalBytes: 20,
  });
});

test('ZIP import hard limits are exported and remain compatible with valid overrides', async () => {
  assert.equal(ZIP_IMPORT_MAX_ENTRIES, 10_000);
  assert.equal(ZIP_IMPORT_MAX_FILE_BYTES, 64 * 1024 * 1024);
  assert.equal(ZIP_IMPORT_MAX_TOTAL_BYTES, 256 * 1024 * 1024);

  const root = useMemoryOpfs();
  const input = await zipBytes([
    { path: 'one.bin', data: '1', createFolders: false },
    { path: 'two.bin', data: '2', createFolders: false },
  ]);
  await importFromZip(input, { maxEntries: ZIP_IMPORT_MAX_ENTRIES + 1 });
  assert.ok(root.entries.has('vertex-agent'));
});
