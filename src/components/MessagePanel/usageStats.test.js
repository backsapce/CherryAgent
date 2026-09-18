import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveUsageStats, formatStatNumber, formatStatMs } from './usageStats.js';

test('deriveUsageStats prefers whole-turn totals over the latest call', () => {
  const stats = deriveUsageStats({
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
    turn_prompt_tokens: 700,
    turn_completion_tokens: 300,
    turn_total_tokens: 1000,
    model_call_count: 4,
    timing: { first_token_ms: 800, prefill_ms: 900, decode_ms: 6000, duration_ms: 8000 },
  });

  assert.equal(stats.inputTokens, 700);
  assert.equal(stats.outputTokens, 300);
  assert.equal(stats.totalTokens, 1000);
  assert.equal(stats.modelCallCount, 4);
  assert.equal(stats.speed, 50); // 300 tokens over 6 decode seconds
});

test('deriveUsageStats falls back to single-call counts and legacy aliases', () => {
  const legacy = deriveUsageStats({ input_tokens: 12, output_tokens: 6 });
  assert.equal(legacy.inputTokens, 12);
  assert.equal(legacy.outputTokens, 6);
  assert.equal(legacy.totalTokens, 18);
  assert.equal(legacy.modelCallCount, null);

  const modern = deriveUsageStats({ prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 });
  assert.equal(modern.totalTokens, 18);
  assert.equal(modern.speed, null); // no timing -> no speed
});

test('deriveUsageStats derives speed from total duration when decode time is missing', () => {
  const stats = deriveUsageStats({
    prompt_tokens: 10,
    completion_tokens: 40,
    total_tokens: 50,
    timing: { first_token_ms: 500, duration_ms: 10000 },
  });

  assert.equal(stats.decodeSeconds, 10);
  assert.equal(stats.speed, 4);
});

test('deriveUsageStats handles missing or zeroed usage', () => {
  assert.equal(deriveUsageStats(null).inputTokens, NaN);
  assert.equal(deriveUsageStats({}).speed, null);
  const zeroed = deriveUsageStats({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, timing: { decode_ms: 0, duration_ms: 0 } });
  assert.equal(zeroed.speed, null);
});

test('formatStatNumber localizes finite values and dashes the rest', () => {
  assert.equal(formatStatNumber(12345), '12,345');
  assert.equal(formatStatNumber('700'), '700');
  assert.equal(formatStatNumber(NaN), '—');
  assert.equal(formatStatNumber(undefined), '—');
});

test('formatStatMs renders milliseconds and seconds with sensible precision', () => {
  assert.equal(formatStatMs(830), '830 ms');
  assert.equal(formatStatMs(2500), '2.50 s');
  assert.equal(formatStatMs(12500), '12.5 s');
  assert.equal(formatStatMs(null), '—');
  assert.equal(formatStatMs(-1), '—');
});
