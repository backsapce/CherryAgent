import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import {
  createStructuredUpdate,
  formatStructuredContent,
  mergeStructuredContent,
  mergeStructuredThreeWay,
  mergeStructuredUpdates,
  parseStructuredContent,
  readStructuredUpdate,
} from './yjsMerge.js';

const LEGACY_TYPE = '__vertex_yjs_type__';
const LEGACY_ORDER = '__vertex_yjs_order__';
const LEGACY_ITEMS = '__vertex_yjs_items__';
const LEGACY_VALUE = '__vertex_yjs_value__';

function legacyYValue(value) {
  if (Array.isArray(value)) {
    const keys = value.map((item) => item && typeof item === 'object' && !Array.isArray(item)
      ? item.id ?? item.name ?? item.url ?? null
      : null);
    if (value.length > 0 && keys.every((key) => key != null)) {
      const node = new Y.Map();
      const order = new Y.Array();
      const items = new Y.Map();
      node.set(LEGACY_TYPE, 'identity-array');
      node.set(LEGACY_ORDER, order);
      node.set(LEGACY_ITEMS, items);
      value.forEach((item, index) => {
        const key = String(keys[index]);
        order.push([key]);
        items.set(key, legacyYValue(item));
      });
      return node;
    }
    const array = new Y.Array();
    array.push(value.map(legacyYValue));
    return array;
  }

  if (value && typeof value === 'object') {
    const map = new Y.Map();
    for (const [key, child] of Object.entries(value)) map.set(key, legacyYValue(child));
    return map;
  }

  const scalar = new Y.Map();
  scalar.set(LEGACY_TYPE, 'scalar');
  scalar.set(LEGACY_VALUE, value);
  return scalar;
}

function createLegacyUpdate(data) {
  const doc = new Y.Doc();
  doc.getMap('root').set('data', legacyYValue(data));
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function readLegacyYValue(node) {
  if (node instanceof Y.Array) return node.toArray().map(readLegacyYValue);
  if (!(node instanceof Y.Map)) return node;

  const type = node.get(LEGACY_TYPE);
  if (type === 'scalar') return node.get(LEGACY_VALUE);
  if (type === 'identity-array') {
    const order = node.get(LEGACY_ORDER);
    const items = node.get(LEGACY_ITEMS);
    const keys = order instanceof Y.Array ? order.toArray() : [];
    return keys
      .map((key) => items?.get(key))
      .filter((child) => child !== undefined)
      .map(readLegacyYValue);
  }

  const object = {};
  for (const [key, child] of node) {
    if ([LEGACY_TYPE, LEGACY_ORDER, LEGACY_ITEMS, LEGACY_VALUE].includes(key)) continue;
    object[key] = readLegacyYValue(child);
  }
  return object;
}

function readAsLegacyClient(update) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    const data = doc.getMap('root').get('data');
    assert.ok(data instanceof Y.AbstractType, 'new updates must retain the legacy root.data tree');
    return readLegacyYValue(data);
  } finally {
    doc.destroy();
  }
}

test('JSON object merge preserves concurrent keys', () => {
  const left = createStructuredUpdate({ a: 1 });
  const right = createStructuredUpdate({ b: 2 });
  const merged = mergeStructuredUpdates([left, right]);
  assert.deepEqual(merged.data, { a: 1, b: 2 });
});

test('identity arrays merge objects without duplicate ids', () => {
  const left = createStructuredUpdate({ sessions: [{ id: 'a', title: 'A' }] });
  const right = createStructuredUpdate({ sessions: [{ id: 'b', title: 'B' }] });
  const merged = mergeStructuredUpdates([left, right]);
  assert.deepEqual(
    merged.data.sessions.map((session) => session.id).sort(),
    ['a', 'b']
  );
});

