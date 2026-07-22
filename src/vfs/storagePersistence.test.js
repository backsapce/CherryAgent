import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getStoragePersistenceStatus,
  requestPersistentStorage,
  STORAGE_PERSISTENCE_STATUS,
} from './storagePersistence.js';

test('storage persistence reports unsupported browsers', async () => {
  assert.equal(
    await getStoragePersistenceStatus({}),
    STORAGE_PERSISTENCE_STATUS.UNSUPPORTED
  );
  assert.equal(
    await requestPersistentStorage({}),
    STORAGE_PERSISTENCE_STATUS.UNSUPPORTED
  );
});

test('storage persistence reports the current browser durability', async () => {
  assert.equal(
    await getStoragePersistenceStatus({ persisted: async () => true }),
    STORAGE_PERSISTENCE_STATUS.PERSISTENT
  );
  assert.equal(
    await getStoragePersistenceStatus({ persisted: async () => false }),
    STORAGE_PERSISTENCE_STATUS.BEST_EFFORT
  );
});

test('storage persistence does not request an already-granted permission', async () => {
  let requests = 0;
  const result = await requestPersistentStorage({
    persisted: async () => true,
    persist: async () => {
      requests += 1;
      return true;
    },
  });

  assert.equal(result, STORAGE_PERSISTENCE_STATUS.PERSISTENT);
  assert.equal(requests, 0);
});

test('storage persistence requests protection and preserves a denial result', async () => {
  assert.equal(
    await requestPersistentStorage({
      persisted: async () => false,
      persist: async () => true,
    }),
    STORAGE_PERSISTENCE_STATUS.PERSISTENT
  );
  assert.equal(
    await requestPersistentStorage({
      persisted: async () => false,
      persist: async () => false,
    }),
    STORAGE_PERSISTENCE_STATUS.BEST_EFFORT
  );
});

test('storage persistence converts browser API failures into an unknown state', async () => {
  assert.equal(
    await getStoragePersistenceStatus({
      persisted: async () => { throw new Error('permission failure'); },
    }),
    STORAGE_PERSISTENCE_STATUS.UNKNOWN
  );
  assert.equal(
    await requestPersistentStorage({
      persisted: async () => false,
      persist: async () => { throw new Error('permission failure'); },
    }),
    STORAGE_PERSISTENCE_STATUS.UNKNOWN
  );
});
