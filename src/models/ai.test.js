import assert from 'node:assert/strict';
import test from 'node:test';
import { jsonSchema, stepCountIs, streamText, tool } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { normalizeAiUsage, toModelMessages } from './ai.js';

test('AI SDK executes an OpenAI-compatible tool loop and emits unified events', async () => {
  let requestCount = 0;
  const model = createOpenAICompatible({
    name: 'test',
    apiKey: 'test-key',
    baseURL: 'https://example.test/v1',
    fetch: async () => {
      requestCount += 1;
      const data = requestCount === 1
        ? [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"echo","arguments":"{\\"value\\":\\"hello\\"}"}}]},"finish_reason":"tool_calls"}]}',
          'data: [DONE]',
        ]
        : [
          'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}',
          'data: [DONE]',
        ];
      return new Response(`${data.join('\n\n')}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  }).chatModel('test-model');

  const result = streamText({
    model,
    messages: [{ role: 'user', content: 'say hello' }],
    tools: {
      echo: tool({
        description: 'Echoes a value.',
        inputSchema: jsonSchema({
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        }),
        execute: async ({ value }) => `echo:${value}`,
      }),
    },
    stopWhen: stepCountIs(2),
    maxRetries: 0,
  });

  const events = [];
  for await (const event of result.fullStream) events.push(event.type);

  assert.equal(requestCount, 2);
  assert.equal(await result.text, 'done');
  assert.ok(events.includes('tool-call'));
  assert.ok(events.includes('tool-result'));
  assert.equal(events.at(-1), 'finish');
});

test('AI message conversion preserves image payloads and usage fields', () => {
  assert.deepEqual(toModelMessages([{
    role: 'user',
    content: 'What is in this image?',
    images: [{ type: 'image/png', dataUrl: 'data:image/png;base64,aGVsbG8=' }],
  }]), [{
    role: 'user',
    content: [
      { type: 'image', image: 'aGVsbG8=', mediaType: 'image/png' },
      { type: 'text', text: 'What is in this image?' },
    ],
  }]);
  assert.deepEqual(normalizeAiUsage({ inputTokens: 10, outputTokens: 4, totalTokens: 14 }), {
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14,
  });
});