test('session metadata merge keeps newer agent selection by timestamp', () => {
  const oldSession = { id: 's1', title: 'Chat', agentId: 'z-agent', updatedAtMs: 1000 };
  const newSession = { id: 's1', title: 'Chat', agentId: 'a-agent', updatedAtMs: 2000 };

  const merged = mergeStructuredUpdates([
    createStructuredUpdate([oldSession]),
    createStructuredUpdate([newSession]),
  ]);

  assert.equal(merged.data[0].agentId, 'a-agent');
  assert.equal(merged.data[0].updatedAtMs, 2000);
});

test('agent config merge keeps newer sandbox removal', () => {
  const oldAgent = {
    id: 'agent-a',
    name: 'Agent A',
    createdAt: '2026-01-01T00:00:00.000Z',
    llmProfileId: null,
    sandboxUrl: 'http://localhost:3099',
  };
  const newAgent = {
    ...oldAgent,
    updatedAtMs: 2000,
    sandboxUrl: null,
  };

  const merged = mergeStructuredUpdates([
    createStructuredUpdate({ agentsList: [oldAgent] }),
    createStructuredUpdate({ agentsList: [newAgent] }),
  ]);

  assert.equal(merged.data.agentsList[0].sandboxUrl, null);
  assert.equal(merged.data.agentsList[0].updatedAtMs, 2000);
});

test('agent config merge keeps newer sandbox selection', () => {
  const oldAgent = {
    id: 'agent-a',
    name: 'Agent A',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAtMs: 1000,
    llmProfileId: null,
    sandboxUrl: null,
  };
  const newAgent = {
    ...oldAgent,
    updatedAtMs: 2000,
    sandboxUrl: 'http://localhost:3099',
  };

  const merged = mergeStructuredUpdates([
    createStructuredUpdate({ agentsList: [oldAgent] }),
    createStructuredUpdate({ agentsList: [newAgent] }),
  ]);

  assert.equal(merged.data.agentsList[0].sandboxUrl, 'http://localhost:3099');
  assert.equal(merged.data.agentsList[0].updatedAtMs, 2000);
});

test('llm profile merge keeps newer cleared context window', () => {
  const oldConfig = {
    llm: {
      activeProfileId: 'llm-a',
      profiles: {
        'llm-a': {
          id: 'llm-a',
          name: 'Qwen',
          provider: 'custom-openai',
          model: 'qwen3.7-max',
          contextWindow: 128000,
          updatedAtMs: 1000,
        },
      },
    },
  };
  const newConfig = {
    llm: {
      activeProfileId: 'llm-a',
      profiles: {
        'llm-a': {
          ...oldConfig.llm.profiles['llm-a'],
          contextWindow: null,
          updatedAtMs: 2000,
        },
      },
    },
  };

  const merged = mergeStructuredUpdates([
    createStructuredUpdate(oldConfig),
    createStructuredUpdate(newConfig),
  ]);

  assert.equal(merged.data.llm.profiles['llm-a'].contextWindow, null);
  assert.equal(merged.data.llm.profiles['llm-a'].updatedAtMs, 2000);
});

test('scalar conflicts resolve to one deterministic Yjs value', () => {
  const left = createStructuredUpdate({ theme: 'light' });
  const right = createStructuredUpdate({ theme: 'dark' });
  const first = mergeStructuredUpdates([left, right]).data.theme;
  const second = mergeStructuredUpdates([right, left]).data.theme;
  assert.equal(first, second);
  assert.ok(['light', 'dark'].includes(first));
});

test('YAML roundtrip uses YAML output', () => {
  const remote = createStructuredUpdate({ general: { userNickname: 'Ada' } });
  const merged = mergeStructuredContent('config.yaml', 'theme: dark\n', remote);
  const parsed = parseStructuredContent('config.yaml', merged.content);
  assert.equal(parsed.theme, 'dark');
  assert.equal(parsed.general.userNickname, 'Ada');
  assert.match(formatStructuredContent('config.yaml', parsed), /theme: dark/);
});

