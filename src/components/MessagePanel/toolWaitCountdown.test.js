import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatWaitDuration,
  getWaitCommandStartedAtMs,
  getWaitCommandWaitSeconds,
} from './toolWaitCountdown.js';

test('getWaitCommandWaitSeconds applies the 30 second default and clamps', () => {
  assert.equal(getWaitCommandWaitSeconds({ name: 'wait_command' }), 30);
  assert.equal(getWaitCommandWaitSeconds({
    name: 'wait_command',
    parsedArgs: { wait_seconds: 90 },
  }), 90);
  assert.equal(getWaitCommandWaitSeconds({
    name: 'wait_command',
    parsedArgs: { wait_seconds: 0 },
  }), 30);
  assert.equal(getWaitCommandWaitSeconds({
    name: 'wait_command',
    parsedArgs: { wait_seconds: 99_999_999 },
  }), 7 * 24 * 60 * 60);
  assert.equal(getWaitCommandWaitSeconds({
    name: 'get_command',
    parsedArgs: { wait_seconds: 90 },
  }), null);
});

test('getWaitCommandWaitSeconds prefers a runtime-reported slice budget', () => {
  assert.equal(getWaitCommandWaitSeconds({
    name: 'wait_command',
    parsedArgs: { wait_seconds: 3_600 },
    waitBudgetSeconds: 60,
  }), 60);
  assert.equal(getWaitCommandWaitSeconds({
    name: 'wait_command',
    waitBudgetSeconds: 0,
  }), 30);
});

test('getWaitCommandStartedAtMs parses the recorded start timestamp', () => {
  const startedAt = '2026-09-14T08:09:10.000Z';
  assert.equal(getWaitCommandStartedAtMs({
    name: 'wait_command',
    startedAt,
  }), Date.parse(startedAt));
  assert.equal(getWaitCommandStartedAtMs({ name: 'wait_command' }), null);
  assert.equal(getWaitCommandStartedAtMs({
    name: 'wait_command',
    startedAt: 'not a date',
  }), null);
});

test('formatWaitDuration renders compact human durations', () => {
  assert.equal(formatWaitDuration(30), '30s');
  assert.equal(formatWaitDuration(45), '45s');
  assert.equal(formatWaitDuration(300), '5m');
  assert.equal(formatWaitDuration(630), '10m');
  assert.equal(formatWaitDuration(3600), '1h');
  assert.equal(formatWaitDuration(7500), '2h 05m');
  assert.equal(formatWaitDuration(86_400), '1d');
  assert.equal(formatWaitDuration(604_800), '7d');
});
