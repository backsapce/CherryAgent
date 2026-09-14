import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleApiMessages, summaryStateMatchesHistory } from './context.js';

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
  assert.match(result.systemPrompt, /synchronized into skills\/ without replacing skills that already exist in the sandbox/);
  assert.match(result.systemPrompt, /skill tool interacts only with the sandbox skills\/ directory/);
  assert.match(result.systemPrompt, /Use execute_command only when there is strong reason to expect completion within 30 seconds/);
  assert.match(result.systemPrompt, /training, a server, watcher/);
  assert.match(result.systemPrompt, /Never add nohup, &, disown, screen, tmux/);
  assert.match(result.systemPrompt, /Schedule a future continuation/);
  assert.match(result.systemPrompt, /message beginning with \/<skill-name> explicitly selects that enabled skill/);
  assert.match(result.systemPrompt, /Read it with the skill tool before acting/);
});

test('browser runtime prompt tells the model to prefer managed jobs when duration is uncertain', async () => {
  const result = await assembleApiMessages({
    messages: [{ role: 'user', content: 'run the task' }],
    runtimeMode: 'browser',
    autoSummarize: false,
  });

  assert.match(result.systemPrompt, /When uncertain, choose wait_command/);
  assert.match(result.systemPrompt, /call wait_command with the command/);
  assert.match(result.systemPrompt, /Never use execute_command to "try" a long command first/);
  assert.match(result.systemPrompt, /Sparse or silent output does not prove a job is stuck/);
  assert.match(result.systemPrompt, /message beginning with \/<skill-name> explicitly selects that enabled skill/);
  assert.match(result.systemPrompt, /Read the named skill before acting/);
});

test('a persisted summary is reused without re-summarizing and gains an anchor', async () => {
  const messages = [];
  for (let index = 0; index < 60; index += 1) {
    messages.push({ id: `m-${index}`, role: index % 2 ? 'assistant' : 'user', content: `turn ${index} ${'x'.repeat(900)}` });
  }
  const summaryState = { content: 'summary of the early turns', coveredUntil: 30 };

  const result = await assembleApiMessages({
    messages,
    contextWindow: 8_000,
    summaryState,
    autoSummarize: false,
  });

  assert.equal(result.compressed, true);
  assert.match(result.apiMessages.map((m) => m.content).join('\n'), /summary of the early turns/);
  assert.equal(result.summaryState.anchorId, 'm-29');
  // coveredUntil stays put: the same turns are not summarized again.
  assert.equal(result.summaryState.coveredUntil, 30);
});

test('summaryStateMatchesHistory validates indices against the anchor id', () => {
  const messages = [
    { id: 'a', role: 'user', content: '1' },
    { id: 'b', role: 'assistant', content: '2' },
    { id: 'c', role: 'user', content: '3' },
  ];
  assert.equal(summaryStateMatchesHistory({ content: 's', coveredUntil: 2, anchorId: 'b' }, messages), true);
  // Append-only growth keeps the anchor valid.
  assert.equal(summaryStateMatchesHistory({ content: 's', coveredUntil: 2, anchorId: 'b' }, [...messages, { id: 'd', role: 'assistant', content: '4' }]), true);
  // History edited or truncated: same index now points at a different message.
  assert.equal(summaryStateMatchesHistory({ content: 's', coveredUntil: 2, anchorId: 'b' }, [messages[0], { id: 'z', role: 'assistant', content: 'edited' }]), false);
  // Covered range no longer inside the history.
  assert.equal(summaryStateMatchesHistory({ content: 's', coveredUntil: 9, anchorId: 'b' }, messages), false);
  assert.equal(summaryStateMatchesHistory({ content: '', coveredUntil: 2 }, messages), false);
  assert.equal(summaryStateMatchesHistory(undefined, messages), false);
});

test('token estimation counts CJK text at roughly one token per character', async () => {
  const { estimateTokens } = await import('./context.js');
  const latin = { role: 'user', content: 'a'.repeat(400) };
  const cjk = { role: 'user', content: '好'.repeat(400) };
  const latinTokens = estimateTokens([latin]);
  const cjkTokens = estimateTokens([cjk]);
  assert.ok(latinTokens <= 120, `latin estimate should stay near length/4, got ${latinTokens}`);
  assert.ok(cjkTokens >= 380, `CJK estimate should stay near one token per char, got ${cjkTokens}`);
});
