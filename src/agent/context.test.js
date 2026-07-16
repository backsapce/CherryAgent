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
});
