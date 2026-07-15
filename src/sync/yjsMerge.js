import * as Y from 'yjs';
import yaml from 'js-yaml';

// Structured updates are stored as nested Y.Map/Y.Array values so older
// VertexAgent clients can continue reading root.data. New readers use a small
// format marker to unescape user keys which overlap with in-band metadata.
const LEGACY_TYPE = '__vertex_yjs_type__';
const LEGACY_ORDER = '__vertex_yjs_order__';
const LEGACY_ITEMS = '__vertex_yjs_items__';
const LEGACY_VALUE = '__vertex_yjs_value__';

const ENCODING_KEY = '__vertex_encoding__';
const TREE_ENCODING = 'tree-v2';
const COMPACT_ENCODING = 'json-v3';
const METADATA_PREFIX = '__vertex_yjs_';
const KEY_ESCAPE_PREFIX = '__vertex_yjs_key_escape__:';
const MISSING = Symbol('vertex-structured-missing');

export function isStructuredPath(path) {
  return /\.(json|ya?ml)$/i.test(path);
}

function jsonText(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (err) {
    throw new TypeError(`Structured data must be JSON-compatible: ${err.message}`);
  }
  if (text === undefined) {
    throw new TypeError('Structured data must be JSON-compatible; top-level undefined is not supported');
  }
  return text;
}

function normalizeJsonValue(value) {
  return JSON.parse(jsonText(value));
}

function canUseCompactEncoding(value) {
  if (Array.isArray(value)) return value.every(canUseCompactEncoding);
  if (!isPlainObject(value)) return true;
  return Object.keys(value).every((key) => (
    key !== '__proto__'
    && key !== 'constructor'
    && canUseCompactEncoding(value[key])
  ));
}

export function parseStructuredContent(path, text) {
  if (/\.ya?ml$/i.test(path)) {
    const parsed = yaml.load(text, { schema: yaml.JSON_SCHEMA });
    // An empty YAML document historically represented an empty object. Do not
    // use `|| {}` here: false, zero, the empty string, and null are valid data.
    return parsed === undefined ? {} : normalizeJsonValue(parsed);
  }
  return normalizeJsonValue(JSON.parse(text));
}

