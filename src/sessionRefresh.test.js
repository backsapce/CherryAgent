import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reconcileSessionRecoveryJournal,
  reconcileStoredSessions,
  snapshotSessions,
} from './sessionRefresh.js';

function session(id, updatedAtMs, content = id) {
  return {
    id,
    title: id,
    updatedAtMs,
    messages: [{ id: `${id}-message`, role: 'user', content }],
  };
}

test('persisted snapshots are isolated from later in-memory mutations', () => {
  const current = session('draft', 100, 'persisted value');
  const snapshot = snapshotSessions([current]);

  current.messages[0].content = 'mutated after save';

  assert.equal(snapshot[0].messages[0].content, 'persisted value');
});

test('a remote deletion removes an unchanged in-memory session', () => {
  const first = session('first', 100);
  const deletedRemotely = session('deleted-remotely', 200);
  const persisted = snapshotSessions([first, deletedRemotely]);

  const result = reconcileStoredSessions(
    [first],
    [first, deletedRemotely],
    persisted
  );

  assert.deepEqual(result.sessions.map(({ id }) => id), ['first']);
  assert.equal(result.needsPersist, false);
});

test('an unsaved local edit survives a remote deletion', () => {
  const persisted = session('draft', 100, 'persisted');
  const edited = session('draft', 300, 'unsaved edit');

  const result = reconcileStoredSessions([], [edited], [persisted]);

  assert.deepEqual(result.sessions, [edited]);
  assert.equal(result.needsPersist, true);
});

test('only dirty local sessions override refreshed storage', () => {
  const clean = session('clean', 100, 'old local value');
  const dirty = session('dirty', 200, 'old dirty value');
  const removedRemotely = session('removed', 300);
  const remoteClean = session('clean', 400, 'new remote value');
  const localDirty = session('dirty', 500, 'unsaved local value');
  const remoteNew = session('remote-new', 600);

  const result = reconcileStoredSessions(
    [remoteClean, remoteNew],
    [clean, localDirty, removedRemotely],
    [clean, dirty, removedRemotely]
  );

  assert.deepEqual(result.sessions.map(({ id }) => id), ['remote-new', 'dirty', 'clean']);
  assert.equal(result.sessions.find(({ id }) => id === 'clean').messages[0].content, 'new remote value');
  assert.equal(result.sessions.find(({ id }) => id === 'dirty').messages[0].content, 'unsaved local value');
  assert.equal(result.needsPersist, true);
});

test('a new unsaved session survives refresh and is persisted', () => {
  const remote = session('remote', 100);
  const localDraft = session('local-draft', 200);

  const result = reconcileStoredSessions([remote], [remote, localDraft], [remote]);

  assert.deepEqual(result.sessions.map(({ id }) => id), ['local-draft', 'remote']);
  assert.equal(result.needsPersist, true);
});

test('an unsaved local deletion is not restored from storage', () => {
  const kept = session('kept', 100);
  const locallyDeleted = session('locally-deleted', 200);

  const result = reconcileStoredSessions(
    [kept, locallyDeleted],
    [kept],
    [kept, locallyDeleted]
  );

  assert.deepEqual(result.sessions.map(({ id }) => id), ['kept']);
  assert.equal(result.needsPersist, true);
});

test('matching local and remote unsaved content does not schedule a redundant save', () => {
  const persisted = session('same', 100, 'old');
  const updated = session('same', 200, 'same new value');

  const result = reconcileStoredSessions([updated], [updated], [persisted]);

  assert.deepEqual(result.sessions, [updated]);
  assert.equal(result.needsPersist, false);
});

test('a local metadata edit retains a remotely appended message', () => {
  const persisted = session('shared', 100, 'base');
  const local = snapshotSessions([persisted])[0];
  local.title = 'locally renamed';
  local.updatedAtMs = 200;
  const remote = snapshotSessions([persisted])[0];
  remote.messages.push({ id: 'remote-message-2', role: 'assistant', content: 'remote reply' });
  remote.updatedAtMs = 300;

  const result = reconcileStoredSessions([remote], [local], [persisted]);
  const merged = result.sessions[0];
  assert.equal(merged.title, 'locally renamed');
  assert.deepEqual(
    merged.messages.map(({ content }) => content),
    ['base', 'remote reply']
  );
  assert.equal(result.needsPersist, true);
});

test('concurrent local and remote message appends are both retained deterministically', () => {
  const persisted = session('shared', 100, 'base');
  const local = snapshotSessions([persisted])[0];
  local.messages.push({ id: 'zz-local', role: 'user', content: 'local append' });
  const remote = snapshotSessions([persisted])[0];
  remote.messages.push({ id: 'aa-remote', role: 'assistant', content: 'remote append' });

  const localView = reconcileStoredSessions([remote], [local], [persisted]).sessions[0];
  const remoteView = reconcileStoredSessions([local], [remote], [persisted]).sessions[0];
  assert.deepEqual(localView.messages, remoteView.messages);
  assert.deepEqual(
    localView.messages.map(({ content }) => content),
    ['base', 'remote append', 'local append']
  );
});

