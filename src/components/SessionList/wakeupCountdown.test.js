import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatWakeupCountdown,
  getNextScheduledWakeup,
  hasScheduledWakeup,
} from './wakeupCountdown.js';

test('getNextScheduledWakeup returns the nearest local wake-up', () => {
  const next = getNextScheduledWakeup({
    wakeups: [
      { id: 'later', runAtMs: 30_000 },
      { id: 'invalid', runAtMs: 'soon' },
      { id: 'next', runAtMs: 20_000 },
    ],
  });

  assert.equal(next?.id, 'next');
});

test('sandbox wake-ups count down only while their run is waiting', () => {
  const wakeup = { id: 'remote', runAtMs: 20_000 };
  const waitingSession = {
    wakeups: [{ id: 'local-later', runAtMs: 30_000 }],
    remoteRun: { status: 'waiting', wakeup },
  };
  const runningSession = { remoteRun: { status: 'running', wakeup } };

  assert.equal(hasScheduledWakeup(waitingSession), true);
  assert.equal(getNextScheduledWakeup(waitingSession), wakeup);
  assert.equal(hasScheduledWakeup(runningSession), false);
  assert.equal(getNextScheduledWakeup(runningSession), null);
});

test('hasScheduledWakeup preserves the cancel control for pending metadata without a deadline', () => {
  const session = { wakeups: [{ id: 'pending' }] };

  assert.equal(hasScheduledWakeup(session), true);
  assert.equal(getNextScheduledWakeup(session), null);
});

test('formatWakeupCountdown rounds up, clamps at zero, and supports multi-day delays', () => {
  assert.equal(formatWakeupCountdown(2_001, 1_000), '00:00:02');
  assert.equal(formatWakeupCountdown(61_000, 1_000), '00:01:00');
  assert.equal(formatWakeupCountdown(49 * 3_600_000 + 2 * 60_000 + 3_000, 0), '49:02:03');
  assert.equal(formatWakeupCountdown(1_000, 2_000), '00:00:00');
  assert.equal(formatWakeupCountdown(Number.NaN, 0), '');
});
