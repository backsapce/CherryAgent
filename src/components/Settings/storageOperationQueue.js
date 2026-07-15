let storageOperationTail = Promise.resolve();

/**
 * Serialize operations that can replace or synchronize the application's OPFS
 * data. The tail intentionally lives at module scope so closing and reopening
 * Settings cannot create a second, overlapping queue.
 */
export function enqueueStorageOperation(operation) {
  const run = storageOperationTail
    .catch(() => {})
    .then(operation);

  // Keep a fulfilled tail even when the caller observes an operation failure,
  // so one failed import/sync does not poison every operation queued after it.
  storageOperationTail = run.catch(() => {});
  return run;
}
