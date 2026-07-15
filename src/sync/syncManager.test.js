import assert from 'node:assert/strict';
import test from 'node:test';
import { __syncInternals } from './syncManager.js';

const {
  assertManifestCommitSize,
  assertProspectiveManifestMetadataSize,
  assertProspectiveManifestPathSize,
  canReuseLocalHash,
  compareEntryVersions,
  collectDeletedPaths,
  collectDeletedSessionIds,
  findDeletedAncestor,
  hasDeletedAncestor,
  isSafeSyncPath,
  mapWithConcurrency,
  maxConcurrentRequests,
  maxConcurrentRequestsForEntries,
  makeDeleteEntry,
  manifestIntegrityVersion,
  mergeRemoteManifests,
  mergeSets,
  objectPath,
  preserveLocalOnlyConfig,
  pruneDeletedRecords,
  remoteEntryChanged,
  restoredPathCandidates,
  restoreLocalChangedPathsOverDeletedAncestors,
  stripLocalOnlyConfig,
  stateAfterAppliedRemote,
  structuredBasePath,
  syncBackendIdentity,
  validateRemoteManifest,
  yjsPath,
} = __syncInternals;

test('transfer scheduler limits parallel requests and keeps result order', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  }, 2);

  assert.equal(peak, 2);
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
});

test('transfer concurrency defaults to four and is bounded', () => {
  assert.equal(maxConcurrentRequests({}), 4);
  assert.equal(maxConcurrentRequests({ maxConcurrentRequests: 0 }), 1);
  assert.equal(maxConcurrentRequests({ maxConcurrentRequests: 99 }), 8);
});

test('large files reduce concurrency to bound browser memory pressure', () => {
  const config = { maxConcurrentRequests: 8 };
  assert.equal(maxConcurrentRequestsForEntries(config, [{ size: 1024 }]), 8);
  assert.equal(maxConcurrentRequestsForEntries(config, [{ size: 16 * 1024 * 1024 }]), 2);
  assert.equal(maxConcurrentRequestsForEntries(config, [{ size: 64 * 1024 * 1024 }]), 1);
});

test('transfer scheduler waits for started work after an error', async () => {
  let otherTransferFinished = false;

  await assert.rejects(
    mapWithConcurrency([0, 1, 2], async (value) => {
      if (value === 0) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        throw new Error('network failed');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      otherTransferFinished = true;
    }, 2),
    /network failed/
  );

  assert.equal(otherTransferFinished, true);
});

test('deleted session ids include local tombstones', () => {
  const remoteDeleted = collectDeletedSessionIds({
    'sessions/remote-deleted.json': { deleted: true },
  });
  const localDeleted = collectDeletedSessionIds({
    'sessions/local-deleted.json': { deleted: true },
  });

  assert.deepEqual(
    [...mergeSets(remoteDeleted, localDeleted)].sort(),
    ['local-deleted', 'remote-deleted']
  );
});

test('local deleted paths block remote children from being restored', () => {
  const stateFiles = {
    'sessions/s2.json': { deleted: true, deletedAt: '2026-01-01T00:00:00.000Z' },
    'workspace/agent-a': { deleted: true, deletedAt: '2026-01-01T00:00:00.000Z' },
  };

  assert.ok(collectDeletedPaths(stateFiles).has('sessions/s2.json'));
  assert.ok(hasDeletedAncestor(stateFiles, 'workspace/agent-a/files/note.md'));
});

test('session index is pruned by tombstoned session ids', () => {
  const sessions = [
    { id: 's1', title: 'Keep' },
    { id: 's2', title: 'Deleted' },
  ];

  assert.deepEqual(
    pruneDeletedRecords('session.json', sessions, new Set(['s2']), new Set()),
    [{ id: 's1', title: 'Keep' }]
  );
});

test('restored file paths include deleted directory ancestors', () => {
  assert.deepEqual(
    restoredPathCandidates('workspace/agent-a/skills/demo/SKILL.md'),
    [
      'workspace',
      'workspace/agent-a',
      'workspace/agent-a/skills',
      'workspace/agent-a/skills/demo',
      'workspace/agent-a/skills/demo/SKILL.md',
    ]
  );
});

