export const STORAGE_PERSISTENCE_STATUS = Object.freeze({
  PERSISTENT: 'persistent',
  BEST_EFFORT: 'best-effort',
  UNSUPPORTED: 'unsupported',
  UNKNOWN: 'unknown',
});

function defaultStorageManager() {
  return globalThis.navigator?.storage;
}

/**
 * Read the origin's current durability without changing browser permissions.
 */
export async function getStoragePersistenceStatus(storage = defaultStorageManager()) {
  if (typeof storage?.persisted !== 'function') {
    return STORAGE_PERSISTENCE_STATUS.UNSUPPORTED;
  }

  try {
    return await storage.persisted()
      ? STORAGE_PERSISTENCE_STATUS.PERSISTENT
      : STORAGE_PERSISTENCE_STATUS.BEST_EFFORT;
  } catch {
    return STORAGE_PERSISTENCE_STATUS.UNKNOWN;
  }
}

/**
 * Ask the browser to exempt this origin's OPFS data from automatic eviction.
 * Browsers are allowed to deny this request, so callers must surface the
 * returned state instead of assuming that a resolved promise means success.
 */
export async function requestPersistentStorage(storage = defaultStorageManager()) {
  const current = await getStoragePersistenceStatus(storage);
  if (current === STORAGE_PERSISTENCE_STATUS.PERSISTENT) return current;
  if (typeof storage?.persist !== 'function') {
    return current === STORAGE_PERSISTENCE_STATUS.UNKNOWN
      ? current
      : STORAGE_PERSISTENCE_STATUS.UNSUPPORTED;
  }

  try {
    return await storage.persist()
      ? STORAGE_PERSISTENCE_STATUS.PERSISTENT
      : STORAGE_PERSISTENCE_STATUS.BEST_EFFORT;
  } catch {
    return STORAGE_PERSISTENCE_STATUS.UNKNOWN;
  }
}
