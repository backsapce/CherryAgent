import assert from 'node:assert/strict';
import test from 'node:test';
import { createLanguageModel } from '../models/ai.js';
import { resetReasoningCatalog } from '../models/reasoning.js';
import customOpenAI from '../models/providers/custom-openai.js';
import { runAgentLoop } from './loop.js';

const profile = {
  provider: 'custom-openai',
  apiKey: 'test-key',
  baseUrl: 'https://gateway.example/tenant/v1/responses/?api-version=test#ignored',
  model: 'test-reasoning-model',
  reasoningEffort: 'high',
};
const usage = {
  input_tokens: 20,
  input_tokens_details: { cached_tokens: 12 },
  output_tokens: 5,
  output_tokens_details: { reasoning_tokens: 2 },
};
const item = (event, outputIndex, data) => ({ type: `response.output_item.${event}`, output_index: outputIndex, item: data });
const complete = { type: 'response.completed', response: { usage } };
const text = (id, delta) => [
  item('added', 0, { type: 'message', id }),
  { type: 'response.output_text.delta', item_id: id, delta },
  item('done', 0, { type: 'message', id }),
  complete,
];
const sse = (events) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
  headers: { 'Content-Type': 'text/event-stream' },
});

const loopOptions = {
  provider: profile.provider,
  model: profile.model,
  runtimeContext: { workspaceDirName: 'responses-test', memorySnapshot: {} },
  systemPrompt: 'Follow the test instructions.',
  modelMaxRetries: 0,
  autoSummarize: false,
  maxRounds: 2,
};

async function withFetch(mock, run) {
  const saved = globalThis.fetch;
  globalThis.fetch = mock;
  resetReasoningCatalog();
  try { return await run(); } finally {
    globalThis.fetch = saved;
    resetReasoningCatalog();
  }
}

