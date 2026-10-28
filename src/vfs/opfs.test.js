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
  deletePath,
  deletePathNonRecursive,
  deleteSession,
  exportToZip,
  importFromZip,
  loadSessionMetadata,
  loadSessionMessages,
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
  const appRoot = await origin.getDirectoryHandle('cherry-agent');
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
  const appRoot = await origin.getDirectoryHandle('cherry-agent');
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
  const appRoot = await origin.getDirectoryHandle('cherry-agent');
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

test('session metadata loads without reading message bodies', async () => {
  const origin = useMemoryOpfs();
  const body = [{ role: 'assistant', content: 'large history body' }];
  await saveSessions([{ id: 'lazy', title: 'Lazy', messages: body }]);

  const appRoot = await origin.getDirectoryHandle('cherry-agent');
  const sessionDir = await appRoot.getDirectoryHandle('sessions');
  const bodyHandle = await sessionDir.getFileHandle('lazy.json');
  const getFile = bodyHandle.getFile.bind(bodyHandle);
  bodyHandle.getFile = async () => {
    throw new Error('message body should not be read');
  };

  assert.deepEqual(await loadSessionMetadata(), [{ id: 'lazy', title: 'Lazy' }]);
  bodyHandle.getFile = getFile;
  assert.deepEqual(await loadSessionMessages('lazy'), body);
});

test('saving metadata-only sessions preserves their existing message bodies', async () => {
  useMemoryOpfs();
  const body = [{ role: 'user', content: 'must survive metadata save' }];
  await saveSessions([{ id: 'sparse', title: 'Before', messages: body }]);

  await saveSessions([{ id: 'sparse', title: 'After' }]);

  assert.deepEqual(await loadSessionMetadata(), [{ id: 'sparse', title: 'After' }]);
  assert.deepEqual(await loadSessionMessages('sparse'), body);
});

test('session recovery journals accept metadata-only session snapshots', async () => {
  useMemoryOpfs();
  const baseline = [{ id: 'one', title: 'Before' }];
  const sessions = [{ id: 'one', title: 'After' }];

  await writeSessionRecoveryJournal({ baseline, sessions });

  assert.deepEqual((await readSessionRecoveryJournal()).sessions, sessions);
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
  const appRoot = await origin.getDirectoryHandle('cherry-agent');
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
  assert.ok(root.entries.has('cherry-agent'));
});

// ─── Session archive (hot tail + gzip chunks) ─────────────────────────────────

import { gzipText } from './compression.js';
import { HOT_KEEP_MESSAGES, chunkFileName, planSessionArchive } from './sessionArchive.js';

function archiveTestMessages(count, prefix = 'arch') {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    role: index % 2 ? 'assistant' : 'user',
    content: `消息 ${index} with mixed 中英文 content and some longer prose to give the serialized body realistic weight.`,
    createdAtMs: 1700000000000 + index * 1000,
  }));
}

async function readSessionDirEntryNames(id) {
  const root = await (await globalThis.navigator.storage.getDirectory())
    .getDirectoryHandle('cherry-agent');
  const sessionsDir = await root.getDirectoryHandle('sessions');
  try {
    const archiveDir = await sessionsDir.getDirectoryHandle(id);
    const names = [];
    for await (const [name] of archiveDir) names.push(name);
    return names;
  } catch {
    return [];
  }
}

test('long sessions split into a hot envelope plus sealed gzip chunks', async () => {
  useMemoryOpfs();
  const id = 'arch-big';
  const all = archiveTestMessages(350);
  await saveSessions([{ id, title: 'big', messages: all }]);

  // 350 messages → region 250 → chunks [0,100) and [100,200) sealed,
  // [200,250) partial stays hot → hot = 150 messages.
  const hotRaw = JSON.parse(await readPathText(`sessions/${id}.json`));
  assert.equal(hotRaw.v, 1);
  assert.equal(hotRaw.chunks.length, 2);
  assert.equal(hotRaw.messages.length, 150);
  assert.deepEqual(
    [...await readSessionDirEntryNames(id)].sort(),
    ['c0000.json.gz', 'c0001.json.gz']
  );
  const chunkBytes = await readPathBytes(`sessions/${id}/c0000.json.gz`);
  assert.equal(chunkBytes[0], 0x1f);
  assert.equal(chunkBytes[1], 0x8b); // gzip magic

  const merged = await loadSessionMessages(id);
  assert.deepEqual(merged, all);
  const loaded = await loadSessions();
  assert.deepEqual(loaded[0].messages, all);
});

