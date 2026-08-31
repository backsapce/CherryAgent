import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertRemoteRunSnapshot,
  captureRemoteReplyFields,
  findSessionReply,
  finishReplyRunTiming,
  isSlowRemoteRetryError,
  markConfirmedRemoteRunFailure,
  markRemoteRunPollError,
  normalizeRemoteAgentEvent,
  prepareRemoteEventReplay,
  shouldPersistRemoteReplayProgress,
  shouldRetryRemoteRunFailure,
  upsertSessionReply,
} from './remoteRunState.js';

test('a metadata-only wake-up hydrates history and upserts its assistant reply', () => {
  const stored = [
    { id: 'user-1', role: 'user', content: 'start the long task' },
    { id: 'reply-1', role: 'assistant', content: 'waiting' },
  ];

  const messages = upsertSessionReply(undefined, stored, 'reply-1', {
    content: 'finished after waking',
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, 'start the long task');
  assert.equal(findSessionReply(messages, 'reply-1').content, 'finished after waking');
});

test('a missing durable reply placeholder is appended without losing history', () => {
  const stored = [{ id: 'user-1', role: 'user', content: 'start' }];
  const messages = upsertSessionReply(undefined, stored, 'reply-1', { content: 'done' });

  assert.deepEqual(messages.map((message) => message.id), ['user-1', 'reply-1']);
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].content, 'done');
});

test('an explicitly loaded conversation takes precedence over a stale fallback', () => {
  const current = [{ id: 'current', role: 'user', content: 'current' }];
  const fallback = [{ id: 'stale', role: 'user', content: 'stale' }];
  const messages = upsertSessionReply(current, fallback, 'reply-1');

  assert.deepEqual(messages.map((message) => message.id), ['current', 'reply-1']);
});

