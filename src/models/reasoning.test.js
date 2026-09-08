import test from 'node:test';
import assert from 'node:assert/strict';
import { reasoningLevels, reasoningProviderOptions } from './reasoning.js';
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

test('model factory passes configured effort to the API request', async () => {
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('models.dev')) return Response.json({ openai: { models: { 'gpt-5': { reasoning: true } } } });
    body = JSON.parse(init.body);
    return Response.json({ id: 'test', created: 1, model: 'gpt-5', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  };
  try {
    const model = createLanguageModel({ provider: 'openai', apiKey: 'test', model: 'gpt-5', reasoningEffort: 'high' });
    await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] });
    assert.equal(body.reasoning_effort, 'high');
  } finally { globalThis.fetch = originalFetch; }
});
