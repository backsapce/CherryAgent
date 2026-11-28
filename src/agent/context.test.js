import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleApiMessages, estimateTokens, summaryStateMatchesHistory } from './context.js';

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

test('failed or blank summaries stop the pass without replacing the previous summary or anchor', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const messages = longHistory();
  const previous = { content: 'Prior summary', coveredUntil: 5, anchorId: messages[4].id };
  for (const [summaryState, completeSummary] of [
    [previous, () => { throw new Error('summary offline'); }],
    [previous, () => '  \n '],
    [undefined, () => ''],
  ]) {
    let attempts = 0;
    const result = await assembleApiMessages({
      messages, contextWindow: 8_000, summaryState,
      completeSummary: () => { attempts += 1; return completeSummary(); },
    });
    assert.equal(attempts, 1);
    assert.deepEqual(result.summaryState, summaryState ?? { content: '', coveredUntil: 0, anchorId: null });
    assert.equal(result.summaryMessage?.content.includes('Prior summary') ?? false, Boolean(summaryState));
  }

  const retried = await assembleApiMessages({
    messages, contextWindow: 8_000, summaryState: previous,
    completeSummary: async () => 'Updated summary',
  });
  assert.equal(retried.summaryState.content, 'Updated summary');
  assert.ok(retried.summaryState.coveredUntil > previous.coveredUntil);
  assert.ok(summaryStateMatchesHistory(retried.summaryState, messages));
});

test('a legacy summary containing a failed pass does not hide older history', async () => {
  const messages = longHistory();
  const reset = await assembleApiMessages({
    messages, contextWindow: 1_000_000,
    summaryState: {
      content: 'Prior summary\n[5 earlier turns were compressed; summary generation failed: offline]',
      coveredUntil: 10,
      anchorId: messages[9].id,
    },
  });
  assert.deepEqual(reset.summaryState, { content: '', coveredUntil: 0, anchorId: null });
  assert.deepEqual(reset.apiMessages, messages);
});

test('summary calls fit the input budget and only cover history included in successful calls', async () => {
  const messages = longHistory('文');
  const requests = [];
  const result = await assembleApiMessages({
    messages, contextWindow: 8_000,
    completeSummary: async (prompt) => {
      assert.ok(estimateTokens(prompt) <= 5_760);
      requests.push(prompt[0].content);
      return requests.length === 1 ? 'First reply summarized' : '';
    },
  });
  assert.equal(requests.length, 2);
  assert.match(requests[0], /turn-0 /);
  assert.doesNotMatch(requests[0], /turn-1 /);
  assert.match(requests[1], /turn-1 /);
  assert.deepEqual(result.summaryState, { content: 'First reply summarized', coveredUntil: 1, anchorId: 'm-0' });
  const reopened = await assembleApiMessages({ messages, contextWindow: 1_000_000, summaryState: result.summaryState });
  assert.match(reopened.apiMessages[0].content, /First reply summarized/);
  assert.ok(!reopened.apiMessages.includes(messages[0]));
});

test('large ordinary text drops optional head and tail messages to fit an 8k context', async () => {
  const messages = longHistory();
  const result = await assembleApiMessages({ messages, contextWindow: 8_000, autoSummarize: false });
  assert.equal(result.compressed, true);
  assert.ok(result.estimatedTokens <= 5_760);
  assert.equal(result.estimatedTokens, estimateTokens(result.modelMessages, result.systemPrompt));
  assert.ok(result.apiMessages.length < 8);
  assert.equal(result.apiMessages.at(-1), messages.at(-1));
  assert.equal(result.latestUserMessage.content, 'The latest request');
});

test('the system prompt and latest user can exceed the budget even without history', async () => {
  await assert.rejects(assembleApiMessages({
    messages: [{ role: 'user', content: '文'.repeat(1_500) }],
    systemPrompt: '規'.repeat(3_200),
    contextWindow: 8_000,
  }), (error) => error?.code === 'CONTEXT_TOO_LARGE' && /system prompt and latest user/.test(error.message));
});

function longHistory(char = 'x') {
  return [
    ...Array.from({ length: 20 }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      content: `turn-${index} ${char.repeat(9_000)}`,
    })),
    { id: 'latest', role: 'user', content: 'The latest request' },
  ];
}

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

test('token estimation counts CJK text at roughly one token per character', () => {
  const latin = { role: 'user', content: 'a'.repeat(400) };
  const cjk = { role: 'user', content: '好'.repeat(400) };
  const latinTokens = estimateTokens([latin]);
  const cjkTokens = estimateTokens([cjk]);
  assert.ok(latinTokens <= 120, `latin estimate should stay near length/4, got ${latinTokens}`);
  assert.ok(cjkTokens >= 380, `CJK estimate should stay near one token per char, got ${cjkTokens}`);
});