test('remote reply checkpoints merge atomically by durable event sequence', () => {
  const metadataBaseline = {
    id: 'shared',
    title: 'shared',
    updatedAtMs: 100,
  };
  const reply = (sequence, content) => ({
    id: 'remote-reply',
    role: 'assistant',
    content,
    thinking: `thinking-${sequence}`,
    toolCalls: [{ id: `call-${sequence}`, status: 'completed' }],
    transcript: [{ id: `text-${sequence}`, type: 'text', content }],
    usage: { total_tokens: sequence },
    runStartedAt: `2026-01-01T00:00:${sequence}.000Z`,
    runFinishedAt: sequence === 12 ? null : `2026-01-01T00:00:${sequence + 1}.000Z`,
    remoteEventSequence: sequence,
    remoteReasoningParsers: { reasoning: { mode: sequence === 12 ? 'text' : 'reasoning' } },
    reaction: sequence === 10 ? 'saved-metadata' : 'local-metadata',
  });
  const saved = {
    ...metadataBaseline,
    updatedAtMs: 110,
    messages: [reply(10, 'Hello')],
  };
  const local = {
    ...metadataBaseline,
    updatedAtMs: 120,
    messages: [reply(12, 'Hello world')],
  };

  const merged = reconcileStoredSessions(
    [saved],
    [local],
    [metadataBaseline]
  ).sessions[0].messages[0];

  for (const field of [
    'content',
    'thinking',
    'toolCalls',
    'transcript',
    'usage',
    'runStartedAt',
    'runFinishedAt',
    'remoteEventSequence',
    'remoteReasoningParsers',
  ]) {
    assert.deepEqual(merged[field], local.messages[0][field]);
  }
  assert.equal(merged.remoteEventSequence, 12);
  assert.equal(merged.content, 'Hello world');

  const reverse = reconcileStoredSessions(
    [local],
    [saved],
    [metadataBaseline]
  ).sessions[0].messages[0];
  for (const field of [
    'content',
    'thinking',
    'toolCalls',
    'transcript',
    'usage',
    'runStartedAt',
    'runFinishedAt',
    'remoteEventSequence',
    'remoteReasoningParsers',
  ]) {
    assert.deepEqual(reverse[field], local.messages[0][field]);
  }
});

test('concurrent scalar metadata conflicts converge independently of device perspective', () => {
  const persisted = session('shared', 100, 'base');
  const local = { ...snapshotSessions([persisted])[0], title: 'Alpha' };
  const remote = { ...snapshotSessions([persisted])[0], title: 'Zulu' };

  const left = reconcileStoredSessions([remote], [local], [persisted]).sessions[0];
  const right = reconcileStoredSessions([local], [remote], [persisted]).sessions[0];
  assert.equal(left.title, right.title);
  assert.equal(left.title, 'Zulu');
});

test('three-way session merge preserves __proto__ as data without prototype injection', () => {
  const persisted = session('shared', 100, 'base');
  persisted.metadata = JSON.parse('{"__proto__":{"value":"base"}}');
  const local = snapshotSessions([persisted])[0];
  const remote = snapshotSessions([persisted])[0];
  local.metadata.__proto__.value = 'local';
  remote.metadata.__proto__.value = 'remote';

  const merged = reconcileStoredSessions([remote], [local], [persisted]).sessions[0];
  assert.equal(Object.getPrototypeOf(merged.metadata), Object.prototype);
  assert.equal(Object.hasOwn(merged.metadata, '__proto__'), true);
  assert.equal(['local', 'remote'].includes(merged.metadata.__proto__.value), true);
  assert.equal(Object.prototype.value, undefined);
});

test('a stale crash journal cannot roll back a newer durable session', () => {
  const journalBaseline = session('shared', 100, 'old durable value');
  const staleJournal = snapshotSessions([journalBaseline]);
  const newerDurable = session('shared', 300, 'new durable value');

  const result = reconcileStoredSessions(
    [newerDurable],
    staleJournal,
    [journalBaseline]
  );

  assert.deepEqual(result.sessions, [newerDurable]);
  assert.equal(result.needsPersist, false);
});

test('a stale journal for a newly created session cannot replace its newer durable copy', () => {
  const staleJournalSession = session('new-session', 100, 'checkpoint before durable save');
  const newerDurable = session('new-session', 300, 'durable content after checkpoint');

  const result = reconcileSessionRecoveryJournal([newerDurable], {
    version: 1,
    baseline: [],
    sessions: [staleJournalSession],
  });

  assert.deepEqual(result.sessions, [newerDurable]);
  assert.equal(result.needsPersist, false);
});

test('a genuinely newer journal for a newly created session is still recovered', () => {
  const olderDurable = session('new-session', 100, 'durable partial value');
  const newerJournal = session('new-session', 300, 'unsaved value');

  const result = reconcileSessionRecoveryJournal([olderDurable], {
    version: 1,
    baseline: [],
    sessions: [newerJournal],
  });

  assert.deepEqual(result.sessions, [newerJournal]);
  assert.equal(result.needsPersist, true);
});
