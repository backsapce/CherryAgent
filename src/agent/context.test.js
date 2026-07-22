import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleApiMessages } from './context.js';

test('sandbox prompt includes transferred identity and skill catalog', async () => {
  const result = await assembleApiMessages({
    messages: [{ role: 'user', content: 'hello' }],
    systemPrompt: 'sandbox client prompt',
    runtimeMode: 'sandbox',
    agentIdentity: '# Agent: Test',
    skillsList: '<skill_catalog>\n- review: Review code\n</skill_catalog>',
    memorySnapshot: { memory: null, user: null },
    autoSummarize: false,
  });

  assert.match(result.systemPrompt, /<agent_identity>\n# Agent: Test/);
  assert.match(result.systemPrompt, /<skill_catalog>[\s\S]*review: Review code/);
  assert.match(result.systemPrompt, /copied into the sandbox only when their destination paths do not already exist/);
  assert.match(result.systemPrompt, /Use execute_command only when there is strong reason to expect completion within 30 seconds/);
  assert.match(result.systemPrompt, /training, a server, watcher/);
  assert.match(result.systemPrompt, /Never add nohup, &, disown, screen, tmux/);
  assert.match(result.systemPrompt, /Schedule a future continuation/);
  assert.match(result.systemPrompt, /message beginning with \/<skill-name> explicitly selects that enabled skill/);
  assert.match(result.systemPrompt, /Read skills\/<skill-name>\/SKILL\.md before acting/);
});

test('browser runtime prompt tells the model to prefer managed jobs when duration is uncertain', async () => {
  const result = await assembleApiMessages({
    messages: [{ role: 'user', content: 'run the task' }],
    runtimeMode: 'browser',
    autoSummarize: false,
  });

  assert.match(result.systemPrompt, /When uncertain, choose start_command/);
  assert.match(result.systemPrompt, /Never use execute_command to "try" a long command first/);
  assert.match(result.systemPrompt, /Sparse or silent output does not prove a job is stuck/);
  assert.match(result.systemPrompt, /message beginning with \/<skill-name> explicitly selects that enabled skill/);
  assert.match(result.systemPrompt, /Read the named skill before acting/);
});
