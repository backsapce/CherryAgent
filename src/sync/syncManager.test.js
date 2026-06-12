import assert from 'node:assert/strict';
import test from 'node:test';
import { __syncInternals } from './syncManager.js';

const {
  collectDeletedPaths,
  collectDeletedSessionIds,
  hasDeletedAncestor,
  mergeSets,
  pruneDeletedRecords,
  restoredPathCandidates,
  restoreLocalChangedPathsOverDeletedAncestors,
} = __syncInternals;

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