export function formatStructuredContent(path, data) {
  const normalized = normalizeJsonValue(data);
  if (/\.ya?ml$/i.test(path)) return yaml.dump(normalized, { lineWidth: 120, noRefs: true });
  return JSON.stringify(normalized, null, 2);
}

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function setOwn(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function identityKey(item) {
  if (!isPlainObject(item)) return null;
  for (const field of ['id', 'name', 'url']) {
    const value = item[field];
    if (value == null) continue;
    if (!['string', 'number', 'boolean'].includes(typeof value)) return null;
    return `${field}:${typeof value}:${String(value)}`;
  }
  return null;
}

function uniqueIdentityMap(items) {
  const map = new Map();
  for (const item of items) {
    const key = identityKey(item);
    if (!key || map.has(key)) return null;
    map.set(key, item);
  }
  return map;
}

function canMergeIdentityArrays(...arrays) {
  let hasIdentity = false;
  for (const items of arrays) {
    if (!Array.isArray(items)) continue;
    const map = uniqueIdentityMap(items);
    if (!map) return false;
    if (items.length > 0) hasIdentity = true;
  }
  return hasIdentity;
}

function escapeUserKey(key) {
  return key === '__proto__' || key.startsWith(METADATA_PREFIX)
    ? `${KEY_ESCAPE_PREFIX}${key}`
    : key;
}

function unescapeUserKey(key, escapedKeys) {
  return escapedKeys && key.startsWith(KEY_ESCAPE_PREFIX)
    ? key.slice(KEY_ESCAPE_PREFIX.length)
    : key;
}

function toYValue(value) {
  if (Array.isArray(value)) {
    if (canMergeIdentityArrays(value)) {
      const node = new Y.Map();
      const order = new Y.Array();
      const items = new Y.Map();
      node.set(LEGACY_TYPE, 'identity-array');
      node.set(LEGACY_ORDER, order);
      node.set(LEGACY_ITEMS, items);
      for (const item of value) {
        const key = identityKey(item);
        order.push([key]);
        items.set(key, toYValue(item));
      }
      return node;
    }

    const array = new Y.Array();
    array.push(value.map(toYValue));
    return array;
  }

  if (isPlainObject(value)) {
    const map = new Y.Map();
    for (const [key, child] of Object.entries(value)) {
      map.set(escapeUserKey(key), toYValue(child));
    }
    return map;
  }

  const scalar = new Y.Map();
  scalar.set(LEGACY_TYPE, 'scalar');
  scalar.set(LEGACY_VALUE, value);
  return scalar;
}

function fromYValue(node, escapedKeys = false) {
  if (node instanceof Y.Array) {
    return node.toArray().map((child) => fromYValue(child, escapedKeys));
  }

  if (node instanceof Y.Map) {
    const type = node.get(LEGACY_TYPE);
    if (type === 'scalar') return node.get(LEGACY_VALUE);
    if (type === 'identity-array') {
      const order = node.get(LEGACY_ORDER);
      const items = node.get(LEGACY_ITEMS);
      const keys = order instanceof Y.Array ? order.toArray() : [];
      const seen = new Set();
      const out = [];
      for (const key of keys) {
        const child = items?.get(key);
        if (child !== undefined && !seen.has(key)) {
          out.push(fromYValue(child, escapedKeys));
          seen.add(key);
        }
      }
      if (items instanceof Y.Map) {
        for (const [key, child] of items) {
          if (!seen.has(key)) out.push(fromYValue(child, escapedKeys));
        }
      }
      return out;
    }

    const obj = {};
    for (const [key, child] of node) {
      if (key === LEGACY_TYPE || key === LEGACY_VALUE || key === LEGACY_ORDER || key === LEGACY_ITEMS) continue;
      setOwn(obj, unescapeUserKey(key, escapedKeys), fromYValue(child, escapedKeys));
    }
    return obj;
  }

  return node;
}

export function createStructuredUpdate(data) {
  const normalized = normalizeJsonValue(data);
  const doc = new Y.Doc();
  // Snapshot payloads are content-addressed. A stable client ID makes the
  // binary update deterministic, allowing identical structured content from
  // different devices/paths to reuse the same remote object.
  doc.clientID = 1;
  const root = doc.getMap('root');
  if (canUseCompactEncoding(normalized)) {
    // Yjs ContentAny stores JSON-compatible values far more compactly than a
    // Y.Map per scalar. Keep the legacy scalar wrapper so even readers that
    // require root.data to be a Y.AbstractType can decode the snapshot.
    const compact = new Y.Map();
    compact.set(LEGACY_TYPE, 'scalar');
    compact.set(LEGACY_VALUE, normalized);
    root.set(ENCODING_KEY, COMPACT_ENCODING);
    root.set('data', compact);
  } else {
    // Yjs cannot safely encode own `constructor`/`__proto__` keys as ContentAny.
    // Retain the escaped tree encoding for those uncommon documents.
    root.set(ENCODING_KEY, TREE_ENCODING);
    root.set('data', toYValue(normalized));
  }
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

export function readStructuredUpdate(update) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    const root = doc.getMap('root');
    return fromYValue(root.get('data'), root.get(ENCODING_KEY) === TREE_ENCODING);
  } finally {
    doc.destroy();
  }
}

