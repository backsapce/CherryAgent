import test from 'node:test';
import assert from 'node:assert/strict';
import { reasoningLevels, reasoningProviderOptions, summaryProviderOptions, resolveReasoningLevels, resetReasoningCatalog } from './reasoning.js';
import { normalizeLlmConfig } from './llmSettingsSchema.js';
import { createLanguageModel } from './ai.js';

test('reasoning capability does not imply adjustable effort for budget-only models', () => {
  assert.deepEqual(reasoningLevels('anthropic', 'claude-sonnet-4-5', { reasoning: true }), []);
  assert.deepEqual(reasoningLevels('gemini', 'gemini-2.5-pro', { reasoning: true }), []);
  assert.deepEqual(reasoningLevels('openai', 'gpt-4o', { reasoning: false }), []);
  assert.deepEqual(reasoningLevels('gemini', 'gemini-3-pro-preview', { reasoning: true }), ['low', 'high']);
});

test('effort survives configuration normalization and invalid values are discarded', () => {
  assert.equal(normalizeLlmConfig('test', { reasoningEffort: 'high' }).reasoningEffort, 'high');
  assert.equal(normalizeLlmConfig('test', { reasoningEffort: 'invalid' }).reasoningEffort, null);
});

test('provider options use the native effort shape', () => {
  assert.deepEqual(reasoningProviderOptions('anthropic', 'high'), { anthropic: { thinking: { type: 'adaptive' }, effort: 'high' } });
  assert.deepEqual(reasoningProviderOptions('openrouter', 'low'), { openrouter: { reasoning: { effort: 'low' } } });
});

/** Responses-API shaped generate result with a single assistant text message. */
function responsesGeneratePayload(model) {
  return {
    id: 'resp_test',
    object: 'response',
    created_at: 1,
    status: 'completed',
    model,
    output: [{
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'OK', annotations: [] }],
    }],
    usage: { input_tokens: 1, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 },
  };
}

/**
 * Stub fetch with a models.dev catalog and capture the API request.
 * Returns the captured { url, body } of the first non-catalog request.
 */
async function stubFetchAndGenerate({ catalog, config }) {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('models.dev')) return Response.json(catalog);
    request = { url: String(url), body: JSON.parse(init.body) };
    return Response.json(responsesGeneratePayload(config.model));
  };
  resetReasoningCatalog();
  try {
    const model = await createLanguageModel(config);
    await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] });
  } finally {
    globalThis.fetch = originalFetch;
    resetReasoningCatalog();
  }
  return request;
}

test('model factory passes configured effort and summary request to the Responses API', async () => {
  const request = await stubFetchAndGenerate({
    catalog: { openai: { models: { 'gpt-5': { reasoning: true } } } },
    config: { provider: 'openai', apiKey: 'test', model: 'gpt-5', reasoningEffort: 'high' },
  });
  assert.ok(request.url.endsWith('/responses'), `expected /responses, got ${request.url}`);
  assert.deepEqual(request.body.reasoning, { effort: 'high', summary: 'auto' });
});

test('reasoning summaries are requested for reasoning models without a configured effort', async () => {
  // gpt-sol is absent from the SDK's built-in reasoning-model allowlist, so
  // this also proves forceReasoning keeps the reasoning block in the body.
  const request = await stubFetchAndGenerate({
    catalog: { openai: { models: { 'gpt-5.6-sol': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }] } } } },
    config: { provider: 'openai', apiKey: 'test', model: 'gpt-5.6-sol' },
  });
  assert.ok(request.url.endsWith('/responses'), `expected /responses, got ${request.url}`);
  assert.deepEqual(request.body.reasoning, { summary: 'auto' });
});

test('non-reasoning OpenAI models send no reasoning block', async () => {
  const request = await stubFetchAndGenerate({
    catalog: { openai: { models: { 'gpt-4o': { reasoning: false } } } },
    config: { provider: 'openai', apiKey: 'test', model: 'gpt-4o' },
  });
  assert.equal(request.body.reasoning, undefined);
});

test('custom OpenAI base URLs keep the Chat Completions protocol', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('models.dev')) {
      return Response.json({ openai: { models: { 'gpt-5': { reasoning: true } } } });
    }
    request = { url: String(url), body: JSON.parse(init.body) };
    return Response.json({
      id: 'chatcmpl_test', object: 'chat.completion', created: 1, model: 'gpt-5',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  };
  resetReasoningCatalog();
  try {
    const model = await createLanguageModel({
      provider: 'openai', apiKey: 'test', model: 'gpt-5',
      baseUrl: 'https://proxy.example/v1', reasoningEffort: 'high',
    });
    await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] });
  } finally {
    globalThis.fetch = originalFetch;
    resetReasoningCatalog();
  }
  assert.ok(request.url.endsWith('/chat/completions'), `expected /chat/completions, got ${request.url}`);
  assert.equal(request.body.reasoning_effort, 'high');
});

test('a model keeps its reasoning fallback after a failed catalog fetch', async (t) => {
  resetReasoningCatalog();
  t.after(resetReasoningCatalog);
  let catalogRequests = 0;
  const reasons = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).includes('models.dev')) {
      catalogRequests += 1;
      if (catalogRequests === 1) throw new Error('catalog offline');
      return Response.json({ openai: { models: { alias: { reasoning: false } } } });
    }
    reasons.push(JSON.parse(init.body).reasoning);
    return Response.json(responsesGeneratePayload('alias'));
  });
  const config = {
    provider: 'custom-openai', apiKey: 'test', model: 'alias', reasoningEffort: 'high',
    baseUrl: 'https://gateway.example/v1/responses',
  };
  const request = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] };
  const model = await createLanguageModel(config);
  await model.doGenerate(request);
  await model.doGenerate(request);
  assert.equal(catalogRequests, 1);
  await (await createLanguageModel(config)).doGenerate(request);
  assert.equal(catalogRequests, 2, 'a new model may retry the catalog');
  assert.deepEqual(reasons, [{ effort: 'high', summary: 'auto' }, { effort: 'high', summary: 'auto' }, undefined]);
});

