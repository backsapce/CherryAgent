function timestampFromGeneratedId(id) {
  const value = parseInt(String(id || '').slice(0, 8), 36);
  const min = new Date('2000-01-01T00:00:00Z').getTime();
  const max = new Date('2100-01-01T00:00:00Z').getTime();
  return Number.isFinite(value) && value >= min && value <= max ? value : 0;
}

function sessionTimestamp(session) {
  if (Number.isFinite(session?.updatedAtMs)) return session.updatedAtMs;
  let latest = timestampFromGeneratedId(session?.id);
  for (const message of session?.messages || []) {
    latest = Math.max(latest, timestampFromGeneratedId(message.id));
  }
  return latest;
}

function sessionDataChanged(left, right) {
  if (left === right) return false;
  return JSON.stringify(left) !== JSON.stringify(right);
}

const MISSING = Symbol('missing-session-value');

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableValueKey(value) {
  if (value === MISSING) return '9:missing';
  if (value === null) return '0:null';
  if (Array.isArray(value)) return `5:[${value.map(stableValueKey).join(',')}]`;
  if (isRecord(value)) {
    return `6:{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableValueKey(value[key])}`
    ).join(',')}}`;
  }
  return `${typeof value}:${JSON.stringify(value)}`;
}

function mergeValueThreeWay(baseline, local, remote) {
  if (local === MISSING) return baseline === MISSING ? remote : MISSING;
  if (remote === MISSING) {
    return sessionDataChanged(local, baseline) ? local : MISSING;
  }
  if (baseline !== MISSING && !sessionDataChanged(local, baseline)) return remote;
  if (baseline !== MISSING && !sessionDataChanged(remote, baseline)) return local;
  if (!isRecord(local) || !isRecord(remote)) {
    return stableValueKey(local) >= stableValueKey(remote) ? local : remote;
  }

  const baseRecord = isRecord(baseline) ? baseline : {};
  const merged = {};
  const keys = new Set([
    ...Object.keys(baseRecord),
    ...Object.keys(local),
    ...Object.keys(remote),
  ]);
  for (const key of keys) {
    const value = mergeValueThreeWay(
      Object.prototype.hasOwnProperty.call(baseRecord, key) ? baseRecord[key] : MISSING,
      Object.prototype.hasOwnProperty.call(local, key) ? local[key] : MISSING,
      Object.prototype.hasOwnProperty.call(remote, key) ? remote[key] : MISSING
    );
    if (value !== MISSING) {
      // Assignment to the magic `__proto__` setter would change the merged
      // object's prototype instead of preserving user data as an own field.
      Object.defineProperty(merged, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    }
  }
  return merged;
}

function keyedMessages(messages) {
  const byKey = new Map();
  const keys = [];
  const anonymousCounts = new Map();
  for (const message of messages || []) {
    let key;
    if (message?.id != null) {
      key = `id:${String(message.id)}`;
    } else {
      const value = JSON.stringify(message);
      const occurrence = anonymousCounts.get(value) || 0;
      anonymousCounts.set(value, occurrence + 1);
      key = `value:${value}:${occurrence}`;
    }
    byKey.set(key, message);
    keys.push(key);
  }
  return { byKey, keys };
}

function mergeMessages(baselineMessages, localMessages, remoteMessages) {
  const baseline = keyedMessages(baselineMessages);
  const local = keyedMessages(localMessages);
  const remote = keyedMessages(remoteMessages);
  const resolved = new Map();
  const allKeys = new Set([...baseline.keys, ...remote.keys, ...local.keys]);
  for (const key of allKeys) {
    const value = mergeValueThreeWay(
      baseline.byKey.has(key) ? baseline.byKey.get(key) : MISSING,
      local.byKey.has(key) ? local.byKey.get(key) : MISSING,
      remote.byKey.has(key) ? remote.byKey.get(key) : MISSING
    );
    if (value !== MISSING) resolved.set(key, value);
  }

  const baselineKeys = baseline.keys.filter((key) => resolved.has(key));
  const baselineKeySet = new Set(baseline.keys);
  const appendOrder = [...new Set([...remote.keys, ...local.keys])]
    .filter((key) => !baselineKeySet.has(key) && resolved.has(key));
  appendOrder.sort((left, right) => {
    const leftTime = timestampFromGeneratedId(resolved.get(left)?.id);
    const rightTime = timestampFromGeneratedId(resolved.get(right)?.id);
    if (leftTime && rightTime && leftTime !== rightTime) return leftTime - rightTime;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return [...baselineKeys, ...appendOrder].map((key) => resolved.get(key));
}

function mergeSessionThreeWay(baseline, local, remote) {
  const merged = mergeValueThreeWay(baseline, local, remote);
  if (!isRecord(merged)) return local;
  merged.messages = mergeMessages(
    baseline?.messages || [],
    local?.messages || [],
    remote?.messages || []
  );
  return merged;
}

function sessionsById(sessions) {
  const byId = new Map();
  for (const session of sessions || []) {
    if (session?.id != null) byId.set(String(session.id), session);
  }
  return byId;
}

export function sortSessions(sessions) {
  return [...(sessions || [])].sort((a, b) => sessionTimestamp(b) - sessionTimestamp(a));
}

/**
 * Capture the exact serializable value that saveSessions() is asked to persist.
 * Keeping an isolated snapshot prevents later in-memory mutations from making a
 * previously persisted session appear clean.
 */
export function snapshotSessions(sessions) {
  return JSON.parse(JSON.stringify(sessions || []));
}

/**
 * Reconcile freshly loaded storage with the current React state.
 *
 * Stored data is authoritative for sessions that still match the last
 * successfully persisted snapshot. Only genuinely unsaved local additions,
 * edits, and deletions are overlaid on top of it.
 */
export function reconcileStoredSessions(savedSessions, currentSessions, persistedSessions) {
  const savedById = sessionsById(savedSessions);
  const currentById = sessionsById(currentSessions);
  const persistedById = sessionsById(persistedSessions);

  // A session removed from memory but still present in the last persisted
  // snapshot represents a local deletion that has not been saved yet.
  for (const id of persistedById.keys()) {
    if (!currentById.has(id)) savedById.delete(id);
  }

  // Overlay only sessions whose current value has never been persisted or has
  // changed since its last successful persistence.
  for (const [id, current] of currentById) {
    const persisted = persistedById.get(id);
    if (!persisted || sessionDataChanged(current, persisted)) {
      const saved = savedById.get(id);
      savedById.set(
        id,
        persisted && saved
          ? mergeSessionThreeWay(persisted, current, saved)
          : current
      );
    }
  }

  const sessions = sortSessions([...savedById.values()]);
  const sortedSaved = sortSessions(savedSessions || []);
  return {
    sessions,
    needsPersist: sessionDataChanged(sessions, sortedSaved),
  };
}

/**
 * Replay a crash journal without letting an old checkpoint roll back a session
 * that was durably created after the journal's baseline was captured. Session
 * IDs are globally generated, so a matching durable ID represents the same
 * session. Its newer/equal durable timestamp wins; a genuinely newer journal
 * still participates in the normal three-way reconciliation.
 */
export function reconcileSessionRecoveryJournal(savedSessions, journal) {
  const savedById = sessionsById(savedSessions);
  const baselineById = sessionsById(journal?.baseline);
  const recoverableSessions = [];
  for (const session of journal?.sessions || []) {
    const id = String(session.id);
    const saved = savedById.get(id);
    if (
      !baselineById.has(id)
      && saved
      && sessionTimestamp(saved) >= sessionTimestamp(session)
    ) continue;
    recoverableSessions.push(session);
  }
  return reconcileStoredSessions(
    savedSessions,
    recoverableSessions,
    journal?.baseline || []
  );
}
