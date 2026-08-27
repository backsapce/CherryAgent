import test from 'node:test';
import assert from 'node:assert/strict';
import { getScheduleWakeupRunAtMs } from './toolWakeupCountdown.js';

test('getScheduleWakeupRunAtMs reads the persisted absolute deadline', () => {
  const runAt = '2026-08-27T08:09:10.000Z';

  assert.equal(getScheduleWakeupRunAtMs({
    name: 'schedule_wakeup',
    status: 'completed',
    result: JSON.stringify({ scheduled: true, run_at: runAt }),
  }), Date.parse(runAt));

  assert.equal(getScheduleWakeupRunAtMs({
    name: 'schedule_wakeup',
    result: { scheduled: true, run_at: runAt },
  }), Date.parse(runAt));
});

test('getScheduleWakeupRunAtMs rejects unrelated or invalid tool results', () => {
  const runAt = '2026-08-27T08:09:10.000Z';

  assert.equal(getScheduleWakeupRunAtMs({
    name: 'read_file',
    result: JSON.stringify({ scheduled: true, run_at: runAt }),
  }), null);
  assert.equal(getScheduleWakeupRunAtMs({
    name: 'schedule_wakeup',
    result: '{broken json',
  }), null);
  assert.equal(getScheduleWakeupRunAtMs({
    name: 'schedule_wakeup',
    result: JSON.stringify({ scheduled: false, run_at: runAt }),
  }), null);
  assert.equal(getScheduleWakeupRunAtMs({
    name: 'schedule_wakeup',
    result: JSON.stringify({ scheduled: true, run_at: 'later' }),
  }), null);
  assert.equal(getScheduleWakeupRunAtMs({ name: 'schedule_wakeup' }), null);
});