test('changed local skill files clear remote deleted parent tombstones before push', () => {
  const stateFiles = {};
  const manifestFiles = {
    'workspace/agent-a/skills/demo': { deleted: true, deletedAt: '2026-01-01T00:00:00.000Z' },
  };
  const local = new Map([
    ['workspace/agent-a/skills/demo/SKILL.md', { hash: 'new-skill-hash' }],
  ]);

  assert.equal(restoreLocalChangedPathsOverDeletedAncestors(stateFiles, manifestFiles, local), true);
  assert.equal(manifestFiles['workspace/agent-a/skills/demo'], undefined);
});

test('unchanged local children do not clear remote deleted parent tombstones', () => {
  const stateFiles = {
    'workspace/agent-a/skills/demo/SKILL.md': { hash: 'old-skill-hash', deleted: false },
  };
  const manifestFiles = {
    'workspace/agent-a/skills/demo': { deleted: true, deletedAt: '2026-01-01T00:00:00.000Z' },
  };
  const local = new Map([
    ['workspace/agent-a/skills/demo/SKILL.md', { hash: 'old-skill-hash' }],
  ]);

  assert.equal(restoreLocalChangedPathsOverDeletedAncestors(stateFiles, manifestFiles, local), false);
  assert.equal(manifestFiles['workspace/agent-a/skills/demo'].deleted, true);
});

test('sync projection removes every locally scoped credential without mutating local config', () => {
  const local = {
    theme: 'dark',
    agentTokens: { 'https://sandbox.test': 'agent-secret' },
    agents: [{ url: 'https://sandbox.test', name: 'Local sandbox' }],
    selectedAgent: 'https://sandbox.test',
    dismissedAgents: ['https://old-sandbox.test'],
    sync: { bucket: 'private', accessKeyId: 'ak', secretAccessKey: 'sk' },
    e2b: { apiKey: 'e2b-secret', timeout: 30 },
    llm: {
      apiKey: 'legacy-secret',
      activeProfileId: 'p1',
      profiles: {
        p1: { id: 'p1', provider: 'openai', apiKey: 'llm-secret', model: 'gpt' },
      },
    },
  };

  const projected = stripLocalOnlyConfig(local);
  assert.equal(projected.theme, 'dark');
  assert.equal(projected.agentTokens, undefined);
  assert.equal(projected.agents, undefined);
  assert.equal(projected.selectedAgent, undefined);
  assert.equal(projected.dismissedAgents, undefined);
  assert.equal(projected.sync, undefined);
  assert.deepEqual(projected.e2b, { timeout: 30 });
  assert.equal(projected.llm.apiKey, undefined);
  assert.equal(projected.llm.profiles.p1.apiKey, undefined);
  assert.equal(local.sync.secretAccessKey, 'sk');
  assert.equal(local.llm.profiles.p1.apiKey, 'llm-secret');
});

test('remote config merge preserves only this device credentials', () => {
  const remote = {
    theme: 'light',
    sync: { bucket: 'attacker-bucket', secretAccessKey: 'remote-secret' },
    e2b: { timeout: 60, apiKey: 'remote-e2b-secret' },
    llm: {
      profiles: {
        p1: { id: 'p1', model: 'remote-model', apiKey: 'remote-llm-secret' },
        p2: { id: 'p2', model: 'new-profile', apiKey: 'remote-new-secret' },
      },
    },
  };
  const local = {
    sync: { bucket: 'local-bucket', secretAccessKey: 'local-secret' },
    agentTokens: { local: 'token' },
    agents: [{ url: 'https://local-sandbox.test' }],
    selectedAgent: 'https://local-sandbox.test',
    e2b: { apiKey: 'local-e2b-secret' },
    llm: { profiles: { p1: { apiKey: 'local-llm-secret' } } },
  };

  const merged = preserveLocalOnlyConfig('config.yaml', remote, local);
  assert.deepEqual(merged.sync, local.sync);
  assert.deepEqual(merged.agentTokens, local.agentTokens);
  assert.deepEqual(merged.agents, local.agents);
  assert.equal(merged.selectedAgent, local.selectedAgent);
  assert.equal(merged.e2b.apiKey, 'local-e2b-secret');
  assert.equal(merged.e2b.timeout, 60);
  assert.equal(merged.llm.profiles.p1.apiKey, 'local-llm-secret');
  assert.equal(merged.llm.profiles.p2.apiKey, undefined);
});

