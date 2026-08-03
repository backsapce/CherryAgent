import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLlmSettings } from './llmSettingsSchema.js';

const providerTypes = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
  'custom-openai': {
    id: 'custom-openai',
    name: 'Custom OpenAI-compatible',
    defaultBaseUrl: '',
  },
};

test('legacy profiles migrate to shared providers without changing LLM ids', () => {
  const { settings, migrated } = normalizeLlmSettings({
    activeProfileId: 'fast',
    profiles: {
      fast: {
        id: 'fast',
        name: 'Fast',
        provider: 'openai',
        apiKey: 'shared-key',
        baseUrl: 'https://api.openai.com/v1/',
        model: 'gpt-4.1-mini',
        contextWindow: 1000,
      },
      smart: {
        id: 'smart',
        name: 'Smart',
        provider: 'openai',
        apiKey: 'shared-key',
        model: 'gpt-4.1',
      },
    },
    deletedProfileIds: ['removed'],
  }, providerTypes);

  assert.equal(migrated, true);
  assert.equal(settings.schemaVersion, 2);
  assert.equal(settings.activeLlmId, 'fast');
  assert.deepEqual(Object.keys(settings.llms), ['fast', 'smart']);
  assert.equal(Object.keys(settings.providers).length, 1);
  assert.equal(settings.llms.fast.providerId, settings.llms.smart.providerId);
  assert.equal(settings.providers[settings.llms.fast.providerId].apiKey, 'shared-key');
  assert.equal(settings.llms.fast.apiKey, undefined);
  assert.deepEqual(settings.deletedLlmIds, ['removed']);
});

test('legacy profiles without credentials remain separate provider connections', () => {
  const { settings } = normalizeLlmSettings({
    profiles: {
      first: { provider: 'openai', model: 'gpt-4.1' },
      second: { provider: 'openai', model: 'gpt-4.1-mini' },
    },
  }, providerTypes);

  assert.equal(Object.keys(settings.providers).length, 2);
  assert.notEqual(settings.llms.first.providerId, settings.llms.second.providerId);
  assert.deepEqual(
    Object.values(settings.providers).map((provider) => provider.name),
    ['OpenAI', 'OpenAI 2']
  );
});

test('v2 keeps the same model independent across provider connections', () => {
  const { settings, migrated } = normalizeLlmSettings({
    schemaVersion: 2,
    activeLlmId: 'via-router',
    providers: {
      direct: { id: 'direct', name: 'Direct', type: 'openai', apiKey: 'key-a' },
      gateway: {
        id: 'gateway',
        name: 'Gateway',
        type: 'custom-openai',
        apiKey: 'key-b',
        baseUrl: 'https://gateway.example/v1',
      },
    },
    llms: {
      direct: { id: 'direct', providerId: 'direct', model: 'gpt-4.1' },
      'via-router': { id: 'via-router', providerId: 'gateway', model: 'gpt-4.1' },
    },
    deletedProviderIds: ['old-provider'],
    deletedLlmIds: ['old-llm'],
  }, providerTypes);

  assert.equal(migrated, false);
  assert.equal(settings.activeLlmId, 'via-router');
  assert.equal(settings.llms.direct.model, settings.llms['via-router'].model);
  assert.notEqual(settings.llms.direct.providerId, settings.llms['via-router'].providerId);
  assert.equal(settings.providers.gateway.apiKey, 'key-b');
  assert.deepEqual(settings.deletedProviderIds, ['old-provider']);
  assert.deepEqual(settings.deletedLlmIds, ['old-llm']);
});
