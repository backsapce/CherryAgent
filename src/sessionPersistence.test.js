import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionSaveCoordinator } from './sessionPersistence.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function fakeTimers() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    clearTimer(id) {
      callbacks.delete(id);
    },
    runLatest() {
      const entries = [...callbacks.entries()];
      callbacks.clear();
      entries.at(-1)?.[1]();
    },
    setTimer(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
  };
}

test('defers snapshots until the debounce fires and only snapshots the latest source', async () => {
  const timers = fakeTimers();
  const snapshots = [];
  const saves = [];
  const coordinator = createSessionSaveCoordinator({
    save: async (value) => saves.push(value),
    snapshot: (value) => {
      snapshots.push(value);
      return structuredClone(value);
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coordinator.schedule([{ id: 'old' }]);
  coordinator.schedule([{ id: 'new' }]);
  assert.deepEqual(snapshots, []);

  timers.runLatest();
  await coordinator.flush();
  assert.deepEqual(snapshots, [[{ id: 'new' }]]);
  assert.deepEqual(saves, [[{ id: 'new' }]]);
});

test('serializes writes and never commits an older queued generation as the latest baseline', async () => {
  const timers = fakeTimers();
  const first = deferred();
  const second = deferred();
  const started = [];
  const committed = [];
  const coordinator = createSessionSaveCoordinator({
    save: (value) => {
      started.push(value.id);
      return value.id === 'first' ? first.promise : second.promise;
    },
    snapshot: structuredClone,
    onCommitted: (value) => committed.push(value.id),
    onError: () => {},
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coordinator.schedule({ id: 'first' });
  timers.runLatest();
  await Promise.resolve();
  assert.deepEqual(started, ['first']);

  coordinator.schedule({ id: 'second' });
  timers.runLatest();
  const flushing = coordinator.flush();
  first.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ['first', 'second']);
  assert.deepEqual(committed, []);

  second.resolve();
  await flushing;
  assert.deepEqual(committed, ['second']);
});

test('flush snapshots a pending value immediately and waits for its save', async () => {
  const timers = fakeTimers();
  const write = deferred();
  let snapshotCount = 0;
  const coordinator = createSessionSaveCoordinator({
    save: () => write.promise,
    snapshot: (value) => {
      snapshotCount += 1;
      return value;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coordinator.schedule({ id: 'pending' });
  const flushing = coordinator.flush();
  assert.equal(snapshotCount, 1);

  let flushed = false;
  flushing.then(() => { flushed = true; });
  await Promise.resolve();
  assert.equal(flushed, false);

  write.resolve();
  await flushing;
  assert.equal(flushed, true);
});

test('flush is a barrier for a save scheduled while another save is in flight', async () => {
  const timers = fakeTimers();
  const first = deferred();
  const second = deferred();
  const started = [];
  const coordinator = createSessionSaveCoordinator({
    save: (value) => {
      started.push(value.id);
      return value.id === 'first' ? first.promise : second.promise;
    },
    snapshot: structuredClone,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coordinator.schedule({ id: 'first' });
  const flushing = coordinator.flush();
  await Promise.resolve();
  assert.deepEqual(started, ['first']);

  coordinator.schedule({ id: 'second' });
  first.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ['first', 'second']);

  let flushed = false;
  flushing.then(() => { flushed = true; });
  await Promise.resolve();
  assert.equal(flushed, false);

  second.resolve();
  await flushing;
  assert.equal(flushed, true);
});

test('flush drains newer pending work before reporting an earlier save failure', async () => {
  const timers = fakeTimers();
  const first = deferred();
  const second = deferred();
  const started = [];
  const error = new Error('first write failed');
  const coordinator = createSessionSaveCoordinator({
    save: (value) => {
      started.push(value.id);
      return value.id === 'first' ? first.promise : second.promise;
    },
    snapshot: structuredClone,
    onError: () => {},
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coordinator.schedule({ id: 'first' });
  const flushing = coordinator.flush();
  coordinator.schedule({ id: 'second' });
  first.reject(error);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ['first', 'second']);

  second.resolve();
  await assert.rejects(flushing, error);
});

test('flush retries the latest snapshot after a debounced background save fails', async () => {
  const timers = fakeTimers();
  const source = { id: 'latest', messages: ['complete'] };
  const attempts = [];
  const committed = [];
  const errors = [];
  let shouldFail = true;
  const coordinator = createSessionSaveCoordinator({
    save: async (value) => {
      attempts.push(structuredClone(value));
      if (shouldFail) {
        shouldFail = false;
        throw new Error('temporary OPFS failure');
      }
    },
    snapshot: structuredClone,
    onCommitted: (value) => committed.push(structuredClone(value)),
    onError: (error) => errors.push(error.message),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coordinator.schedule(source);
  timers.runLatest();
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The retry uses the immutable snapshot captured by the debounce, not a
  // source object that may have changed since the failed write.
  source.messages.push('mutated-after-snapshot');
  await coordinator.flush();

  assert.deepEqual(attempts, [
    { id: 'latest', messages: ['complete'] },
    { id: 'latest', messages: ['complete'] },
  ]);
  assert.deepEqual(committed, [{ id: 'latest', messages: ['complete'] }]);
  assert.deepEqual(errors, ['temporary OPFS failure']);
});

test('a flush failure remains retryable by the next lifecycle flush', async () => {
  const timers = fakeTimers();
  const error = new Error('storage temporarily unavailable');
  const attempts = [];
  const coordinator = createSessionSaveCoordinator({
    save: async (value) => {
      attempts.push(value.id);
      if (attempts.length === 1) throw error;
    },
    snapshot: structuredClone,
    onError: () => {},
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coordinator.schedule({ id: 'recoverable' });
  await assert.rejects(coordinator.flush(), error);
  await coordinator.flush();

  assert.deepEqual(attempts, ['recoverable', 'recoverable']);
});

test('a newer scheduled snapshot supersedes a failed retry without a stale write', async () => {
  const timers = fakeTimers();
  const attempts = [];
  const committed = [];
  const coordinator = createSessionSaveCoordinator({
    save: async (value) => {
      attempts.push(value.id);
      if (value.id === 'stale') throw new Error('first write failed');
    },
    snapshot: structuredClone,
    onCommitted: (value) => committed.push(value.id),
    onError: () => {},
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coordinator.schedule({ id: 'stale' });
  timers.runLatest();
  await new Promise((resolve) => setTimeout(resolve, 0));

  coordinator.schedule({ id: 'newest' });
  await coordinator.flush();

  assert.deepEqual(attempts, ['stale', 'newest']);
  assert.deepEqual(committed, ['newest']);
});

test('snapshot failures retain the source for a later flush retry', async () => {
  const timers = fakeTimers();
  const snapshots = [];
  const saves = [];
  let shouldFail = true;
  const coordinator = createSessionSaveCoordinator({
    save: async (value) => saves.push(value.id),
    snapshot: (source) => {
      snapshots.push(source.id);
      if (shouldFail) {
        shouldFail = false;
        throw new Error('clone failed');
      }
      return structuredClone(source);
    },
    onError: () => {},
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coordinator.schedule({ id: 'source' });
  timers.runLatest();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await coordinator.flush();

  assert.deepEqual(snapshots, ['source', 'source']);
  assert.deepEqual(saves, ['source']);
});

test('suspends newly scheduled saves across a storage refresh barrier', async () => {
  const timers = fakeTimers();
  const saves = [];
  const coordinator = createSessionSaveCoordinator({
    save: async (value) => saves.push(value.id),
    snapshot: structuredClone,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coordinator.suspend();
  coordinator.schedule({ id: 'during-refresh' });
  timers.runLatest();
  await Promise.resolve();
  assert.deepEqual(saves, []);

  coordinator.resume();
  timers.runLatest();
  await coordinator.flush();
  assert.deepEqual(saves, ['during-refresh']);
});

test('storage barrier flushes only boundary work and holds newer schedules', async () => {
  const timers = fakeTimers();
  const boundaryWrite = deferred();
  const saves = [];
  const coordinator = createSessionSaveCoordinator({
    save: (value) => {
      saves.push(value.id);
      return value.id === 'boundary' ? boundaryWrite.promise : Promise.resolve();
    },
    snapshot: structuredClone,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coordinator.schedule({ id: 'boundary' });
  const acquiring = coordinator.beginBarrier();
  await Promise.resolve();
  assert.deepEqual(saves, ['boundary']);
  assert.equal(coordinator.isSuspended(), true);

  coordinator.schedule({ id: 'during-operation' });
  boundaryWrite.resolve();
  const release = await acquiring;
  assert.deepEqual(saves, ['boundary']);

  release();
  timers.runLatest();
  await coordinator.flush();
  assert.deepEqual(saves, ['boundary', 'during-operation']);
});

test('failed barrier acquisition resumes normal debounced saves', async () => {
  const timers = fakeTimers();
  const error = new Error('boundary write failed');
  const saves = [];
  const coordinator = createSessionSaveCoordinator({
    save: async (value) => {
      saves.push(value.id);
      if (value.id === 'boundary') throw error;
    },
    snapshot: structuredClone,
    onError: () => {},
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coordinator.schedule({ id: 'boundary' });
  await assert.rejects(coordinator.beginBarrier(), error);
  assert.equal(coordinator.isSuspended(), false);

  coordinator.schedule({ id: 'after-failure' });
  timers.runLatest();
  await coordinator.flush();
  assert.deepEqual(saves, ['boundary', 'after-failure']);
});

test('a suspended barrier checkpoints the latest source without touching primary session files', async () => {
  const timers = fakeTimers();
  const events = [];
  const coordinator = createSessionSaveCoordinator({
    save: async (value) => events.push(['save', value[0].id]),
    snapshot: structuredClone,
    checkpoint: async (value, baseline) => {
      events.push(['checkpoint', value[0].id, baseline[0].id]);
    },
    clearCheckpoint: async () => events.push(['clear']),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coordinator.suspend();
  coordinator.schedule([{ id: 'older' }], [{ id: 'baseline' }]);
  coordinator.schedule([{ id: 'latest' }], [{ id: 'baseline' }]);
  timers.runLatest();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(events, [['checkpoint', 'latest', 'baseline']]);

  coordinator.resume();
  timers.runLatest();
  await coordinator.flush();
  assert.deepEqual(events, [
    ['checkpoint', 'latest', 'baseline'],
    ['save', 'latest'],
    ['clear'],
  ]);
});

test('lifecycle checkpoint forces the latest suspended snapshot before its debounce', async () => {
  const timers = fakeTimers();
  const checkpoints = [];
  const coordinator = createSessionSaveCoordinator({
    save: async () => {},
    snapshot: structuredClone,
    checkpoint: async (value, baseline) => checkpoints.push({ value, baseline }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coordinator.suspend();
  coordinator.schedule([{ id: 'old' }], [{ id: 'base' }]);
  coordinator.schedule([{ id: 'new' }], [{ id: 'base' }]);
  await coordinator.checkpoint();

  assert.deepEqual(checkpoints, [{
    value: [{ id: 'new' }],
    baseline: [{ id: 'base' }],
  }]);
});

test('a recovery checkpoint clears only after the normal save is durable', async () => {
  const timers = fakeTimers();
  const durableSave = deferred();
  const events = [];
  const coordinator = createSessionSaveCoordinator({
    save: async () => {
      events.push('save-started');
      await durableSave.promise;
      events.push('save-durable');
    },
    snapshot: structuredClone,
    checkpoint: async () => events.push('checkpoint'),
    clearCheckpoint: async () => events.push('clear'),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coordinator.suspend();
  coordinator.schedule([{ id: 'pending' }], []);
  await coordinator.checkpoint();
  coordinator.resume();
  timers.runLatest();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ['checkpoint', 'save-started']);

  durableSave.resolve();
  await coordinator.flush();
  assert.deepEqual(events, ['checkpoint', 'save-started', 'save-durable', 'clear']);
});

test('a failed primary save retains the recovery checkpoint until a successful retry', async () => {
  const timers = fakeTimers();
  const events = [];
  let attempts = 0;
  const coordinator = createSessionSaveCoordinator({
    save: async () => {
      attempts += 1;
      events.push(`save-${attempts}`);
      if (attempts === 1) throw new Error('primary storage failed');
    },
    snapshot: structuredClone,
    checkpoint: async () => events.push('checkpoint'),
    clearCheckpoint: async () => events.push('clear'),
    onError: () => {},
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coordinator.suspend();
  coordinator.schedule([{ id: 'recoverable' }], []);
  await coordinator.checkpoint();
  coordinator.resume();

  await assert.rejects(coordinator.flush(), /primary storage failed/);
  assert.deepEqual(events, ['checkpoint', 'save-1']);

  await coordinator.flush();
  assert.deepEqual(events, ['checkpoint', 'save-1', 'save-2', 'clear']);
});

test('a checkpoint requested during journal deletion is written after the late clear', async () => {
  const timers = fakeTimers();
  const allowClear = deferred();
  const clearStarted = deferred();
  const events = [];
  const coordinator = createSessionSaveCoordinator({
    save: async (value) => events.push(`save:${value[0].id}`),
    snapshot: structuredClone,
    checkpoint: async (value) => events.push(`checkpoint:${value[0].id}`),
    clearCheckpoint: async () => {
      events.push('clear:start');
      clearStarted.resolve();
      await allowClear.promise;
      events.push('clear:end');
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coordinator.suspend();
  coordinator.schedule([{ id: 'old' }], []);
  await coordinator.checkpoint();
  coordinator.resume();
  timers.runLatest();
  await clearStarted.promise;

  coordinator.suspend();
  coordinator.schedule([{ id: 'new' }], []);
  const newerCheckpoint = coordinator.checkpoint();
  await Promise.resolve();
  assert.deepEqual(events, ['checkpoint:old', 'save:old', 'clear:start']);

  allowClear.resolve();
  await newerCheckpoint;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, [
    'checkpoint:old',
    'save:old',
    'clear:start',
    'clear:end',
    'checkpoint:new',
  ]);
});