test('a synced provider or endpoint change cannot inherit a local API key', () => {
  const local = {
    llm: {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'legacy-local-key',
      profiles: {
        p1: {
          id: 'p1',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'profile-local-key',
        },
      },
    },
  };
  const redirected = {
    llm: {
      provider: 'custom-openai',
      baseUrl: 'https://attacker.example/v1',
      profiles: {
        p1: {
          id: 'p1',
          provider: 'custom-openai',
          baseUrl: 'https://attacker.example/v1',
        },
      },
    },
  };

  const merged = preserveLocalOnlyConfig('config.yaml', redirected, local);
  assert.equal(merged.llm.apiKey, undefined);
  assert.equal(merged.llm.profiles.p1.apiKey, undefined);
});

test('backend identity isolates state by destination and normalizes Aliyun defaults', () => {
  const base = {
    providerPreset: 'aliyun-oss',
    region: 'cn-beijing',
    bucket: 'bucket-a',
    prefix: '/vertex-agent/',
    forcePathStyle: true,
  };
  const derived = syncBackendIdentity(base);
  const explicit = syncBackendIdentity({
    ...base,
    endpoint: 'https://s3.oss-cn-beijing.aliyuncs.com/',
    prefix: 'vertex-agent',
    forcePathStyle: false,
  });
  assert.equal(derived, explicit);
  assert.notEqual(derived, syncBackendIdentity({ ...base, bucket: 'bucket-b' }));
  assert.notEqual(derived, syncBackendIdentity({ ...base, prefix: 'other' }));
  assert.equal(derived, syncBackendIdentity({ ...base, accessKeyId: 'rotated-key' }));
});

test('backend identity preserves case-sensitive custom endpoint paths', () => {
  const base = { providerPreset: 'custom', bucket: 'bucket', prefix: 'prefix' };
  assert.notEqual(
    syncBackendIdentity({ ...base, endpoint: 'https://STORE.example/S3/' }),
    syncBackendIdentity({ ...base, endpoint: 'https://store.example/s3' })
  );
});

test('bucket endpoint identity ignores the unused bucket label', () => {
  const base = {
    providerPreset: 'custom',
    endpoint: 'https://sync.example.com',
    bucketEndpoint: true,
    prefix: 'vertex-agent',
  };
  assert.equal(
    syncBackendIdentity({ ...base, bucket: '' }),
    syncBackendIdentity({ ...base, bucket: 'cosmetic-bucket-name' })
  );
});

test('remote hashes detect changes even when timestamps are reused', () => {
  const previous = { remoteHash: 'old', remoteUpdatedAt: '2026-01-01T00:00:00.000Z' };
  assert.equal(remoteEntryChanged({ hash: 'new', updatedAt: previous.remoteUpdatedAt }, previous), true);
  assert.equal(remoteEntryChanged({ hash: 'old', updatedAt: previous.remoteUpdatedAt }, previous), false);
});

test('sync paths and manifest object references are constrained to the configured namespace', () => {
  for (const path of [
    'workspace/a/files/note.md',
    '配置/说明.md',
    '__proto__',
    'files/constructor/value',
  ]) assert.equal(isSafeSyncPath(path), true);
  for (const path of ['', '/absolute', '../escape', 'workspace/../escape', '.sync/state.json']) {
    assert.equal(isSafeSyncPath(path), false);
  }
  assert.throws(() => validateRemoteManifest({
    version: 2,
    files: { '.sync/state.json': { objectKey: 'vertex-agent/objects/evil' } },
  }, { prefix: 'vertex-agent' }), /unsafe path/i);
  assert.throws(() => validateRemoteManifest({
    version: 2,
    files: { 'files/a.md': { objectKey: 'other-prefix/objects/a' } },
  }, { prefix: 'vertex-agent' }), /outside the configured prefix/i);

  const protoPathManifest = validateRemoteManifest(JSON.parse(`{
    "version": 2,
    "files": {
      "__proto__": { "deleted": true }
    }
  }`), { prefix: 'vertex-agent' });
  assert.equal(Object.getPrototypeOf(protoPathManifest.files), null);
  assert.equal(Object.hasOwn(protoPathManifest.files, '__proto__'), true);
});

test('content-addressed payload keys change with content and retain legacy fallback shape', () => {
  assert.equal(objectPath('files/a.md'), 'objects/ZmlsZXMvYS5tZA');
  assert.equal(
    objectPath('files/a.md', 'a'.repeat(64)),
    `objects/by-hash/aa/${'a'.repeat(64)}`
  );
  assert.equal(yjsPath('config.yaml'), 'yjs/Y29uZmlnLnlhbWw.bin');
  assert.equal(
    yjsPath('config.yaml', 'b'.repeat(64)),
    `yjs/by-hash/bb/${'b'.repeat(64)}.bin`
  );
  assert.equal(
    objectPath(`files/${'deep/'.repeat(700)}note.md`, 'c'.repeat(64)),
    `objects/by-hash/cc/${'c'.repeat(64)}`
  );
});

