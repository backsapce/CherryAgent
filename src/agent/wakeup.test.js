import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWakeupMessage,
  createWakeup,
  createOrReplaceTurnWakeup,
  findNextWakeup,
  wakeupDelayToSeconds,
} from './wakeup.js';

test('wakeupDelayToSeconds converts an explicit unit without model-side arithmetic', () => {
  assert.equal(wakeupDelayToSeconds(10, 'minutes'), 600);
  assert.equal(wakeupDelayToSeconds(2, 'hours'), 7_200);
  assert.throws(() => wakeupDelayToSeconds(0, 'minutes'), /positive integer/);
  assert.throws(() => wakeupDelayToSeconds(10, 'minute'), /unit must be/);
});

test('createWakeup validates and resolves a relative delay', () => {
  assert.deepEqual(createWakeup({ id: 'wake-1', delaySeconds: 30, prompt: ' check build ', now: 1_000 }), {
    id: 'wake-1',
    prompt: 'check build',
    createdAtMs: 1_000,
    runAtMs: 31_000,
  });
  assert.throws(() => createWakeup({ id: 'bad', delaySeconds: 1, prompt: 'soon' }), /between 5 and/);
  assert.throws(() => createWakeup({ id: 'bad', delaySeconds: 5, prompt: ' ' }), /prompt is required/);
});

test('createOrReplaceTurnWakeup reuses duplicates and replaces changed requests', () => {
  const first = createOrReplaceTurnWakeup({
    id: 'wake-1',
    delaySeconds: 600,
    prompt: 'check build',
    now: 1_000,
  });
  const duplicate = createOrReplaceTurnWakeup({
    currentWakeup: first,
    id: 'ignored',
    delaySeconds: 600,
    prompt: ' check build ',
    now: 5_000,
  });
  const replacement = createOrReplaceTurnWakeup({
    currentWakeup: first,
    id: 'ignored',
    delaySeconds: 900,
    prompt: 'check later',
    now: 5_000,
  });

  assert.strictEqual(duplicate, first);
  assert.equal(replacement.id, first.id);
  assert.equal(replacement.prompt, 'check later');
  assert.equal(replacement.runAtMs, 905_000);
});

test('findNextWakeup skips claimed and malformed records', () => {
  const sessions = [
    { id: 'a', wakeups: [{ id: 'later', runAtMs: 30 }] },
    { id: 'b', wakeups: [{ id: 'claimed', runAtMs: 10 }, { id: 'next', runAtMs: 20 }] },
  ];
  assert.equal(findNextWakeup(sessions, new Set(['claimed'])).wakeup.id, 'next');
});

test('buildWakeupMessage carries the saved instruction', () => {
  assert.match(buildWakeupMessage({ prompt: 'check deployment' }), /check deployment/);
  assert.match(buildWakeupMessage({ prompt: 'check deployment' }), /schedule another wake-up/);
});
