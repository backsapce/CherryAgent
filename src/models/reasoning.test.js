import test from 'node:test';
import assert from 'node:assert/strict';
import { reasoningLevels, reasoningProviderOptions, resolveReasoningLevels, resetReasoningCatalog } from './reasoning.js';
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
    const model = await createLanguageModel({ provider: 'openai', apiKey: 'test', model: 'gpt-5', reasoningEffort: 'high' });
    await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] });
    assert.equal(body.reasoning_effort, 'high');
  } finally { globalThis.fetch = originalFetch; }
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
  assert.deepEqual(reasoningProviderOptions('openai', 'xhigh'), { openai: { reasoningEffort: 'xhigh' } });
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