test('manifest commits are rejected before they can exceed the read ceiling', () => {
  assert.doesNotThrow(() => assertManifestCommitSize({ version: 2, files: {} }));
  assert.throws(
    () => assertManifestCommitSize({
      version: 2,
      files: { huge: { padding: 'x'.repeat(16 * 1024 * 1024) } },
    }),
    /exceeds.*safety limit/i
  );
  const tooMany = Object.create(null);
  for (let index = 0; index <= 20_000; index += 1) tooMany[`f${index}`] = {};
  assert.throws(
    () => assertManifestCommitSize({ version: 2, files: tooMany }),
    /exceeds the 20000-entry safety limit/i
  );
});

test('structured local merge bases use a fixed-length path digest', async () => {
  const basePath = await structuredBasePath(
    `files/${'nested/'.repeat(500)}data.json`,
    {
      providerPreset: 's3',
      bucket: 'bucket',
      prefix: 'vertex-agent',
      accessKeyId: 'key',
    }
  );
  assert.match(basePath, /^\.sync\/bases\/[a-f\d]{32}\/[a-f\d]{64}\.bin$/);
  assert.ok(basePath.split('/').at(-1).length < 255);
  assert.equal(
    basePath,
    await structuredBasePath(`files/${'nested/'.repeat(500)}data.json`, {
      providerPreset: 's3',
      bucket: 'bucket',
      prefix: 'vertex-agent',
      accessKeyId: 'rotated-key',
    })
  );
});

test('cached local hashes are reused only for an exact metadata match', () => {
  const entry = { size: 10, lastModified: 123 };
  assert.equal(canReuseLocalHash(entry, { hash: 'abc', size: 10, lastModified: 123, deleted: false }), true);
  assert.equal(canReuseLocalHash(entry, { hash: 'abc', size: 11, lastModified: 123, deleted: false }), false);
  assert.equal(canReuseLocalHash(entry, { hash: 'abc', size: 10, lastModified: 123, deleted: true }), false);
  assert.equal(canReuseLocalHash(entry, {
    hash: 'abc', size: 10, lastModified: 123, deleted: false, cacheInvalidated: true,
  }), false);
});

test('an edit racing a remote apply remains dirty against the applied baseline', () => {
  const state = stateAfterAppliedRemote({
    hash: 'new-local-edit', size: 12, lastModified: 456,
  }, 'downloaded-remote');
  assert.equal(state.hash, 'downloaded-remote');
  assert.equal(state.cachedHash, 'new-local-edit');
  assert.equal(state.size, -1);
  assert.equal(state.lastModified, -1);
});

test('deleted ancestor lookup includes exact paths only when requested', () => {
  const files = {
    'workspace/a': { deleted: true },
    'workspace/a/files/note.md': { deleted: true },
  };
  assert.equal(findDeletedAncestor(files, 'workspace/a/files/note.md')?.path, 'workspace/a');
  assert.equal(findDeletedAncestor(files, 'workspace/a/files/note.md', true)?.path, 'workspace/a/files/note.md');
});

test('logical entry revisions beat skewed clocks and converge independently of source order', () => {
  const syncConfig = {
    providerPreset: 'aliyun-oss',
    bucket: 'bucket',
    prefix: 'vertex-agent',
  };
  const oldClockFuture = {
    deleted: true,
    deletedAt: '2099-01-01T00:00:00.000Z',
    updatedAt: '2099-01-01T00:00:00.000Z',
    revision: 1,
    revisionBy: 'device-z',
  };
  const newClockPast = {
    deleted: true,
    deletedAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    revision: 2,
    revisionBy: 'device-a',
  };
  assert.ok(compareEntryVersions(newClockPast, oldClockFuture) > 0);

  const sources = [
    { id: 'z.json', manifest: { version: 2, files: { path: oldClockFuture } } },
    { id: 'a.json', manifest: { version: 2, files: { path: newClockPast } } },
  ];
  assert.equal(mergeRemoteManifests(sources, syncConfig).files.path.revision, 2);
  assert.equal(mergeRemoteManifests([...sources].reverse(), syncConfig).files.path.revision, 2);

  const tieA = { ...newClockPast, revisionBy: 'device-a' };
  const tieB = { ...newClockPast, revisionBy: 'device-b' };
  const ties = [
    { id: 'z.json', manifest: { version: 2, files: { path: tieA } } },
    { id: 'a.json', manifest: { version: 2, files: { path: tieB } } },
  ];
  assert.equal(mergeRemoteManifests(ties, syncConfig).files.path.revisionBy, 'device-b');
  assert.equal(mergeRemoteManifests([...ties].reverse(), syncConfig).files.path.revisionBy, 'device-b');
});

