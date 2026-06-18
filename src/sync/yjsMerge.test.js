import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStructuredUpdate,
  formatStructuredContent,
  mergeStructuredContent,
  mergeStructuredUpdates,
  parseStructuredContent,
  readStructuredUpdate,
} from './yjsMerge.js';

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