for (const maxRounds of [1, 2]) {
  test(`custom Responses runs native tools and replays local history (${maxRounds === 1 ? 'finalizer' : 'normal loop'})`, async () => {
    const requests = [];
    const toolArguments = '{"value":"hello"}';
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'echo' };
    const reasoning = { type: 'reasoning', id: 'rs_1' };
    const user = {
      role: 'user',
      content: 'Echo this.',
      images: [{ dataUrl: 'data:image/png;base64,aGVsbG8=' }],
    };
    const events = [];
    const executions = [];
    await withFetch(async (url, init) => {
      if (String(url) === 'https://models.dev/api.json') return Response.json({});
      assert.equal(String(url), 'https://gateway.example/tenant/v1/responses?api-version=test');
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-key');
      requests.push(JSON.parse(init.body));
      if (requests.length !== 1) return sse(text(`msg_${requests.length}`, 'Done.'));
      return sse([
        item('added', 0, reasoning),
        { type: 'response.reasoning_summary_text.delta', item_id: reasoning.id, summary_index: 0, delta: 'Use echo.' },
        item('done', 0, { ...reasoning, encrypted_content: 'opaque-state' }),
        item('added', 1, { ...call, arguments: '', status: 'in_progress' }),
        { type: 'response.function_call_arguments.delta', item_id: call.id, output_index: 1, delta: toolArguments },
        item('done', 1, { ...call, arguments: toolArguments, status: 'completed' }),
        complete,
      ]);
    }, async () => {
      const result = await runAgentLoop({
        ...loopOptions,
        maxRounds,
        languageModel: await createLanguageModel(profile),
        messages: [user],
        onEvent: (event) => events.push(event),
        toolSchemas: [{ name: 'echo', parameters: {
          type: 'object', properties: { value: { type: 'string' }, optional: { type: 'string' } }, required: ['value'],
        } }],
        dispatchTool: async (name, input) => { executions.push({ name, input }); return 'echo:hello'; },
      });
      assert.deepEqual(executions, [{ name: 'echo', input: { value: 'hello' } }]);
      assert.equal(result.content, 'Done.');
      assert.equal(result.thinking, 'Use echo.');
      assert.equal(result.toolCalls[0].status, 'completed');
      assert.equal(result.usage.cached_tokens, 12);
      assert.equal(result.usage.turn_total_tokens, 50);
      assert.ok(events.some(({ type }) => type === 'reasoning-delta'));
      assert.ok(events.some(({ type }) => type === 'tool-input-delta'));
      assert.equal(requests.length, 2);
      assert.equal(requests[0].stream, true);
      assert.equal(requests[0].parallel_tool_calls, false);
      assert.equal(requests[0].tools[0].strict, false);
      assert.deepEqual(requests[0].tools[0].parameters.required, ['value']);
      assert.deepEqual(requests[0].reasoning, { effort: 'high', summary: 'auto' });
      assert.ok(requests[0].include.includes('reasoning.encrypted_content'));
      assert.ok(requests[0].input.some(({ role }) => role === 'developer'));
      assert.ok(requests[0].input.find(({ role }) => role === 'user').content.some(({ type, image_url }) => (
        type === 'input_image' && image_url === user.images[0].dataUrl
      )));
      assert.equal(Boolean(requests[1].tools?.length), maxRounds > 1);
      assert.ok(requests[1].input.some(({ type, encrypted_content }) => type === 'reasoning' && encrypted_content === 'opaque-state'));

      // Rebuild the history and model from persisted state as a resumed run does.
      await runAgentLoop({
        ...loopOptions,
        runtimeMode: 'sandbox',
        languageModel: await createLanguageModel(profile),
        toolSchemas: [],
        messages: [user, { id: 'assistant-1', role: 'assistant', ...JSON.parse(JSON.stringify(result)) }, { role: 'user', content: 'Continue.' }],
      });
      assert.equal(requests.length, 3);
      assert.ok(!requests[2].input.some(({ type }) => type === 'reasoning'));
      for (const { input, store, previous_response_id } of requests.slice(1)) {
        assert.equal(store, false);
        assert.equal(previous_response_id, undefined);
        assert.ok(!input.some(({ type }) => type === 'item_reference'));
        const fn = input.find(({ type }) => type === 'function_call');
        const output = input.find(({ type }) => type === 'function_call_output');
        assert.equal(fn.call_id, 'call_1');
        assert.equal(fn.arguments, toolArguments);
        assert.equal(output.call_id, fn.call_id);
        assert.equal(output.output, 'echo:hello');
      }
    });
  });
}

test('custom generation URLs resolve model discovery to the sibling endpoint', async () => {
  await withFetch(async (url, init) => {
    assert.equal(String(url), 'https://gateway.example/tenant/v1/models?api-version=test');
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    return Response.json({ data: [{ id: 'b' }, { id: 'a' }] });
  }, async () => {
    assert.deepEqual(await customOpenAI.listModels(profile), [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }]);
  });
});

test('custom Responses surfaces the gateway failure after partial output', async () => {
  let requests = 0;
  await withFetch(async (url) => {
    if (String(url) === 'https://models.dev/api.json') return Response.json({});
    requests++;
    return sse([
      ...text('msg_partial', 'Partial text.').slice(0, 2),
      { type: 'response.failed', response: { error: { code: 'gateway_error', message: 'Gateway disconnected upstream' } } },
    ]);
  }, async () => {
    const events = [];
    await assert.rejects(runAgentLoop({
      ...loopOptions,
      languageModel: await createLanguageModel(profile),
      messages: [{ role: 'user', content: 'Hello' }],
      toolSchemas: [],
      onEvent: (event) => events.push(event),
    }), /Gateway disconnected upstream/);
    assert.ok(events.some(({ type }) => type === 'text-delta'));
    assert.ok(events.some(({ type }) => type === 'run-error'));
    assert.ok(!events.some(({ type }) => type === 'run-finish'));
    assert.equal(requests, 1);
  });
});