test('force-detaching a run seals its reply timing without resetting its start', () => {
  const messages = [
    {
      id: 'reply-1',
      role: 'assistant',
      content: '',
      runStartedAt: '2026-01-01T00:00:00.000Z',
      transcript: [{
        id: 'reasoning-1',
        type: 'reasoning',
        content: 'Partial reasoning.',
        status: 'streaming',
        startedAt: '2026-01-01T00:00:00.000Z',
      }],
    },
    { id: 'reply-2', role: 'assistant', content: 'untouched' },
  ];
  const finished = finishReplyRunTiming(
    messages,
    'reply-1',
    '2026-01-01T00:00:09.000Z',
    '2026-01-01T00:00:01.000Z'
  );

  assert.equal(finished[0].runStartedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(finished[0].runFinishedAt, '2026-01-01T00:00:09.000Z');
  assert.equal(finished[0].transcript[0].status, 'finished');
  assert.equal(finished[0].transcript[0].finishedAt, '2026-01-01T00:00:09.000Z');
  assert.strictEqual(finished[1], messages[1]);
  assert.strictEqual(finishReplyRunTiming(messages, 'missing', '2026-01-01T00:00:09.000Z'), messages);
});

test('legacy replies rebuild from event zero instead of duplicating their saved transcript', () => {
  const legacyReply = {
    id: 'reply-legacy',
    role: 'assistant',
    content: 'already rendered',
    transcript: [{ id: 'old-text', type: 'text', content: 'already rendered' }],
  };

  assert.deepEqual(prepareRemoteEventReplay(legacyReply, true), {
    cursor: 0,
    seed: null,
  });

  const currentReply = { ...legacyReply, remoteEventSequence: 42 };
  assert.deepEqual(prepareRemoteEventReplay(currentReply, true), {
    cursor: 42,
    seed: currentReply,
  });
  assert.equal(shouldPersistRemoteReplayProgress({
    remoteExecution: true,
    hasAppliedRemoteEvents: false,
    savedReply: legacyReply,
  }), false);
  assert.equal(shouldPersistRemoteReplayProgress({
    remoteExecution: true,
    hasAppliedRemoteEvents: true,
    savedReply: legacyReply,
  }), true);
});

test('remote run snapshots must belong to the expected run and use a known status', () => {
  const waiting = { id: 'run-one', status: 'waiting' };
  assert.strictEqual(assertRemoteRunSnapshot(waiting, 'run-one'), waiting);
  assert.throws(
    () => assertRemoteRunSnapshot({ id: 'run-one', status: 'sleeping' }, 'run-one'),
    (error) => error.code === 'AGENT_RUN_INVALID_RESPONSE'
  );
  assert.throws(
    () => assertRemoteRunSnapshot({ id: 'another-run', status: 'running' }, 'run-one'),
    (error) => error.code === 'AGENT_RUN_INVALID_RESPONSE'
  );
});

test('reply fields capture content and cursor from one immutable checkpoint', () => {
  const firstParsers = { reasoning: { mode: 'text', pending: '' } };
  const captured = captureRemoteReplyFields(
    { content: 'batch one', transcript: [{ content: 'batch one' }] },
    12,
    firstParsers
  );

  // Simulate the streaming closure advancing before React runs its updater.
  const laterCursor = 19;
  const laterParsers = { reasoning: { mode: 'reasoning', pending: '<think' } };
  assert.equal(laterCursor, 19);
  assert.notStrictEqual(laterParsers, firstParsers);
  assert.equal(captured.content, 'batch one');
  assert.equal(captured.remoteEventSequence, 12);
  assert.strictEqual(captured.remoteReasoningParsers, firstParsers);
});

test('request failures keep only persisted server-owned runs resumable', () => {
  const base = {
    remoteExecution: true,
    remoteRunId: 'run-one',
    recoverable: true,
    reachedAcceptedTerminal: false,
    confirmedFailureStatus: null,
  };
  assert.equal(shouldRetryRemoteRunFailure({ ...base, error: new Error('timeout') }), true);
  assert.equal(shouldRetryRemoteRunFailure({ ...base, recoverable: false, error: new Error('start failed') }), false);
  // Request failures do not prove that the server-owned run stopped. Client
  // errors use a slower retry cadence but keep the durable run resumable.
  assert.equal(shouldRetryRemoteRunFailure({ ...base, error: Object.assign(new Error('forbidden'), { status: 403 }) }), true);
  assert.equal(shouldRetryRemoteRunFailure({ ...base, error: Object.assign(new Error('outdated'), { code: 'AGENT_RUN_PROTOCOL_OUTDATED' }) }), true);
  assert.equal(isSlowRemoteRetryError(Object.assign(new Error('too large'), { status: 413 })), true);
  assert.equal(isSlowRemoteRetryError(Object.assign(new Error('busy'), { status: 429 })), true);
  assert.equal(isSlowRemoteRetryError(Object.assign(new Error('unavailable'), { status: 503 })), false);
});

test('transient polling failures preserve a waiting run for reattachment', () => {
  const waiting = {
    id: 'run-one',
    status: 'waiting',
    wakeup: { id: 'wake-one', runAtMs: 123 },
  };
  const next = markRemoteRunPollError(waiting, 'run-one', new Error('temporary timeout'), 456);

  assert.equal(next.status, 'waiting');
  assert.deepEqual(next.wakeup, waiting.wakeup);
  assert.equal(next.lastPollError, 'temporary timeout');
  assert.equal(next.lastPollErrorAtMs, 456);
  assert.strictEqual(
    markConfirmedRemoteRunFailure(next, 'run-one', null, new Error('temporary timeout')),
    next
  );
});

test('only a server-confirmed terminal status marks a remote run failed', () => {
  const running = { id: 'run-one', status: 'running' };
  const failed = markConfirmedRemoteRunFailure(
    running,
    'run-one',
    'interrupted',
    new Error('server restarted')
  );

  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'server restarted');
  assert.strictEqual(
    markConfirmedRemoteRunFailure(running, 'another-run', 'error', 'wrong owner'),
    running
  );
});

test('remote events use durable sequence and wake-turn namespaces idempotently', () => {
  const legacy = normalizeRemoteAgentEvent({
    type: 'tool-result',
    runId: 'logical-turn-two',
    sequence: 3,
    remoteSequence: 103,
    stepId: 'step-1',
    toolCallId: 'call-1',
    requestId: 'call-1',
    permission: { id: 'call-1', toolCallId: 'call-1', kind: 'doom-loop' },
  });

  assert.equal(legacy.sequence, 103);
  assert.equal(legacy.stepId, 'logical-turn-two:step-1');
  assert.equal(legacy.toolCallId, 'logical-turn-two:call-1');
  assert.equal(legacy.permission.id, legacy.requestId);
  assert.equal(legacy.permission.toolCallId, legacy.toolCallId);
  assert.deepEqual(normalizeRemoteAgentEvent(legacy), legacy);
});
