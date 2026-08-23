import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import config from '../config/config.js';
import llm from '../models/llm.js';
import { getEnabledToolSchemas, registry } from './tools.js';
import { runAgentLoop } from './loop.js';
import { compactToolResultForModel } from './toolObservation.js';

const TEST_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const PARENT_PROFILE = 'profile-parent';
const CHILD_PROFILE = 'profile-child';

let rootDir;

const originalGetLanguageModel = llm.getLanguageModel;
const originalGetActiveConfig = llm.getActiveConfig;

beforeEach(async () => {
  rootDir = new TestDirectoryHandle();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      storage: {
        getDirectory: async () => rootDir,
      },
    },
  });
  await config.init();
});

afterEach(() => {
  llm.getLanguageModel = originalGetLanguageModel;
  llm.getActiveConfig = originalGetActiveConfig;
});

test('spawn_agent is hidden from delegated runs (depth gating)', () => {
  const depthZero = getEnabledToolSchemas({ agentId: 'agent-a', llmProfileId: PARENT_PROFILE, subAgentDepth: 0 });
  assert.ok(depthZero.some((tool) => tool.name === 'spawn_agent'));

  const depthOne = getEnabledToolSchemas({ agentId: 'agent-a', llmProfileId: PARENT_PROFILE, subAgentDepth: 1 });
  assert.ok(!depthOne.some((tool) => tool.name === 'spawn_agent'));
});

test('spawn_agent results keep a larger model-context budget than regular tools', () => {
  const long = 'x'.repeat(60_000);
  const compactedDefault = compactToolResultForModel({ name: 'execute_command' }, long, { contextWindow: 200_000 });
  const compactedSpawn = compactToolResultForModel({ name: 'spawn_agent' }, long, { contextWindow: 200_000 });

  assert.ok(compactedDefault.length <= 8_500);
  assert.ok(compactedSpawn.length <= 20_500);
  assert.ok(compactedSpawn.length > compactedDefault.length);
});

test('unknown or ambiguous agent names fail per task without starting a run', async () => {
  await config.set('agentsList', [
    { id: 'agent-aaa111', name: 'dup', createdAt: new Date().toISOString() },
    { id: 'agent-bbb222', name: 'dup', createdAt: new Date().toISOString() },
  ]);
  const ctx = { agentId: 'agent-aaa111', agentName: 'dup', llmProfileId: PARENT_PROFILE, subAgentDepth: 0 };

  const missing = await registry.dispatch('spawn_agent', { task: 'do it', agent_name: 'ghost' }, ctx);
  assert.match(missing, /Delegated agent task for ghost failed: Agent not found: ghost/);

  const ambiguous = await registry.dispatch('spawn_agent', { task: 'do it', agent_name: 'dup' }, ctx);
  assert.match(ambiguous, /Multiple agents are named "dup" \(agent-aaa111, agent-bbb222\)/);
  assert.match(ambiguous, /agent_id/);
});

test('a failed task no longer hides sibling results, and sub-agent usage is aggregated', async () => {
  await config.set('agentsList', [
    { id: 'agent-alpha01', name: 'alpha', createdAt: new Date().toISOString() },
  ]);
  const capturedProfiles = [];
  llm.getLanguageModel = (profileId) => {
    capturedProfiles.push(profileId);
    return createTextModel('sub report');
  };

  const events = [];
  const result = await runAgentLoop({
    ...parentRunOptions('agent-alpha01', 'alpha'),
    languageModel: createSpawningParentModel({
      tasks: [
        { task: 'task one' },
        { task: 'task two', agent_name: 'missing-agent' },
      ],
    }),
    onEvent: (event) => events.push(event),
  });

  const spawnCall = result.toolCalls.find((toolCall) => toolCall.name === 'spawn_agent');
  assert.equal(spawnCall.status, 'completed');
  assert.match(spawnCall.result, /Agent alpha \(agent-alpha01\) completed\./);
  assert.match(spawnCall.result, /sub report/);
  assert.match(spawnCall.result, /Delegated agent task for missing-agent failed: Agent not found: missing-agent/);

  // The surviving task must not be lost behind the failed one.
  assert.ok(spawnCall.result.indexOf('completed.') < spawnCall.result.indexOf('failed:'));

  // Sub-agent tokens are folded into the turn totals: parent made two model
  // calls (2 tokens each) and the sub-agent made one.
  assert.equal(result.usage.turn_prompt_tokens, 3);
  assert.equal(result.usage.turn_completion_tokens, 3);
  assert.equal(result.usage.turn_total_tokens, 6);

  // The caller profile is inherited when the agent has no profile of its own.
  assert.deepEqual(capturedProfiles, [PARENT_PROFILE]);

  // Sub-agent progress is surfaced through the parent's tool-status events.
  assert.ok(events.some((event) => (
    event.type === 'tool-status'
    && event.toolName === 'spawn_agent'
    && /\[alpha\] finished \(1 model calls\)/.test(event.terminalOutput || '')
  )));
});

