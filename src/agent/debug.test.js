import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatDebugExport, createChatDebugFilename } from './debug.js';

test('buildChatDebugExport records active LLM, context estimates, and tool calls', () => {
  const messages = [
    {
      id: 'u1',
      role: 'user',
      content: 'Please inspect this file.',
      images: [{ name: 'screen.png', type: 'image/png', size: 12, dataUrl: 'data:image/png;base64,abc' }],
      contextFiles: [{ source: 'browser', relativePath: 'note.md', size: 9, content: 'file body' }],
    },
    {
      id: 'a1',
      role: 'assistant',
      content: 'Done.',
      usage: {
        prompt_tokens: 42,
        completion_tokens: 8,
        total_tokens: 50,
        content_len: 1000,
        turn_prompt_tokens: 120,
        turn_completion_tokens: 18,
        turn_total_tokens: 138,
        model_call_count: 3,
      },
      toolCalls: [
        {
          id: 'tc1',
          name: 'execute_command',
          status: 'completed',
          command: 'npm test',
          parsedArgs: { command: 'npm test' },
          rawArgs: '{"command":"npm test"}',
          result: 'ok',
        },
      ],
    },
  ];

  const debug = buildChatDebugExport({
    session: { id: 's1', title: 'Debug Me', messages, agentId: 'agent-a', llmProfileId: 'p1' },
    messages,
    llmMessages: [
      { role: 'user', content: 'Please inspect this file.\n\nSelected file context:\nfile body' },
      { role: 'assistant', content: 'Done.' },
    ],
    systemPrompt: 'system prompt',
    llmProfile: {
      id: 'p1',
      name: 'Work',
      provider: 'openai',
      model: 'gpt-4.1',
      contextWindow: 1000,
      configured: true,
      hasApiKey: true,
    },
    provider: { name: 'OpenAI' },
    agent: { id: 'agent-a', name: 'Agent A', sandboxUrl: 'http://localhost:3099' },
    runtime: { activeSessionId: 's1', streaming: true, hasToolContext: true },
    generatedAt: '2026-06-18T00:00:00.000Z',
  });

  assert.equal(debug.type, 'vertex-agent-chat-debug');
  assert.equal(debug.llm.providerName, 'OpenAI');
  assert.equal(debug.agent.hasSandbox, true);
  assert.equal(debug.context.providerUsage.total_tokens, 50);
  assert.equal(debug.context.providerUsage.turn_total_tokens, 138);
  assert.equal(debug.context.providerUsage.model_call_count, 3);
  assert.equal(debug.context.providerWindowRatio, 0.05);
  assert.ok(debug.context.rawMessageEstimatedTokens > 0);
  assert.ok(debug.context.llmInputEstimatedTokens > 0);
  assert.equal(typeof debug.context.estimatedWindowRatio, 'number');
  assert.equal(debug.toolCalls.count, 1);
  assert.equal(debug.toolCalls.byStatus.completed, 1);
  assert.deepEqual(debug.toolCalls.items[0].parsedArgs, { command: 'npm test' });
  assert.equal(debug.messages[0].images[0].dataUrlChars, 25);
  assert.equal(debug.messages[0].contextFiles[0].content, 'file body');
});

test('createChatDebugFilename keeps the export name filesystem friendly', () => {
  const filename = createChatDebugFilename(
    { id: 'Session 1', title: 'Hello / Debug!' },
    new Date('2026-06-18T00:00:00.000Z')
  );

  assert.equal(filename, 'vertex-agent-debug-hello-debug-session-1-2026-06-18T00-00-00-000Z.json');
});
