import assert from 'node:assert/strict';
import test from 'node:test';
import { toModelMessages } from '../models/ai.js';
import { assistantReplayFields } from './sessionHistory.js';
import { assembleApiMessages } from './context.js';

const text = (stepId, content) => ({ type: 'text', stepId, content });
const tool = (stepId, toolCallId) => ({ type: 'tool', stepId, toolCallId });
const call = (id, name, parsedArgs, result, status = 'completed') => ({ id, name, parsedArgs, result, status });

const skillBody = `# Demo\n${'Instruction '.repeat(420)}\nSKILL_TAIL`;
const reply = {
  id: 'reply',
  role: 'assistant', content: 'Reading.\n\nFinished.',
  transcript: [
    text('one', 'Reading.'), tool('one', 'run:call-1'), tool('one', 'call-2'),
    tool('one', 'call-pending'), { type: 'reasoning', content: 'internal' }, text('two', 'Finished.'),
  ],
  toolCalls: [
    { ...call('run:call-1', 'skill', { action: 'read', name: 'demo' }, skillBody), googleThoughtSignature: 'opaque' },
    call('call-2', 'read_sandbox_file', { path: 'a.txt' }, 'Oops', 'error'),
    call('call-pending', 'read_sandbox_file', { path: 'b.txt' }, 'partial', 'running'),
  ],
};

test('persisted browser reply replays native batches in transcript order with full skill output', () => {
  const serialized = JSON.parse(JSON.stringify({ role: 'assistant', content: reply.content, ...assistantReplayFields(reply) }));
  const [assistant, toolResults, final, user] = toModelMessages([serialized, { role: 'user', content: 'next task' }], { contextWindow: 32_000 });
  assert.deepEqual([assistant.role, toolResults.role, final.role, user.role], ['assistant', 'tool', 'assistant', 'user']);
  assert.deepEqual(assistant.content, [
    { type: 'text', text: 'Reading.' },
    { type: 'tool-call', toolCallId: 'run_call-1', toolName: 'skill', input: { action: 'read', name: 'demo' }, providerOptions: { google: { thoughtSignature: 'opaque' } } },
    { type: 'tool-call', toolCallId: 'call-2', toolName: 'read_sandbox_file', input: { path: 'a.txt' } },
  ]);
  assert.deepEqual(toolResults.content, [
    { type: 'tool-result', toolCallId: 'run_call-1', toolName: 'skill', output: { type: 'text', value: skillBody } },
    { type: 'tool-result', toolCallId: 'call-2', toolName: 'read_sandbox_file', output: { type: 'error-text', value: 'Oops' } },
  ]);
  assert.deepEqual(final.content, [{ type: 'text', text: 'Finished.' }]);
});

test('legacy calls can replay from raw arguments and duplicate IDs do not collide', () => {
  const legacy = {
    role: 'assistant', content: 'done',
    toolCalls: [{ id: 'same', name: 'skill', status: 'completed', rawArgs: '{"action":"list"}', result: 'catalog' }],
  };
  const projected = toModelMessages([legacy, legacy]);
  const ids = projected.filter((m) => m.role === 'tool').map((m) => m.content[0].toolCallId);
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(projected.filter((m) => m.role === 'assistant').flatMap((m) => m.content)
    .filter((part) => part.type === 'tool-call').map((part) => part.toolCallId), ids);
});

test('compaction counts tool observations, summarizes whole replies and keeps recent native pairs', async () => {
  const messages = Array.from({ length: 28 }, (_, index) => index % 2 === 0
    ? { id: `m${index}`, role: 'user', content: 'Go on' }
    : { ...reply, id: `m${index}` });
  const requests = [];
  const packed = await assembleApiMessages({
    messages, contextWindow: 16_000,
    completeSummary: async ([message]) => {
      requests.push(message.content);
      return 'Compacted older tool findings.';
    },
  });
  assert.ok(packed.compressed);
  assert.match(requests[0], /tool-call.*skill/);
  assert.match(requests[0], /tool-result.*Instruction/);
  const projected = toModelMessages(packed.apiMessages, { contextWindow: 16_000 });
  assert.deepEqual(projected.at(-2).content[0].output.value, skillBody);
  for (const [index, message] of projected.entries()) {
    if (message.role !== 'tool') continue;
    assert.deepEqual(message.content.map((part) => part.toolCallId),
      projected[index - 1].content.filter((part) => part.type === 'tool-call').map((part) => part.toolCallId));
  }
  const reopened = await assembleApiMessages({ messages, contextWindow: 1_000_000, summaryState: packed.summaryState });
  assert.ok(reopened.apiMessages.some((message) => message.content.includes('Compacted older tool findings.')));
  assert.ok(!reopened.apiMessages.some((message) => message.id === packed.summaryState.anchorId));
});
