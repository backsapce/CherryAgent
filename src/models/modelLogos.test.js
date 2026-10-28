import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MODELS_DEV_PROVIDER,
  getModelsDevProviderCandidates,
  inferModelFamilyProvider,
  modelLogoId,
  modelLogoUrl,
} from './modelLogos.js';

test('provider type aliases map to models.dev provider ids', () => {
  assert.equal(MODELS_DEV_PROVIDER.gemini, 'google');
  assert.equal(MODELS_DEV_PROVIDER.qwen, 'alibaba');
});

test('catalog candidates keep the connection provider first, then routed lab prefixes', () => {
  assert.deepEqual(
    getModelsDevProviderCandidates('openrouter', 'anthropic/claude-sonnet-4'),
    ['openrouter', 'anthropic'],
  );
  assert.deepEqual(
    getModelsDevProviderCandidates('gemini', 'gemini-2.5-pro'),
    ['google', 'gemini'],
  );
  // Direct providers do not parse model ids as prefixes.
  assert.deepEqual(
    getModelsDevProviderCandidates('openai', 'gpt-4o'),
    ['openai'],
  );
});

test('catalog candidates infer the lab for custom endpoints serving standard models', () => {
  // `custom-openai` itself is not a models.dev provider; the inferred lab is
  // what makes the catalog (context window) lookup succeed.
  assert.deepEqual(
    getModelsDevProviderCandidates('custom-openai', 'gpt-4o'),
    ['custom-openai', 'openai'],
  );
  assert.deepEqual(
    getModelsDevProviderCandidates('custom-openai', 'deepseek/deepseek-chat'),
    ['custom-openai', 'deepseek'],
  );
  // Inference dedupes against the provider type.
  assert.deepEqual(
    getModelsDevProviderCandidates('deepseek', 'deepseek-chat'),
    ['deepseek'],
  );
});

test('model families are inferred from bare model ids', () => {
  assert.equal(inferModelFamilyProvider('gpt-4o'), 'openai');
  assert.equal(inferModelFamilyProvider('o3-mini'), 'openai');
  assert.equal(inferModelFamilyProvider('GPT-5.5'), 'openai');
  assert.equal(inferModelFamilyProvider('claude-sonnet-4'), 'anthropic');
  assert.equal(inferModelFamilyProvider('gemini-2.5-pro'), 'google');
  assert.equal(inferModelFamilyProvider('deepseek-chat'), 'deepseek');
  assert.equal(inferModelFamilyProvider('qwen3-max'), 'alibaba');
  assert.equal(inferModelFamilyProvider('kimi-k2'), 'moonshotai');
  assert.equal(inferModelFamilyProvider('glm-4.7'), 'zhipuai');
  assert.equal(inferModelFamilyProvider('grok-4'), 'xai');
  assert.equal(inferModelFamilyProvider('minimax-m2'), 'minimax');
  assert.equal(inferModelFamilyProvider('mistral-large'), 'mistral');
  assert.equal(inferModelFamilyProvider('llama-3.3-70b-instruct'), 'meta');
  assert.equal(inferModelFamilyProvider('hunyuan-t1'), 'tencent');
  assert.equal(inferModelFamilyProvider('ernie-4.5'), 'baidu');
  assert.equal(inferModelFamilyProvider('nova-pro-v1'), 'amazon');
  assert.equal(inferModelFamilyProvider('phi-4'), 'microsoft');
  assert.equal(inferModelFamilyProvider('command-r'), 'cohere');
  // Distilled releases belong to the distilling lab, not the base family.
  assert.equal(inferModelFamilyProvider('deepseek-r1-distill-qwen-32b'), 'deepseek');
  // Routed ids resolve to the lab, not the router.
  assert.equal(inferModelFamilyProvider('openrouter/anthropic/claude-sonnet-4'), 'anthropic');
  assert.equal(inferModelFamilyProvider('models/gemini-2.5-pro'), 'google');
  // Unrecognised names stay unknown.
  assert.equal(inferModelFamilyProvider('my-private-model-v2'), null);
  assert.equal(inferModelFamilyProvider(''), null);
  assert.equal(inferModelFamilyProvider(null), null);
});

test('display logos prefer the lab behind a routed model over the router', () => {
  assert.equal(modelLogoId('openrouter', 'anthropic/claude-sonnet-4'), 'anthropic');
  assert.equal(modelLogoId('custom-openai', 'deepseek/deepseek-chat'), 'deepseek');
});

test('custom endpoints serving standard lab models resolve the lab logo', () => {
  assert.equal(modelLogoId('custom-openai', 'gpt-4o'), 'openai');
  assert.equal(modelLogoUrl('custom-openai', 'gpt-4o'), 'https://models.dev/logos/openai.svg');
  assert.equal(modelLogoId('custom-openai', 'claude-sonnet-4'), 'anthropic');
  assert.equal(modelLogoId('custom-openai', 'gemini-2.5-pro'), 'google');
  assert.equal(modelLogoId('custom-openai', 'qwen3-max'), 'alibaba');
  assert.equal(modelLogoId('custom-openai', 'deepseek-chat'), 'deepseek');
  assert.equal(modelLogoId('custom-openai', 'kimi-k2'), 'moonshotai');
  assert.equal(modelLogoId('custom-openai', 'glm-4.7'), 'zhipuai');
});

test('display logos fall back through the provider type alias', () => {
  assert.equal(modelLogoId('gemini', 'gemini-2.5-pro'), 'google');
  assert.equal(modelLogoId('qwen', 'qwen3-max'), 'alibaba');
  assert.equal(modelLogoId('deepseek', 'deepseek-chat'), 'deepseek');
  // The connection's provider type wins over what the model name suggests.
  assert.equal(modelLogoId('deepseek', 'llama-3.3-70b'), 'deepseek');
});

test('unrecognised custom endpoints resolve to no hotlink (local default icon)', () => {
  assert.equal(modelLogoId('custom-openai', 'my-private-model-v2'), null);
  assert.equal(modelLogoUrl('custom-openai', 'my-private-model-v2'), null);
});

test('logo urls hotlink the models.dev svg endpoint with encoded ids', () => {
  assert.equal(modelLogoUrl('anthropic', 'claude-sonnet-4'), 'https://models.dev/logos/anthropic.svg');
  assert.equal(modelLogoUrl('openrouter', 'google/gemini-2.5-pro'), 'https://models.dev/logos/google.svg');
});

test('unknown direct provider types still hotlink their raw id', () => {
  // models.dev serves its generic fallback logo for unknown ids (never 404).
  assert.equal(modelLogoUrl('mistral', 'mistral-large-4'), 'https://models.dev/logos/mistral.svg');
});
