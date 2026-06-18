import * as Y from 'yjs';
import yaml from 'js-yaml';

const TYPE = '__vertex_yjs_type__';
const ORDER = '__vertex_yjs_order__';
const ITEMS = '__vertex_yjs_items__';
const VALUE = '__vertex_yjs_value__';

export function isStructuredPath(path) {
  return /\.(json|ya?ml)$/i.test(path);
}

export function parseStructuredContent(path, text) {
  if (/\.ya?ml$/i.test(path)) return yaml.load(text) || {};
  return JSON.parse(text);
}

export function formatStructuredContent(path, data) {
  if (/\.ya?ml$/i.test(path)) return yaml.dump(data, { lineWidth: 120, noRefs: true });
  return JSON.stringify(data, null, 2);
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function identityKey(item, index) {
  if (!isPlainObject(item)) return null;
  const key = item.id ?? item.name ?? item.url;
  return key == null ? `index:${index}` : String(key);
}

function toYValue(value) {
  if (Array.isArray(value)) {
    const identityKeys = value.map(identityKey);
    const canMergeByIdentity = value.length > 0 && identityKeys.every(Boolean);
    if (canMergeByIdentity) {
      const node = new Y.Map();
      const order = new Y.Array();
      const items = new Y.Map();
      const seen = new Set();
      node.set(TYPE, 'identity-array');
      node.set(ORDER, order);
      node.set(ITEMS, items);
      value.forEach((item, index) => {
        const key = identityKeys[index];
        if (!seen.has(key)) {
          order.push([key]);
          seen.add(key);
        }
        items.set(key, toYValue(item));
      });
      return node;
    }

    const arr = new Y.Array();
    arr.push(value.map(toYValue));
    return arr;
  }

  if (isPlainObject(value)) {
    const map = new Y.Map();
    for (const [key, child] of Object.entries(value)) {
      map.set(key, toYValue(child));
    }
    return map;
  }

  const scalar = new Y.Map();
  scalar.set(TYPE, 'scalar');
  scalar.set(VALUE, value);
  return scalar;
}

function fromYValue(node) {
  if (node instanceof Y.Array) {
    return node.toArray().map(fromYValue);
  }

  if (node instanceof Y.Map) {
    const type = node.get(TYPE);
    if (type === 'scalar') return node.get(VALUE);
    if (type === 'identity-array') {
      const order = node.get(ORDER);
      const items = node.get(ITEMS);
      const keys = order instanceof Y.Array ? order.toArray() : [];
      const seen = new Set();
      const out = [];
      for (const key of keys) {
        const child = items?.get(key);
        if (child !== undefined && !seen.has(key)) {
          out.push(fromYValue(child));
          seen.add(key);
        }
      }
      if (items instanceof Y.Map) {
        for (const [key, child] of items) {
          if (!seen.has(key)) out.push(fromYValue(child));
        }
      }
      return out;
    }

    const obj = {};
    for (const [key, child] of node) {
      if (key === TYPE || key === VALUE || key === ORDER || key === ITEMS) continue;
      obj[key] = fromYValue(child);
    }
    return obj;
  }

  return node;
}

export function createStructuredUpdate(data) {
  const doc = new Y.Doc();
  doc.getMap('root').set('data', toYValue(data));
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

export function readStructuredUpdate(update) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  const data = fromYValue(doc.getMap('root').get('data'));
  doc.destroy();
  return data;
}

function mergeByIdentity(localItems, incomingItems) {
  const merged = [...localItems];
  const indexByKey = new Map();
  merged.forEach((item, index) => {
    const key = identityKey(item, index);
    if (key) indexByKey.set(key, index);
  });

  incomingItems.forEach((item, index) => {
    const key = identityKey(item, index);
    const existingIndex = key ? indexByKey.get(key) : undefined;
    if (existingIndex != null) {
      merged[existingIndex] = mergeData(merged[existingIndex], item);
    } else {
      merged.push(item);
      if (key) indexByKey.set(key, merged.length - 1);
    }
  });
  return merged;
}

function timestampMs(value) {
  const timestamp = Number(value?.updatedAtMs);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function newerTimestampedRecord(localValue, incomingValue) {
  const localTimestamp = timestampMs(localValue);
  const incomingTimestamp = timestampMs(incomingValue);
  if (localValue?.id == null || String(localValue.id) !== String(incomingValue?.id)) return null;
  if (localTimestamp == null && incomingTimestamp == null) return null;
  if (localTimestamp == null) return incomingValue;
  if (incomingTimestamp == null) return localValue;
  if (localTimestamp === incomingTimestamp) return null;
  return incomingTimestamp > localTimestamp ? incomingValue : localValue;
}

function mergeData(localValue, incomingValue) {
  if (localValue === undefined) return incomingValue;
  if (incomingValue === undefined) return localValue;
  if (incomingValue === null) return null;
  if (localValue === null) return incomingValue;

  if (Array.isArray(localValue) && Array.isArray(incomingValue)) {
    const localIdentity = localValue.map(identityKey).every(Boolean);
    const incomingIdentity = incomingValue.map(identityKey).every(Boolean);
    if (localIdentity && incomingIdentity) return mergeByIdentity(localValue, incomingValue);
    return JSON.stringify(incomingValue) > JSON.stringify(localValue) ? incomingValue : localValue;
  }

  if (isPlainObject(localValue) && isPlainObject(incomingValue)) {
    const newerRecord = newerTimestampedRecord(localValue, incomingValue);
    if (newerRecord) return newerRecord;

    const merged = { ...localValue };
    for (const [key, child] of Object.entries(incomingValue)) {
      merged[key] = mergeData(localValue[key], child);
    }
    return merged;
  }

  return JSON.stringify(incomingValue) > JSON.stringify(localValue) ? incomingValue : localValue;
}

export function mergeStructuredUpdates(updates) {
  let mergedData;
  for (const update of updates) {
    if (!update?.byteLength) continue;
    mergedData = mergeData(mergedData, readStructuredUpdate(update));
  }
  const data = mergedData ?? {};
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
