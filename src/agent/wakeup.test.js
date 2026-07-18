import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWakeupMessage,
  createWakeup,
  findNextWakeup,
} from './wakeup.js';

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