test('config merge preserves a local null field clear', () => {
  const remote = createStructuredUpdate({ panel: { optionalUrl: 'https://example.test' } });
  const merged = mergeStructuredContent('config.yaml', 'panel:\n  optionalUrl: null\n', remote);
  const parsed = parseStructuredContent('config.yaml', merged.content);

  assert.equal(parsed.panel.optionalUrl, null);
});

test('config merge lets a local value restore a remote null field', () => {
  const remote = createStructuredUpdate({ panel: { optionalUrl: null } });
  const merged = mergeStructuredContent('config.yaml', 'panel:\n  optionalUrl: https://example.test\n', remote);
  const parsed = parseStructuredContent('config.yaml', merged.content);

  assert.equal(parsed.panel.optionalUrl, 'https://example.test');
});

test('merged update can reconstruct structured data', () => {
  const merged = mergeStructuredUpdates([
    createStructuredUpdate({ files: [{ name: 'a.md', size: 1 }] }),
    createStructuredUpdate({ files: [{ name: 'b.md', size: 2 }] }),
  ]);
  assert.deepEqual(readStructuredUpdate(merged.update).files.map((file) => file.name).sort(), ['a.md', 'b.md']);
});

test('forward-compatible tree encoding preserves reserved keys, duplicate identities, and JSON scalars', () => {
  const data = {
    __vertex_yjs_type__: 'user-owned',
    __vertex_yjs_order__: ['keep'],
    __vertex_yjs_items__: { keep: true },
    __vertex_yjs_value__: null,
    enabled: false,
    count: 0,
    optional: null,
    duplicateIds: [
      { id: 'same', value: 1 },
      { id: 'same', value: 2 },
    ],
    specialObjectKeys: JSON.parse('{"__proto__":{"polluted":false},"constructor":"user-owned"}'),
  };

  const update = createStructuredUpdate(data);
  const decoded = readStructuredUpdate(update);
  assert.deepEqual(decoded, data);
  assert.equal(Object.hasOwn(decoded.specialObjectKeys, '__proto__'), true);
  assert.equal({}.polluted, undefined);

  const legacyDecoded = readAsLegacyClient(update);
  assert.equal(Object.keys(legacyDecoded).length, Object.keys(data).length);
  assert.equal(legacyDecoded.enabled, false);
  assert.equal(legacyDecoded.count, 0);
  assert.equal(legacyDecoded.duplicateIds.length, 2);
  assert.ok(Object.values(legacyDecoded).includes('user-owned'));
  for (const scalar of [null, false, 0, '']) {
    const update = createStructuredUpdate(scalar);
    assert.deepEqual(readStructuredUpdate(update), scalar);
    assert.deepEqual(readAsLegacyClient(update), scalar);
    assert.deepEqual(mergeStructuredUpdates([update]).data, scalar);
  }
});

test('normal new documents reconstruct exactly through the legacy root.data decoder', () => {
  const data = {
    settings: { theme: 'dark', enabled: false, count: 0, optional: null },
    sessions: [
      { id: 's1', title: 'First' },
      { id: 's2', title: 'Second' },
    ],
    duplicateIds: [
      { id: 'same', sequence: 1 },
      { id: 'same', sequence: 2 },
    ],
    values: [null, false, 0, ''],
  };

  const update = createStructuredUpdate(data);
  assert.deepEqual(readAsLegacyClient(update), data);
  assert.deepEqual(readStructuredUpdate(update), data);
});

test('structured snapshot bytes are deterministic for cross-device deduplication', () => {
  const data = {
    settings: { theme: 'dark', enabled: true },
    values: Array.from({ length: 100 }, (_, index) => index),
  };
  assert.deepEqual(createStructuredUpdate(data), createStructuredUpdate(data));
});

test('new reader remains compatible with legacy nested Yjs updates', () => {
  const legacyData = {
    settings: { theme: 'dark', enabled: false },
    sessions: [
      { id: 's1', title: 'First' },
      { id: 's2', title: 'Second' },
    ],
  };

  assert.deepEqual(readStructuredUpdate(createLegacyUpdate(legacyData)), legacyData);
  assert.equal(readStructuredUpdate(createLegacyUpdate(null)), null);
});