test('short sessions keep the historical bare-array file format', async () => {
  useMemoryOpfs();
  const id = 'arch-small';
  const few = archiveTestMessages(80, 'small');
  await saveSessions([{ id, title: 'small', messages: few }]);
  const raw = JSON.parse(await readPathText(`sessions/${id}.json`));
  assert.ok(Array.isArray(raw), 'small sessions must stay a bare array');
  assert.equal(raw.length, 80);
  assert.deepEqual([...await readSessionDirEntryNames(id)], []);
});

test('appending messages appends chunks and never rewrites sealed ones', async () => {
  useMemoryOpfs();
  const id = 'arch-grow';
  const before = archiveTestMessages(350, 'grow');
  await saveSessions([{ id, title: 'grow', messages: before }]);
  const chunk0Before = [...await readPathBytes(`sessions/${id}/c0000.json.gz`)];
  const chunk1Before = [...await readPathBytes(`sessions/${id}/c0001.json.gz`)];

  const after = [...before, ...archiveTestMessages(150, 'grow2').map((m, i) => ({ ...m, id: `grow-new-${i}` }))];
  await saveSessions([{ id, title: 'grow', messages: after }]);

  // 500 messages → region 400 → chunks [0,100),[100,200),[200,300),[300,400)
  // sealed; the region divides evenly so the last slice seals too.
  const names = [...await readSessionDirEntryNames(id)].sort();
  assert.deepEqual(names, ['c0000.json.gz', 'c0001.json.gz', 'c0002.json.gz', 'c0003.json.gz']);
  assert.deepEqual([...await readPathBytes(`sessions/${id}/c0000.json.gz`)], chunk0Before);
  assert.deepEqual([...await readPathBytes(`sessions/${id}/c0001.json.gz`)], chunk1Before);
  assert.deepEqual(await loadSessionMessages(id), after);
});

test('editing archived history rewrites only the affected chunks', async () => {
  useMemoryOpfs();
  const id = 'arch-edit';
  const original = archiveTestMessages(350, 'edit');
  await saveSessions([{ id, title: 'edit', messages: original }]);
  const chunk0Before = [...await readPathBytes(`sessions/${id}/c0000.json.gz`)];
  const chunk1Before = [...await readPathBytes(`sessions/${id}/c0001.json.gz`)];

  original[5] = { ...original[5], content: 'edited archived message' };
  await saveSessions([{ id, title: 'edit', messages: original }]);

  const chunk0After = [...await readPathBytes(`sessions/${id}/c0000.json.gz`)];
  const chunk1After = [...await readPathBytes(`sessions/${id}/c0001.json.gz`)];
  assert.notDeepEqual(chunk0After, chunk0Before);
  assert.deepEqual(chunk1After, chunk1Before);
  assert.deepEqual(await loadSessionMessages(id), original);
});

test('truncating below the archive threshold restores the bare-array format', async () => {
  useMemoryOpfs();
  const id = 'arch-truncate';
  const long = archiveTestMessages(350, 'tr');
  await saveSessions([{ id, title: 'tr', messages: long }]);
  assert.ok((await readSessionDirEntryNames(id)).length > 0);

  const short = long.slice(0, 40);
  await saveSessions([{ id, title: 'tr', messages: short }]);
  const raw = JSON.parse(await readPathText(`sessions/${id}.json`));
  assert.ok(Array.isArray(raw));
  assert.equal(raw.length, 40);
  assert.deepEqual([...await readSessionDirEntryNames(id)], []);
  assert.deepEqual(await loadSessionMessages(id), short);
});