test('concurrent structured writers survive different logical revision numbers', () => {
  const syncConfig = {
    providerPreset: 'aliyun-oss',
    bucket: 'bucket',
    prefix: 'vertex-agent',
  };
  const path = 'path.json';
  const entry = (hash, revision, revisionBy) => ({
    structured: true,
    deleted: false,
    hash,
    hashType: 'content',
    size: 2,
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision,
    revisionBy,
    yjsKey: `vertex-agent/${yjsPath(path, hash)}`,
  });
  const fromA = entry('a'.repeat(64), 3, 'device-a');
  const fromB = entry('b'.repeat(64), 2, 'device-b');
  const merged = mergeRemoteManifests([
    { id: 'a.json', manifest: { version: 2, files: { [path]: fromA } } },
    { id: 'b.json', manifest: { version: 2, files: { [path]: fromB } } },
  ], syncConfig).files[path];

  assert.equal(merged.revision, 3);
  assert.deepEqual(
    merged.structuredCandidates.map(({ revisionBy }) => revisionBy).sort(),
    ['device-a', 'device-b']
  );

  const supersededSameWriter = mergeRemoteManifests([
    { id: 'a-old.json', manifest: { version: 2, files: {
      [path]: entry('c'.repeat(64), 2, 'device-a'),
    } } },
    { id: 'a-new.json', manifest: { version: 2, files: { [path]: fromA } } },
  ], syncConfig).files[path];
  assert.equal(supersededSameWriter.structuredCandidates, undefined);
  assert.equal(supersededSameWriter.hash, fromA.hash);
});

test('causal manifest merge deterministically resolves file/descendant conflicts', () => {
  const syncConfig = { bucket: 'bucket', prefix: 'vertex-agent' };
  const entry = (path, revision, revisionBy) => {
    const hash = revisionBy.repeat(64).slice(0, 64);
    return {
      structured: false,
      deleted: false,
      hash,
      hashType: 'content',
      size: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      revision,
      revisionBy,
      objectKey: `vertex-agent/${objectPath(path, hash)}`,
    };
  };
  const parent = entry('files/foo', 1, 'a');
  const child = entry('files/foo/bar.txt', 2, 'b');
  const sources = [
    { id: 'a.json', manifest: { version: 2, files: { 'files/foo': parent } } },
    { id: 'b.json', manifest: { version: 2, files: { 'files/foo/bar.txt': child } } },
  ];
  assert.deepEqual(
    Object.keys(mergeRemoteManifests(sources, syncConfig).files),
    ['files/foo/bar.txt']
  );
  assert.deepEqual(
    Object.keys(mergeRemoteManifests([...sources].reverse(), syncConfig).files),
    ['files/foo/bar.txt']
  );

  parent.revision = 3;
  assert.deepEqual(
    Object.keys(mergeRemoteManifests(sources, syncConfig).files),
    ['files/foo']
  );
});

test('manifest path-size lower bound rejects an impossible commit before payload work', () => {
  const local = new Map();
  const longSegment = 'x'.repeat(850);
  for (let index = 0; index < 19_500; index += 1) {
    local.set(`files/${String(index).padStart(5, '0')}/${longSegment}`, {});
  }
  assert.throws(
    () => assertProspectiveManifestPathSize({}, {}, local),
    /paths alone.*exceed/i
  );
});

test('manifest metadata projection rejects a near-ceiling commit before uploads', () => {
  const manifest = {
    version: 2,
    files: {
      existing: { deleted: true, padding: 'x'.repeat((16 * 1024 * 1024) - (60 * 1024)) },
    },
  };
  const local = new Map([[
    'files/large.bin',
    { hash: 'a'.repeat(64), size: 512 * 1024 * 1024 },
  ]]);
  assert.throws(
    () => assertProspectiveManifestMetadataSize(
      manifest,
      {},
      local,
      { bucket: 'bucket', prefix: 'vertex-agent' },
      'device-a'
    ),
    /exceeds.*safety limit/i
  );
});