test('chat models without an applicable effort skip the catalog', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url) => {
    assert.ok(String(url).endsWith('/chat/completions'));
    return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] });
  });
  for (const [provider, reasoningEffort] of [['openai', undefined], ['openai', 'max'], ['deepseek', 'high']]) {
    const model = await createLanguageModel({
      provider, apiKey: 'test', model: 'alias', baseUrl: 'https://proxy.example/v1', reasoningEffort,
    });
    await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] });
  }
  assert.equal(fetch.mock.callCount(), 3);
});

test('summary provider options only apply to the OpenAI provider', () => {
  assert.deepEqual(summaryProviderOptions('openai'), { openai: { reasoningSummary: 'auto', forceReasoning: true } });
  assert.deepEqual(summaryProviderOptions('openrouter'), {});
  assert.deepEqual(summaryProviderOptions('custom-openai'), {});
});

test('reasoning levels come from models.dev reasoning_options when available', () => {
  const gpt52 = { reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] }] };
  assert.deepEqual(reasoningLevels('openai', 'gpt-5.2', gpt52), ['none', 'low', 'medium', 'high', 'xhigh']);
  const opus = { reasoning: true, reasoning_options: [{ type: 'effort', values: ['max', 'low', 'xhigh', 'high', 'medium'] }] };
  assert.deepEqual(reasoningLevels('anthropic', 'claude-opus-4-8', opus), ['low', 'medium', 'high', 'xhigh', 'max']);
  const flash = { reasoning: true, reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high'] }] };
  assert.deepEqual(reasoningLevels('gemini', 'gemini-3-flash-preview', flash), ['minimal', 'low', 'medium', 'high']);
});

test('catalog effort values are filtered per provider and unknown values are dropped', () => {
  // google's thinkingLevel cannot carry none/xhigh
  const odd = { reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high', 'xhigh', 'dynamic'] }] };
  assert.deepEqual(reasoningLevels('gemini', 'gemini-3-pro-preview', odd), ['low', 'high']);
  // budget-only entries still expose no effort menu
  assert.deepEqual(reasoningLevels('anthropic', 'claude-sonnet-4-5', { reasoning: true, reasoning_options: [{ type: 'budget_tokens', min: 1024 }] }), []);
  // non-reasoning models stay hidden even with stray options
  assert.deepEqual(reasoningLevels('openai', 'gpt-4o', { reasoning: false, reasoning_options: [{ type: 'effort', values: ['low'] }] }), []);
  // unrecognized provider keys get no menu
  assert.deepEqual(reasoningLevels('deepseek', 'deepseek-chat', { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] }), []);
});

test('effort normalization accepts the full models.dev effort range', () => {
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(normalizeLlmConfig('test', { reasoningEffort: effort }).reasoningEffort, effort);
  }
  assert.equal(normalizeLlmConfig('test', { reasoningEffort: 'invalid' }).reasoningEffort, null);
});

test('extended efforts reach native provider options', () => {
  assert.deepEqual(
    reasoningProviderOptions('openai', 'xhigh'),
    { openai: { reasoningEffort: 'xhigh', reasoningSummary: 'auto', forceReasoning: true } },
  );
  assert.deepEqual(reasoningProviderOptions('anthropic', 'max'), { anthropic: { thinking: { type: 'adaptive' }, effort: 'max' } });
  assert.deepEqual(reasoningProviderOptions('gemini', 'minimal'), { google: { thinkingConfig: { thinkingLevel: 'minimal', includeThoughts: true } } });
});

test('resolveReasoningLevels prefers catalog effort lists over heuristics', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('models.dev')) {
      return Response.json({
        openai: { models: { 'gpt-5.2': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] }] } } },
        anthropic: { models: { 'claude-opus-4-8': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }] } } },
        google: { models: { 'gemini-3-pro-preview': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] } } },
      });
    }
    throw new Error('unexpected fetch');
  };
  resetReasoningCatalog();
  try {
    assert.deepEqual(await resolveReasoningLevels('openai', 'gpt-5.2'), ['none', 'low', 'medium', 'high', 'xhigh']);
    assert.deepEqual(await resolveReasoningLevels('anthropic', 'claude-opus-4-8'), ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(await resolveReasoningLevels('gemini', 'gemini-3-pro-preview'), ['low', 'high']);
  } finally { globalThis.fetch = originalFetch; }
});

test('custom Responses can generate a summary with native options, and does not force reasoning for a text model', async () => {
  const catalog = { openai: { models: { 'new-alias': { reasoning: true }, 'gpt-4o': { reasoning: false } } } };
  const config = { provider: 'custom-openai', apiKey: 'test', baseUrl: 'https://gateway.example/v1/responses' };
  for (const [model, reasoning] of [['new-alias', { summary: 'auto' }], ['gpt-4o', undefined], ['private-text-alias', undefined]]) {
    const request = await stubFetchAndGenerate({ catalog, config: { ...config, model } });
    assert.equal(request.url, config.baseUrl);
    assert.equal(request.body.store, false);
    assert.deepEqual(request.body.reasoning, reasoning);
  }
});