function timestampMs(value) {
  if (value?.updatedAtMs == null || value.updatedAtMs === '') return null;
  const timestamp = Number(value?.updatedAtMs);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function newerTimestampedRecord(localValue, incomingValue) {
  const localTimestamp = timestampMs(localValue);
  const incomingTimestamp = timestampMs(incomingValue);
  if (localValue?.id == null || localValue.id !== incomingValue?.id) return null;
  if (localTimestamp == null && incomingTimestamp == null) return null;
  if (localTimestamp == null) return incomingValue;
  if (incomingTimestamp == null) return localValue;
  if (localTimestamp === incomingTimestamp) return null;
  return incomingTimestamp > localTimestamp ? incomingValue : localValue;
}

function mergeByIdentity(localItems, incomingItems) {
  const merged = [...localItems];
  const indexByKey = new Map();
  merged.forEach((item, index) => indexByKey.set(identityKey(item), index));

  incomingItems.forEach((item) => {
    const key = identityKey(item);
    const existingIndex = indexByKey.get(key);
    if (existingIndex != null) {
      merged[existingIndex] = mergeData(merged[existingIndex], item);
    } else {
      merged.push(item);
      indexByKey.set(key, merged.length - 1);
    }
  });
  return merged;
}

function mergeData(localValue, incomingValue) {
  if (localValue === undefined) return incomingValue;
  if (incomingValue === undefined) return localValue;
  if (incomingValue === null) return null;
  if (localValue === null) return incomingValue;

  if (Array.isArray(localValue) && Array.isArray(incomingValue)) {
    if (canMergeIdentityArrays(localValue, incomingValue)) return mergeByIdentity(localValue, incomingValue);
    return stableValueKey(incomingValue) > stableValueKey(localValue) ? incomingValue : localValue;
  }

  if (isPlainObject(localValue) && isPlainObject(incomingValue)) {
    const newerRecord = newerTimestampedRecord(localValue, incomingValue);
    if (newerRecord) return newerRecord;

    const merged = { ...localValue };
    for (const [key, child] of Object.entries(incomingValue)) {
      setOwn(merged, key, mergeData(localValue[key], child));
    }
    return merged;
  }

  return stableValueKey(incomingValue) > stableValueKey(localValue) ? incomingValue : localValue;
}

function stableValueKey(value) {
  if (value === MISSING) return '9:missing';
  if (value === null) return '0:null';
  if (Array.isArray(value)) return `5:[${value.map(stableValueKey).join(',')}]`;
  if (isPlainObject(value)) {
    return `6:{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValueKey(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'string') return `4:${JSON.stringify(value)}`;
  if (typeof value === 'number') return `3:${JSON.stringify(value)}`;
  if (typeof value === 'boolean') return `2:${value ? '1' : '0'}`;
  return `1:${JSON.stringify(value)}`;
}

function sameValue(left, right) {
  if (left === MISSING || right === MISSING) return left === right;
  return stableValueKey(left) === stableValueKey(right);
}

function optionTimestamp(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function preferredSideFromTimestamps(localTimestamp, remoteTimestamp) {
  const local = optionTimestamp(localTimestamp);
  const remote = optionTimestamp(remoteTimestamp);
  if (local == null || remote == null || local === remote) return null;
  return local > remote ? 'local' : 'remote';
}

function recordPreferredSide(localValue, remoteValue) {
  if (!isPlainObject(localValue) || !isPlainObject(remoteValue)) return null;
  if (localValue.id == null || localValue.id !== remoteValue.id) return null;
  const local = timestampMs(localValue);
  const remote = timestampMs(remoteValue);
  if (local == null && remote == null) return null;
  if (local == null) return 'remote';
  if (remote == null) return 'local';
  if (local === remote) return null;
  return local > remote ? 'local' : 'remote';
}

function resolveTrueConflict(localValue, remoteValue, context) {
  if (context.preferredSide === 'local') return localValue;
  if (context.preferredSide === 'remote') return remoteValue;
  return stableValueKey(localValue) >= stableValueKey(remoteValue) ? localValue : remoteValue;
}

function isPrefix(base, candidate) {
  if (!Array.isArray(base) || !Array.isArray(candidate) || candidate.length < base.length) return false;
  return base.every((item, index) => sameValue(item, candidate[index]));
}

function mergeConcurrentAppends(base, local, remote) {
  if (!isPrefix(base, local) || !isPrefix(base, remote)) return null;
  const counts = new Map();
  for (const additions of [local.slice(base.length), remote.slice(base.length)]) {
    const sideCounts = new Map();
    for (const value of additions) {
      const key = stableValueKey(value);
      const record = sideCounts.get(key) || { value, count: 0 };
      record.count += 1;
      sideCounts.set(key, record);
    }
    for (const [key, record] of sideCounts) {
      const current = counts.get(key);
      if (!current || record.count > current.count) counts.set(key, record);
    }
  }
  const out = [...base];
  for (const [, { value, count }] of [...counts].sort(([left], [right]) => compareStrings(left, right))) {
    for (let index = 0; index < count; index += 1) out.push(value);
  }
  return out;
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function mergeIdentityArraysThreeWay(base, local, remote, context) {
  const baseItems = Array.isArray(base) ? base : [];
  const baseMap = uniqueIdentityMap(baseItems) || new Map();
  const localMap = uniqueIdentityMap(local);
  const remoteMap = uniqueIdentityMap(remote);
  if (!localMap || !remoteMap) return null;

  const allKeys = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
  const mergedByKey = new Map();
  for (const key of allKeys) {
    const merged = mergeThreeWayNode(
      baseMap.has(key) ? baseMap.get(key) : MISSING,
      localMap.has(key) ? localMap.get(key) : MISSING,
      remoteMap.has(key) ? remoteMap.get(key) : MISSING,
      context
    );
    if (merged !== MISSING) mergedByKey.set(key, merged);
  }

  const orderedKeys = [];
  for (const item of baseItems) {
    const key = identityKey(item);
    if (mergedByKey.has(key)) orderedKeys.push(key);
  }
  const additions = [...mergedByKey.keys()]
    .filter((key) => !baseMap.has(key))
    .sort(compareStrings);
  orderedKeys.push(...additions);
  return orderedKeys.map((key) => mergedByKey.get(key));
}

function mergeThreeWayNode(base, local, remote, context) {
  if (sameValue(local, remote)) return local;
  if (sameValue(local, base)) return remote;
  if (sameValue(remote, base)) return local;

  if (Array.isArray(local) && Array.isArray(remote)) {
    if (canMergeIdentityArrays(base, local, remote)) {
      const merged = mergeIdentityArraysThreeWay(base, local, remote, context);
      if (merged) return merged;
    }
    if (Array.isArray(base)) {
      const appended = mergeConcurrentAppends(base, local, remote);
      if (appended) return appended;
    }
    return resolveTrueConflict(local, remote, context);
  }

  if (isPlainObject(local) && isPlainObject(remote)) {
    const recordPreference = recordPreferredSide(local, remote);
    const childContext = recordPreference ? { ...context, preferredSide: recordPreference } : context;
    const baseObject = isPlainObject(base) ? base : {};
    const keys = new Set([...Object.keys(baseObject), ...Object.keys(local), ...Object.keys(remote)]);
    const merged = {};
    for (const key of [...keys].sort()) {
      const child = mergeThreeWayNode(
        Object.prototype.hasOwnProperty.call(baseObject, key) ? baseObject[key] : MISSING,
        Object.prototype.hasOwnProperty.call(local, key) ? local[key] : MISSING,
        Object.prototype.hasOwnProperty.call(remote, key) ? remote[key] : MISSING,
        childContext
      );
      if (child !== MISSING) setOwn(merged, key, child);
    }
    return merged;
  }

  return resolveTrueConflict(local, remote, context);
}

/**
 * Deterministically merge local and remote JSON-compatible snapshots against a
 * common base. A missing top-level snapshot may be represented by undefined;
 * the returned value is undefined only when the merged snapshot is deleted.
 */
export function mergeStructuredThreeWay(baseData, localData, remoteData, options = {}) {
  const base = baseData === undefined ? MISSING : normalizeJsonValue(baseData);
  const local = localData === undefined ? MISSING : normalizeJsonValue(localData);
  const remote = remoteData === undefined ? MISSING : normalizeJsonValue(remoteData);
  const preferredSide = preferredSideFromTimestamps(options.localUpdatedAt, options.remoteUpdatedAt);
  const merged = mergeThreeWayNode(base, local, remote, { preferredSide });
  return merged === MISSING ? undefined : merged;
}

export function mergeStructuredUpdates(updates) {
  let mergedData;
  let hasData = false;
  for (const update of updates) {
    if (!update?.byteLength) continue;
    const incoming = readStructuredUpdate(update);
    if (!hasData) {
      mergedData = incoming;
      hasData = true;
    } else {
      mergedData = mergeData(mergedData, incoming);
    }
  }
  const data = hasData ? mergedData : {};
  return { update: createStructuredUpdate(data), data };
}

export function mergeStructuredContent(path, localText, remoteUpdate) {
  const localData = parseStructuredContent(path, localText);
  const localUpdate = createStructuredUpdate(localData);
  const { update, data } = mergeStructuredUpdates(remoteUpdate ? [remoteUpdate, localUpdate] : [localUpdate]);
  return {
    update,
    data,
    content: formatStructuredContent(path, data),
  };
}