test('deleting a session removes its hot file and chunk directory', async () => {
  useMemoryOpfs();
  const id = 'arch-delete';
  await saveSessions([{ id, title: 'del', messages: archiveTestMessages(250, 'del') }]);
  assert.ok((await readSessionDirEntryNames(id)).length > 0);

  await deleteSession([{ id, title: 'del' }], id);
  await assert.rejects(() => readPathText(`sessions/${id}.json`));
  assert.deepEqual([...await readSessionDirEntryNames(id)], []);
});

test('a damaged chunk skips with a warning instead of failing the session load', async () => {
  useMemoryOpfs();
  const id = 'arch-corrupt';
  await saveSessions([{ id, title: 'corrupt', messages: archiveTestMessages(250, 'corrupt') }]);
  await writePathText(`sessions/${id}/c0000.json.gz`, 'not gzip at all', { internal: true });

  const messages = await loadSessionMessages(id);
  // Chunk 0 (messages 0-99) is unreadable; chunk 1 + hot tail still load.
  assert.ok(messages.length >= 150);
  assert.ok(messages.every((message) => Number(String(message.id).split('-')[1]) >= 100));
});

test('saves self-heal or defer around archive chunks that have not landed', async () => {
  useMemoryOpfs();
  const id = 'arch-defer';
  const all = archiveTestMessages(350, 'defer');
  await saveSessions([{ id, title: 'defer', messages: all }]);
  const chunk0Before = [...await readPathBytes(`sessions/${id}/c0000.json.gz`)];

  // Case 1 - the full history is still in memory (normal app flow) and the
  // body actually changed: the missing chunk file is rewritten from memory,
  // byte-identically, while the untouched sibling chunk stays as-is.
  await deletePath(`sessions/${id}/c0000.json.gz`, { internal: true });
  const healed = [...all, {
    id: 'defer-heal', role: 'user', content: 'changed after the gap', createdAtMs: 1,
  }];
  await saveSessions([{ id, title: 'defer', messages: healed }]);
  assert.deepEqual(
    [...await readPathBytes(`sessions/${id}/c0000.json.gz`)],
    chunk0Before,
    'a changed body must rewrite absent chunk files instead of skipping them'
  );
  assert.equal((await loadSessionMessages(id)).length, 351);

  // Case 2 - the session was opened while the chunk file was absent (an
  // interrupted pull): the truncated in-memory view must not be allowed to
  // rewrite the envelope, because that would orphan the missing chunk.
  const envelopeBefore = await readPathText(`sessions/${id}.json`);
  await deletePath(`sessions/${id}/c0000.json.gz`, { internal: true });
  const truncatedView = await loadSessionMessages(id);
  assert.equal(truncatedView.length, 251, 'chunk 0 messages should be absent from the loaded view');
  const withNewMessage = [...truncatedView, {
    id: 'defer-new', role: 'user', content: 'typed during the sync gap', createdAtMs: 2,
  }];
  await saveSessions([{ id, title: 'defer', messages: withNewMessage }]);
  assert.equal(
    await readPathText(`sessions/${id}.json`),
    envelopeBefore,
    'rewriting the envelope would orphan the missing chunk forever'
  );
  assert.equal((await loadSessionMessages(id)).length, 251, 'a deferred save leaves storage untouched');

  // Case 3 - the pull finishes (chunk file lands) and the app refreshes from
  // storage, re-basing its in-memory edits (here: the gap message) onto the
  // complete history. The deferred save then flushes with nothing lost.
  await writePathText(`sessions/${id}/c0000.json.gz`, new Uint8Array(chunk0Before), { internal: true });
  const rebased = [...await loadSessionMessages(id), withNewMessage.at(-1)];
  await saveSessions([{ id, title: 'defer', messages: rebased }]);
  assert.deepEqual(await loadSessionMessages(id), rebased);
  assert.equal((await loadSessionMessages(id)).length, 352);
});

