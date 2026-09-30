import assert from 'node:assert/strict';
import test from 'node:test';
import { syncProgressDetail, syncProgressLabel, syncProgressPercent } from './progress.js';

const t = (key, params) => {
  const labels = {
    'syncSettings.progressPulling': 'Pulling',
    'syncSettings.progressCommitting': 'Committing manifest',
    'syncSettings.progressCount': '{done}/{total}',
    'syncSettings.working': 'Working...',
  };
  return (labels[key] || key)
    .replace('{done}', params?.done ?? '')
    .replace('{total}', params?.total ?? '');
};

test('percent prefers transferred bytes and clamps to 0-100', () => {
  assert.equal(syncProgressPercent(null), null);
  assert.equal(syncProgressPercent({ phase: 'connect', done: 0, total: null }), null);
  assert.equal(syncProgressPercent({ phase: 'pull', done: 3, total: 4 }), 75);
  assert.equal(syncProgressPercent({ phase: 'pull', done: 1, total: 4, doneBytes: 10, totalBytes: 20 }), 50);
  assert.equal(syncProgressPercent({ phase: 'pull', done: 0, total: 4, doneBytes: 30, totalBytes: 20 }), 100);
  assert.equal(syncProgressPercent({ phase: 'pull', done: 5, total: 4 }), 100);
});

test('labels compose phase, percent, and item counts', () => {
  assert.equal(syncProgressLabel(null, t), '');
  assert.equal(syncProgressLabel({ phase: 'commit', done: 0, total: null }, t), 'Committing manifest');
  assert.equal(syncProgressLabel({ phase: 'pull', done: 3, total: 4 }, t), 'Pulling 75%');
  assert.equal(syncProgressDetail({ phase: 'pull', done: 3, total: 4 }, t), 'Pulling 75% (3/4)');
  assert.equal(syncProgressDetail({ phase: 'commit', done: 0, total: null }, t), 'Committing manifest');
});
