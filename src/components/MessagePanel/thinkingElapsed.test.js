import assert from 'node:assert/strict';
import test from 'node:test';
import {
  elapsedSeconds,
  resolveThinkingElapsed,
  timestampOf,
} from './thinkingElapsed.js';

test('an absolute thinking start continues across component remounts', () => {
  const startedAt = '2026-08-31T00:00:00.000Z';

  assert.equal(resolveThinkingElapsed({
    startedAt,
    isThinking: true,
    nowMs: '2026-08-31T00:00:05.000Z',
  }), 5);
  // A remounted block uses the same persisted start, not its new mount time.
  assert.equal(resolveThinkingElapsed({
    startedAt,
    isThinking: true,
    nowMs: '2026-08-31T00:00:12.000Z',
  }), 12);
});

test('a finished thinking duration remains fixed as wall-clock time advances', () => {
  const startedAt = '2026-08-31T00:00:00.000Z';
  const finishedAt = '2026-08-31T00:00:07.900Z';

  assert.equal(resolveThinkingElapsed({
    startedAt,
    finishedAt,
    isThinking: false,
    nowMs: '2026-08-31T00:01:00.000Z',
  }), 7);
  assert.equal(resolveThinkingElapsed({
    startedAt,
    finishedAt,
    isThinking: false,
    nowMs: '2026-08-31T01:00:00.000Z',
  }), 7);
});

test('a stopped reply without a finish timestamp does not keep aging', () => {
  assert.equal(resolveThinkingElapsed({
    startedAt: '2026-08-31T00:00:00.000Z',
    finishedAt: null,
    isThinking: false,
    nowMs: '2026-08-31T12:00:00.000Z',
  }), null);
});

test('thinking elapsed time handles numeric, invalid, and future timestamps', () => {
  assert.equal(timestampOf(1_000), 1_000);
  assert.equal(elapsedSeconds(1_000, 3_500), 2);
  assert.equal(elapsedSeconds(3_500, 1_000), 0);
  assert.equal(elapsedSeconds('not-a-date', '2026-08-31T00:00:00.000Z'), null);
  assert.equal(elapsedSeconds(null, null), null);
});