test('export emits one canonical body per session and import over an archived session converges', async () => {
  useMemoryOpfs();
  const id = 'arch-zip';
  const all = archiveTestMessages(250, 'zip');
  await saveSessions([{ id, title: 'zip', messages: all }]);

  const zipBlob = await exportToZip();
  const zip = new JSZip();
  await zip.loadAsync(await zipBlob.arrayBuffer());
  const bodyText = await zip.file(`sessions/${id}.json`).async('string');
  const body = JSON.parse(bodyText);
  assert.ok(Array.isArray(body), 'exported bodies must be canonical full arrays');
  assert.equal(body.length, 250);
  assert.equal(zip.file(`sessions/${id}/c0000.json.gz`), null, 'chunk files never leak into exports');

  // Re-import the same session: the bare array merges over the envelope, and
  // the merged view contains every message exactly once.
  await importFromZip(await zipBlob.arrayBuffer());
  const merged = await loadSessionMessages(id);
  assert.equal(merged.length, 250);
  assert.deepEqual(merged, all);
});

test('engines without CompressionStream keep everything in the plain hot file', async () => {
  useMemoryOpfs();
  const id = 'arch-nogzip';
  const all = archiveTestMessages(350, 'nogz');
  const { CompressionStream, DecompressionStream } = globalThis;
  try {
    globalThis.CompressionStream = undefined;
    globalThis.DecompressionStream = undefined;
    await saveSessions([{ id, title: 'nogz', messages: all }]);
  } finally {
    globalThis.CompressionStream = CompressionStream;
    globalThis.DecompressionStream = DecompressionStream;
  }
  const raw = JSON.parse(await readPathText(`sessions/${id}.json`));
  assert.ok(Array.isArray(raw));
  assert.equal(raw.length, 350);
  assert.deepEqual([...await readSessionDirEntryNames(id)], []);
  assert.deepEqual(await loadSessionMessages(id), all);
});

test('save/load round-trips preserve hot-tail size guarantees', async () => {
  useMemoryOpfs();
  const id = 'arch-invariants';
  for (const count of [HOT_KEEP_MESSAGES + 1, 250, 1001]) {
    const all = archiveTestMessages(count, `inv${count}`);
    await saveSessions([{ id, title: 'invariants', messages: all }]);
    const raw = JSON.parse(await readPathText(`sessions/${id}.json`));
    const plan = planSessionArchive(all);
    if (plan.chunks.length > 0) {
      assert.ok(raw.messages.length >= HOT_KEEP_MESSAGES, `hot tail too small at ${count}`);
      assert.ok(raw.messages.length < HOT_KEEP_MESSAGES + 200, `hot tail too large at ${count}`);
      assert.deepEqual(raw.chunks.at(-1).index, plan.chunks.at(-1).index);
    } else {
      assert.ok(Array.isArray(raw));
    }
    assert.deepEqual(await loadSessionMessages(id), all);
    // The most recent HOT_KEEP_MESSAGES messages are always uncompressed.
    const recentIds = all.slice(-HOT_KEEP_MESSAGES).map((message) => message.id);
    const hotIds = (Array.isArray(raw) ? raw : raw.messages).map((message) => message.id);
    assert.deepEqual(hotIds.slice(-HOT_KEEP_MESSAGES), recentIds, `recent messages must stay hot at ${count}`);
  }
});

test('chunk payloads decompress to exactly their planned message slices', async () => {
  useMemoryOpfs();
  const id = 'arch-verify';
  const all = archiveTestMessages(450, 'verify');
  await saveSessions([{ id, title: 'verify', messages: all }]);
  const plan = planSessionArchive(all);
  const { gunzipText } = await import('./compression.js');
  for (const chunk of plan.chunks) {
    const bytes = await readPathBytes(`sessions/${id}/${chunkFileName(chunk.index)}`);
    const parsed = JSON.parse(await gunzipText(bytes));
    assert.deepEqual(parsed, all.slice(chunk.start, chunk.end));
  }
});

test('gzip compression measurably shrinks archived chunks', async () => {
  const sample = JSON.stringify(archiveTestMessages(100, 'ratio'));
  const compressed = await gzipText(sample);
  assert.ok(
    compressed.byteLength < sample.length * 0.6,
    `expected <60% ratio, got ${(compressed.byteLength / sample.length * 100).toFixed(1)}%`
  );
});
