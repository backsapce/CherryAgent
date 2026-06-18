import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getModelContextWindowFallback,
  getStaticContextWindow,
} from './contextWindow.js';

test('Qwen 3.7 Max resolves to a 1M context window on custom OpenAI-compatible profiles', () => {
  assert.equal(getModelContextWindowFallback('custom-openai', 'qwen3.7-max'), 1_000_000);
  assert.equal(getStaticContextWindow('custom-openai', 'qwen3.7-max'), 1_000_000);
});

test('Qwen 3.7 Max accepts dashed model aliases', () => {
  assert.equal(getModelContextWindowFallback('qwen', 'qwen3-7-max'), 1_000_000);
});

test('older Qwen3 open-weight names keep the existing 262k fallback', () => {
  assert.equal(getModelContextWindowFallback('qwen', 'qwen3-32b'), 262_144);
});