test('YAML parsing preserves ISO timestamps as strings and all top-level scalar values', () => {
  const timestamp = parseStructuredContent('config.yaml', 'createdAt: 2026-01-01T00:00:00.000Z\n');
  assert.deepEqual(timestamp, { createdAt: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(parseStructuredContent('value.yaml', 'null\n'), null);
  assert.deepEqual(parseStructuredContent('value.yaml', 'false\n'), false);
  assert.deepEqual(parseStructuredContent('value.yaml', '0\n'), 0);
  assert.deepEqual(parseStructuredContent('value.yaml', "''\n"), '');

  for (const scalar of [null, false, 0, '']) {
    assert.deepEqual(
      parseStructuredContent('value.yaml', formatStructuredContent('value.yaml', scalar)),
      scalar
    );
    assert.deepEqual(
      parseStructuredContent('value.json', formatStructuredContent('value.json', scalar)),
      scalar
    );
  }

  const roundTrip = parseStructuredContent('config.yaml', formatStructuredContent('config.yaml', timestamp));
  assert.deepEqual(roundTrip, timestamp);
  assert.deepEqual(readStructuredUpdate(createStructuredUpdate(timestamp)), timestamp);
});

test('duplicate identity values are never collapsed during a two-way merge', () => {
  const left = createStructuredUpdate({
    items: [
      { id: 'duplicate', value: 'left-1' },
      { id: 'duplicate', value: 'left-2' },
    ],
  });
  const right = createStructuredUpdate({
    items: [
      { id: 'duplicate', value: 'right-1' },
      { id: 'duplicate', value: 'right-2' },
    ],
  });

  const merged = mergeStructuredUpdates([left, right]).data.items;
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'duplicate');
  assert.equal(merged[1].id, 'duplicate');
});

test('three-way merge propagates object key deletion when the other side is unchanged', () => {
  const base = { keep: true, remove: { nested: true } };
  const local = { keep: true };

  assert.deepEqual(mergeStructuredThreeWay(base, local, base), local);
  assert.deepEqual(mergeStructuredThreeWay(base, base, local), local);
});

test('three-way merge preserves __proto__ as an own data key without prototype mutation', () => {
  const base = JSON.parse('{"__proto__":{"value":"base"},"keep":true}');
  const local = JSON.parse('{"__proto__":{"value":"local"},"keep":true,"localOnly":true}');
  const remote = JSON.parse('{"__proto__":{"value":"base"},"keep":true,"remoteOnly":true}');
  const merged = mergeStructuredThreeWay(base, local, remote);

  assert.deepEqual(merged, JSON.parse('{"__proto__":{"value":"local"},"keep":true,"localOnly":true,"remoteOnly":true}'));
  assert.equal(Object.hasOwn(merged, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal({}.value, undefined);
});

test('three-way identity merge propagates independent removals from both sides', () => {
  const base = [
    { id: 'a', value: 1 },
    { id: 'b', value: 2 },
    { id: 'c', value: 3 },
  ];
  const local = [base[0], base[2]];
  const remote = [base[0], base[1]];

  assert.deepEqual(mergeStructuredThreeWay(base, local, remote), [base[0]]);
});

test('three-way identity merge unions concurrent additions deterministically', () => {
  const base = [{ id: 'a', value: 1 }];
  const local = [...base, { id: 'c', value: 3 }];
  const remote = [...base, { id: 'b', value: 2 }];
  const expected = [base[0], { id: 'b', value: 2 }, { id: 'c', value: 3 }];

  assert.deepEqual(mergeStructuredThreeWay(base, local, remote), expected);
  assert.deepEqual(mergeStructuredThreeWay(base, remote, local), expected);
});

test('three-way merge preserves an edit and truncation while accepting a concurrent append', () => {
  const user = { id: 'm1', role: 'user', content: 'original' };
  const discarded = { id: 'm2', role: 'assistant', content: 'discard me' };
  const base = [user, discarded];
  const local = [{ ...user, content: 'edited' }];
  const appended = { id: 'm3', role: 'user', content: 'concurrent message' };
  const remote = [...base, appended];

  assert.deepEqual(
    mergeStructuredThreeWay(base, local, remote),
    [{ ...user, content: 'edited' }, appended]
  );
});

test('three-way merge uses updatedAtMs only for true record conflicts and keeps independent additions', () => {
  const base = {
    id: 'profile-a',
    title: 'base',
    updatedAtMs: 100,
  };
  const local = {
    ...base,
    title: 'local title',
    localOnly: true,
    updatedAtMs: 200,
  };
  const remote = {
    ...base,
    title: 'remote title',
    remoteOnly: true,
    updatedAtMs: 300,
  };

  assert.deepEqual(mergeStructuredThreeWay(base, local, remote), {
    id: 'profile-a',
    localOnly: true,
    remoteOnly: true,
    title: 'remote title',
    updatedAtMs: 300,
  });
});

test('three-way true conflicts are symmetric and optional side timestamps take precedence', () => {
  const base = { theme: 'base' };
  const local = { theme: 'light' };
  const remote = { theme: 'dark' };
  const deterministic = mergeStructuredThreeWay(base, local, remote);

  assert.deepEqual(deterministic, mergeStructuredThreeWay(base, remote, local));
  assert.deepEqual(
    mergeStructuredThreeWay(base, local, remote, { localUpdatedAt: 200, remoteUpdatedAt: 100 }),
    local
  );
  assert.deepEqual(
    mergeStructuredThreeWay(base, remote, local, { localUpdatedAt: 100, remoteUpdatedAt: 200 }),
    local
  );
});

test('three-way merge is idempotent after removals, edits, and concurrent additions', () => {
  const base = {
    settings: { keep: true, remove: true },
    records: [
      { id: 'a', value: 'base' },
      { id: 'remove', value: 'old' },
    ],
  };
  const local = {
    settings: { keep: true },
    records: [{ id: 'a', value: 'local' }],
  };
  const remote = {
    settings: { keep: true, remove: true, remoteOnly: true },
    records: [
      { id: 'a', value: 'remote' },
      { id: 'remove', value: 'old' },
      { id: 'new', value: 'remote addition' },
    ],
  };
  const merged = mergeStructuredThreeWay(base, local, remote);

  assert.deepEqual(mergeStructuredThreeWay(base, merged, remote), merged);
  assert.deepEqual(mergeStructuredThreeWay(base, local, merged), merged);
  assert.deepEqual(mergeStructuredThreeWay(merged, merged, merged), merged);
});

test('three-way merge preserves duplicate identities and does not merge object arrays by index', () => {
  const duplicateBase = [
    { id: 'same', value: 'one' },
    { id: 'same', value: 'two' },
  ];
  const duplicateLocal = duplicateBase.map((item) => ({ ...item, local: true }));
  const duplicateRemote = duplicateBase.map((item) => ({ ...item, remote: true }));
  const duplicates = mergeStructuredThreeWay(duplicateBase, duplicateLocal, duplicateRemote);

  assert.equal(duplicates.length, 2);
  assert.equal(duplicates[0].id, 'same');
  assert.equal(duplicates[1].id, 'same');

  const concurrentObjects = mergeStructuredThreeWay([], [{ local: true }], [{ remote: true }]);
  assert.deepEqual(concurrentObjects, [{ local: true }, { remote: true }]);
});

test('three-way merge represents a top-level deletion as undefined', () => {
  const base = { value: true };
  assert.equal(mergeStructuredThreeWay(base, undefined, base), undefined);
  assert.equal(mergeStructuredThreeWay(base, base, undefined), undefined);
});