test('legacy entries use timestamps and revision-zero tombstones are upgraded before publication', () => {
  assert.ok(compareEntryVersions(
    { updatedAt: '2026-01-02T00:00:00.000Z' },
    { updatedAt: '2026-01-01T00:00:00.000Z' }
  ) > 0);
  const upgraded = makeDeleteEntry({
    deleted: true,
    revision: 0,
    deletedAt: '2026-01-01T00:00:00.000Z',
  }, 'device-a');
  assert.equal(upgraded.revision, 1);
  assert.equal(upgraded.revisionBy, 'device-a');
});

test('manifest validation rejects malformed causal vectors and revision writers', () => {
  const syncConfig = {
    providerPreset: 'aliyun-oss',
    bucket: 'bucket',
    prefix: 'vertex-agent',
  };
  assert.throws(() => validateRemoteManifest({
    version: 2,
    shardMeta: { clientId: 'device-a', generation: 2, seen: { 'device-a': 1 } },
    files: {},
  }, syncConfig), /own generation/i);
  assert.throws(() => validateRemoteManifest({
    version: 2,
    files: { path: { deleted: true, revision: 1, revisionBy: 'bad_writer' } },
  }, syncConfig), /revision writer/i);
  assert.throws(() => validateRemoteManifest({
    version: 2,
    shardMeta: {
      clientId: 'device-a',
      generation: 1,
      seen: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`device-${index}`, 1])),
    },
    files: {},
  }, syncConfig), /device limit/i);
});

test('integrity-v3 manifests require exact sizes and config can never use a raw payload', () => {
  const syncConfig = { bucket: 'bucket', prefix: 'vertex-agent' };
  const hash = 'a'.repeat(64);
  assert.throws(() => validateRemoteManifest({
    version: 2,
    integrityVersion: 3,
    files: {
      'files/missing-size.bin': {
        structured: false,
        hash,
        hashType: 'content',
        objectKey: `vertex-agent/${objectPath('files/missing-size.bin', hash)}`,
      },
    },
  }, syncConfig), /no content size/i);
  assert.throws(() => validateRemoteManifest({
    version: 1,
    files: {
      'config.yaml': {
        structured: false,
        objectKey: `vertex-agent/${objectPath('config.yaml')}`,
      },
    },
  }, syncConfig), /config must use.*redacted structured/i);
});

test('manifest integrity promotion waits for every bounded v3 semantic and payload size', () => {
  const hash = 'a'.repeat(64);
  const raw = {
    structured: false,
    hash,
    hashType: 'content',
    objectKey: `vertex-agent/${objectPath('files/raw.bin', hash)}`,
  };
  assert.equal(manifestIntegrityVersion({ 'files/raw.bin': raw }), 2);
  assert.equal(manifestIntegrityVersion({
    'files/raw.bin': { ...raw, size: 1 },
  }), 3);

  const structured = {
    structured: true,
    hash,
    hashType: 'content',
    size: 1,
    yjsKey: 'vertex-agent/yjs/by-hash/aa/primary.bin',
    payloadHash: hash,
    payloadSize: 1,
    baseYjsKey: 'vertex-agent/yjs/by-hash/aa/base.bin',
    baseHash: hash,
    basePayloadHash: hash,
    basePayloadSize: 1,
    structuredCandidates: [{
      hash,
      hashType: 'content',
      yjsKey: 'vertex-agent/yjs/by-hash/aa/candidate.bin',
      payloadHash: hash,
      payloadSize: 1,
      baseYjsKey: 'vertex-agent/yjs/by-hash/aa/candidate-base.bin',
      baseHash: hash,
      basePayloadHash: hash,
      basePayloadSize: 1,
    }],
  };
  assert.equal(manifestIntegrityVersion({ 'files/data.json': structured }), 2);
  assert.equal(manifestIntegrityVersion({
    'files/data.json': {
      ...structured,
      baseSize: 1,
      structuredCandidates: [{
        ...structured.structuredCandidates[0],
        size: 1,
        baseSize: 512 * 1024 * 1024,
      }],
    },
  }), 3);
  assert.equal(manifestIntegrityVersion({
    'files/data.json': {
      ...structured,
      baseSize: 1,
      structuredCandidates: [{
        ...structured.structuredCandidates[0],
        size: 1,
        baseSize: (512 * 1024 * 1024) + 1,
      }],
    },
  }), 2);
});
