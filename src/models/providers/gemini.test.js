import assert from 'node:assert/strict';
import test from 'node:test';
import { readGeminiSSE } from './gemini.js';

function sseStream(payloads) {
  const encoder = new TextEncoder();
  const text = payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

test('Gemini SSE yields every function call part with a distinct index', async () => {
  const stream = sseStream([
    {
      candidates: [{
        content: {
          parts: [
            {
              functionCall: {
                name: 'write_skill_file',
                args: { path: 'demo/SKILL.md', content: 'skill' },
              },
            },
            {
              functionCall: {
                name: 'write_skill_file',
                args: { path: 'demo/references/example.md', content: 'ref' },
              },
            },
          ],
        },
      }],
    },
  ]);

  const calls = [];
  for await (const chunk of readGeminiSSE(stream)) {
    if (chunk.toolCalls) calls.push(...chunk.toolCalls);
  }

  assert.deepEqual(calls.map((call) => call.index), [0, 1]);
  assert.deepEqual(calls.map((call) => call.name), ['write_skill_file', 'write_skill_file']);
  assert.equal(JSON.parse(calls[0].arguments).path, 'demo/SKILL.md');
  assert.equal(JSON.parse(calls[1].arguments).path, 'demo/references/example.md');
});
