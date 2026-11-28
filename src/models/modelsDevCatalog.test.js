import assert from 'node:assert/strict';
import test from 'node:test';
import config from '../config/config.js';
import { getStaticContextWindow } from './contextWindow.js';
import llm from './llm.js';
import { resetModelsDevCatalog } from './modelsDevCatalog.js';
import { resolveReasoningLevels } from './reasoning.js';

test('profile and reasoning lookups share a deadline through body parsing and can retry', async (t) => {
  resetModelsDevCatalog();
  t.after(resetModelsDevCatalog);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(config, 'set', async () => {});
  t.mock.method(console, 'warn', () => {});
  const { id: providerId } = await llm.configureProvider({ type: 'openai' });
  const model = 'shared-model';
  let markBodyStarted;
  const bodyStarted = new Promise((resolve) => { markBodyStarted = resolve; });
  const signals = [];
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    assert.equal(url, 'https://models.dev/api.json');
    signals.push(signal);
    if (signals.length === 1) {
      return {
        ok: true,
        json() {
          markBodyStarted();
          return new Promise(() => {});
        },
      };
    }
    return Response.json({ openai: { models: { [model]: { reasoning: true, limit: { context: 9000 } } } } });
  });

  const saving = llm.configureLlm({ providerId, model });
  const levels = resolveReasoningLevels('openai', model);
  await bodyStarted;
  assert.equal(signals.length, 1, 'both consumers await the same catalog');
  t.mock.timers.tick(5_000);
  assert.equal((await saving).contextWindow, getStaticContextWindow('openai', model));
  assert.deepEqual(await levels, []);
  assert.equal(signals[0].aborted, true);

  const saved = await llm.configureLlm({ providerId, model, contextWindow: null });
  assert.equal(saved.contextWindow, 9000);
  assert.deepEqual(await resolveReasoningLevels('openai', model), ['low', 'medium', 'high']);
  assert.equal(signals.length, 2);
});
