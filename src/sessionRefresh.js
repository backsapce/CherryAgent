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

// Key-order-insensitive serialization: the three-way merge reassembles keys
// from a Set, so plain JSON.stringify can report false differences between
// identical data and trigger spurious persists/syncs.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`
  ).join(',')}}`;
}

function sessionDataChanged(left, right) {
  if (left === right) return false;
  return stableStringify(left) !== stableStringify(right);
}

const MISSING = Symbol('missing-session-value');
const REMOTE_REPLY_CHECKPOINT_FIELDS = [
  'content',
  'thinking',
  'toolCalls',
  'transcript',
  'usage',
  'runStartedAt',
  'runFinishedAt',
  'remoteEventSequence',
  'remoteReasoningParsers',
];

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

function mergeValueThreeWay(baseline, local, remote, conflictPreference = null) {
  if (local === MISSING) return baseline === MISSING ? remote : MISSING;
  if (remote === MISSING) {
    return sessionDataChanged(local, baseline) ? local : MISSING;
  }
  if (baseline !== MISSING && !sessionDataChanged(local, baseline)) return remote;
  if (baseline !== MISSING && !sessionDataChanged(remote, baseline)) return local;
  if (!isRecord(local) || !isRecord(remote)) {
    // Both sides changed the same scalar. Honor the session that records the
    // later edit (threaded in by mergeSessionThreeWay) instead of an
    // arbitrary stable-key comparison, so the newest title/profile wins.
    if (conflictPreference === 'local') return local;
    if (conflictPreference === 'remote') return remote;
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
      Object.prototype.hasOwnProperty.call(remote, key) ? remote[key] : MISSING,
      conflictPreference
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

function remoteReplySequence(message) {
  const sequence = Number(message?.remoteEventSequence);
  return Number.isFinite(sequence) && sequence > 0 ? Math.floor(sequence) : 0;
}

function remoteReplyCheckpoint(message) {
  const checkpoint = {};
  for (const field of REMOTE_REPLY_CHECKPOINT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(message || {}, field)) continue;
    Object.defineProperty(checkpoint, field, {
      configurable: true,
      enumerable: true,
      value: message[field],
      writable: true,
    });
  }
  return checkpoint;
}

function newerRemoteReplyCheckpoint(...messages) {
  const candidates = messages
    .filter(isRecord)
    .map((message) => ({
      message,
      sequence: remoteReplySequence(message),
      stableKey: stableValueKey(remoteReplyCheckpoint(message)),
    }))
    .filter((candidate) => candidate.sequence > 0);
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => (
    left.sequence - right.sequence
    || (left.stableKey < right.stableKey ? -1 : left.stableKey > right.stableKey ? 1 : 0)
  ));
  return candidates.at(-1).message;
}

function mergeMessageThreeWay(baseline, local, remote) {
  const merged = mergeValueThreeWay(baseline, local, remote);
  if (!isRecord(merged)) return merged;
  const checkpointSource = newerRemoteReplyCheckpoint(baseline, local, remote);
  if (!checkpointSource) return merged;

  // The cursor is a causal boundary for every rendered/reducer field. Merging
  // those fields independently can pair seq=12 with seq=10 text and cause the
  // next replay to skip the missing events permanently. Overlay the complete
  // checkpoint from one source while retaining normally merged message
  // metadata such as reactions or attachments.
  for (const field of REMOTE_REPLY_CHECKPOINT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(checkpointSource, field)) {
      Object.defineProperty(merged, field, {
        configurable: true,
        enumerable: true,
        value: checkpointSource[field],
        writable: true,
      });
    } else {
      delete merged[field];
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
    const value = mergeMessageThreeWay(
      baseline.byKey.has(key) ? baseline.byKey.get(key) : MISSING,
      local.byKey.has(key) ? local.byKey.get(key) : MISSING,
      remote.byKey.has(key) ? remote.byKey.get(key) : MISSING
    );
    if (value !== MISSING) resolved.set(key, value);
  }

  // A pull can fill a previously missing archive chunk in the middle of the
  // known conversation. Keep that recovered history before its next anchor.
  const insertions = new Map();
  const inserted = new Set();
  let anchor = null;
  for (let index = remote.keys.length - 1; index >= 0; index -= 1) {
    const key = remote.keys[index];
    if (baseline.byKey.has(key)) anchor = key;
    else if (anchor !== null && resolved.has(key) && !inserted.has(key)) {
      if (!insertions.has(anchor)) insertions.set(anchor, []);
      insertions.get(anchor).push(key);
      inserted.add(key);
    }
  }
  const appendOrder = [...new Set([...remote.keys, ...local.keys])]
    .filter((key) => !baseline.byKey.has(key) && !inserted.has(key) && resolved.has(key));
  appendOrder.sort((left, right) => {
    const leftTime = timestampFromGeneratedId(resolved.get(left)?.id);
    const rightTime = timestampFromGeneratedId(resolved.get(right)?.id);
    if (leftTime && rightTime && leftTime !== rightTime) return leftTime - rightTime;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return [
    ...baseline.keys.flatMap((key) => [
      ...(insertions.get(key)?.reverse() || []),
      ...(resolved.has(key) ? [key] : []),
    ]),
    ...appendOrder,
  ].map((key) => resolved.get(key));
}

export function sessionMetadataOnly(session) {
  if (!Object.hasOwn(session, 'messages')) return session;
  const { messages: _messages, ...metadata } = session;
  return metadata;
}

function mergeSessionThreeWay(baseline, local, remote, bodyChanged) {
  const conflictPreference = (() => {
    const localAt = sessionTimestamp(local);
    const remoteAt = sessionTimestamp(remote);
    if (!localAt || !remoteAt || localAt === remoteAt) return null;
    return localAt > remoteAt ? 'local' : 'remote';
  })();
  const metadata = mergeValueThreeWay(
    sessionMetadataOnly(baseline),
    sessionMetadataOnly(local),
    sessionMetadataOnly(remote),
    conflictPreference
  );
  // Missing bodies are unknown, not empty. Never synthesize message deletions
  // from a metadata-only local or remote record.
  if (!bodyChanged) return Array.isArray(remote.messages) ? { ...metadata, messages: remote.messages } : metadata;
  const messages = Array.isArray(remote.messages)
    ? mergeMessages(baseline.messages || [], local.messages, remote.messages)
    : local.messages;
  return { ...metadata, messages };
}

function sessionsById(sessions) {
  const byId = new Map();
  for (const session of sessions || []) {
    if (session?.id != null) byId.set(String(session.id), session);
  }
  return byId;
}

export function sortSessions(sessions, sortBy = 'updatedAt') {
  const timestamp = sortBy === 'createdAt'
    ? (session) => Number.isFinite(session?.createdAtMs)
      ? session.createdAtMs
      : timestampFromGeneratedId(session?.id)
    : sessionTimestamp;
  return [...(sessions || [])].sort((a, b) => timestamp(b) - timestamp(a));
}

const immutableNodes = new WeakSet();
const NOT_JSON_DATA = Symbol('not-json-data');

function copySessionData(value, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || value === undefined) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value || 0 : null;
  if (typeof value !== 'object') return NOT_JSON_DATA;
  if (immutableNodes.has(value)) return value;
  const array = Array.isArray(value);
  if (
    Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)
    || 'toJSON' in value
    || ancestors.has(value)
  ) return NOT_JSON_DATA;

  const copy = array ? [] : {};
  ancestors.add(value);
  const copyProperty = (key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !Object.hasOwn(property, 'value')) return false;
    const child = copySessionData(property.value, ancestors);
    if (child === NOT_JSON_DATA) return false;
    if (array) copy.push(child === undefined ? null : child);
    else if (child !== undefined) Object.defineProperty(copy, key, { value: child, enumerable: true });
    return true;
  };
  if (array) {
    for (let i = 0; i < value.length; i += 1) if (!copyProperty(i)) return NOT_JSON_DATA;
  } else {
    for (const key of Object.keys(value)) if (!copyProperty(key)) return NOT_JSON_DATA;
  }
  ancestors.delete(value);
  Object.freeze(copy);
  immutableNodes.add(copy);
  return copy;
}

/** Own plain session data without walking any previously owned subtrees. */
export function immutableSessionData(value) {
  try {
    const copy = copySessionData(value, new WeakSet());
    if (copy !== NOT_JSON_DATA) return copy;
  } catch { /* foreign objects still take the normal serialization path */ }
  return value;
}

export function isImmutableSessionData(value) {
  return immutableNodes.has(value);
}

/** Capture an isolated snapshot, sharing only data we already own and froze. */
export function snapshotSessions(sessions) {
  return isImmutableSessionData(sessions) ? sessions : JSON.parse(JSON.stringify(sessions || []));
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
    const bodyChanged = Array.isArray(current.messages)
      && sessionDataChanged(current.messages, persisted?.messages);
    if (!persisted || bodyChanged || sessionDataChanged(
      sessionMetadataOnly(current), sessionMetadataOnly(persisted)
    )) {
      const saved = savedById.get(id);
      if (persisted && saved) {
        savedById.set(id, mergeSessionThreeWay(persisted, current, saved, bodyChanged));
      } else if (!Array.isArray(current.messages) && Array.isArray(persisted?.messages)) {
        // A real metadata edit can survive a whole-session deletion. Retain
        // the last known body if it was only evicted locally.
        savedById.set(id, { ...current, messages: persisted.messages });
      } else {
        savedById.set(id, current);
      }
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
