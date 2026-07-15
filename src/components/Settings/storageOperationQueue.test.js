import assert from 'node:assert/strict';
import test from 'node:test';
import { enqueueStorageOperation } from './storageOperationQueue.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test('storage operations remain serialized across independent callers', async () => {
  const firstGate = deferred();
  const events = [];

  const enqueueFromFirstSettingsInstance = () => enqueueStorageOperation(async () => {
    events.push('first:start');
    await firstGate.promise;
    events.push('first:end');
  });
  const enqueueFromReopenedSettingsInstance = () => enqueueStorageOperation(async () => {
    events.push('second:start');
    events.push('second:end');
  });

  const first = enqueueFromFirstSettingsInstance();
  await Promise.resolve();
  const second = enqueueFromReopenedSettingsInstance();
  await Promise.resolve();

  assert.deepEqual(events, ['first:start']);
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('a rejected storage operation does not poison the shared queue', async () => {
  const expected = new Error('import failed');
  await assert.rejects(
    enqueueStorageOperation(async () => {
      throw expected;
    }),
    expected
  );

  assert.equal(await enqueueStorageOperation(async () => 'recovered'), 'recovered');
});