test('a delegated agent uses its own configured model profile', async () => {
  await config.set('agentsList', [
    { id: 'agent-alpha01', name: 'alpha', createdAt: new Date().toISOString(), llmProfileId: CHILD_PROFILE },
  ]);
  const capturedProfiles = [];
  llm.getActiveConfig = (profileId) => (profileId === CHILD_PROFILE
    ? { id: CHILD_PROFILE, configured: true, provider: 'anthropic', model: 'claude-test', contextWindow: 12_345 }
    : { id: null, configured: false });
  llm.getLanguageModel = (profileId) => {
    capturedProfiles.push(profileId);
    return createTextModel('sub report');
  };

  const result = await runAgentLoop({
    ...parentRunOptions('agent-alpha01', 'alpha'),
    languageModel: createSpawningParentModel({ task: 'single task' }),
  });

  const spawnCall = result.toolCalls.find((toolCall) => toolCall.name === 'spawn_agent');
  assert.equal(spawnCall.status, 'completed');
  assert.match(spawnCall.result, /Agent alpha \(agent-alpha01\) completed\./);
  assert.deepEqual(capturedProfiles, [CHILD_PROFILE]);
});

test('tasks sharing one workspace run sequentially while distinct workspaces stay parallel', async () => {
  await config.set('agentsList', [
    { id: 'agent-alpha01', name: 'alpha', createdAt: new Date().toISOString() },
    { id: 'agent-beta002', name: 'beta', createdAt: new Date().toISOString() },
  ]);

  const sameWorkspace = await runWithConcurrencyTracking('agent-alpha01', 'alpha', {
    tasks: [{ task: 'task one' }, { task: 'task two' }],
  });
  assert.equal(sameWorkspace.maxActive, 1);
  assert.equal(sameWorkspace.completed, 2);

  const distinctWorkspaces = await runWithConcurrencyTracking('agent-alpha01', 'alpha', {
    tasks: [
      { task: 'task one', agent_name: 'alpha' },
      { task: 'task two', agent_name: 'beta' },
    ],
  });
  assert.equal(distinctWorkspaces.maxActive, 2);
  assert.equal(distinctWorkspaces.completed, 2);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function runWithConcurrencyTracking(agentId, agentName, spawnInput) {
  let active = 0;
  let maxActive = 0;
  let completed = 0;
  llm.getLanguageModel = () => new MockLanguageModelV3({
    doStream: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      completed += 1;
      return {
        stream: simulateReadableStream({
          chunks: textChunks('sub report'),
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });

  const result = await runAgentLoop({
    ...parentRunOptions(agentId, agentName),
    languageModel: createSpawningParentModel(spawnInput),
  });
  const spawnCall = result.toolCalls.find((toolCall) => toolCall.name === 'spawn_agent');
  assert.equal(spawnCall.status, 'completed');
  return { maxActive, completed };
}

function parentRunOptions(agentId, agentName) {
  return {
    messages: [{ role: 'user', content: 'delegate work' }],
    maxRounds: 6,
    autoSummarize: false,
    agentId,
    llmProfileId: PARENT_PROFILE,
    provider: 'openai',
    model: 'gpt-4o-test',
    contextWindow: 100_000,
    toolSchemas: getEnabledToolSchemas({ agentId, llmProfileId: PARENT_PROFILE, subAgentDepth: 0 }),
    runtimeContext: {
      workspaceDirName: agentId,
      activeAgent: { id: agentId, name: agentName },
      memorySnapshot: { memory: null, user: null },
      skillsList: '',
      agentIdentity: null,
    },
  };
}

function createSpawningParentModel(spawnInput) {
  let callCount = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'call-spawn',
                toolName: 'spawn_agent',
                input: JSON.stringify(spawnInput),
              },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: TEST_USAGE },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: textChunks('delegation finished'),
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}

function createTextModel(text) {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: textChunks(text),
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }),
  });
}

function textChunks(text) {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: text },
    { type: 'text-end', id: 'text-1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: TEST_USAGE },
  ];
}

class TestDirectoryHandle {
  kind = 'directory';

  constructor() {
    this.entries = new Map();
  }

  async getDirectoryHandle(name, options = {}) {
    const existing = this.entries.get(name);
    if (existing) {
      if (existing.kind !== 'directory') throw new Error(`${name} is not a directory`);
      return existing;
    }
    if (!options.create) throw new Error(`Directory not found: ${name}`);
    const dir = new TestDirectoryHandle();
    this.entries.set(name, dir);
    return dir;
  }

  async getFileHandle(name, options = {}) {
    const existing = this.entries.get(name);
    if (existing) {
      if (existing.kind !== 'file') throw new Error(`${name} is not a file`);
      return existing;
    }
    if (!options.create) throw new Error(`File not found: ${name}`);
    const file = new TestFileHandle();
    this.entries.set(name, file);
    return file;
  }

  async removeEntry(name) {
    if (!this.entries.delete(name)) throw new Error(`Entry not found: ${name}`);
  }

  async *[Symbol.asyncIterator]() {
    for (const entry of this.entries) {
      yield entry;
    }
  }
}

class TestFileHandle {
  kind = 'file';

  constructor() {
    this.content = '';
  }

  async getFile() {
    return {
      text: async () => this.content,
    };
  }

  async createWritable() {
    const chunks = [];
    return {
      write: async (content) => {
        chunks.push(String(content));
      },
      close: async () => {
        this.content = chunks.join('');
      },
    };
  }
}
