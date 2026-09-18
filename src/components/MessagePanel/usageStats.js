// Pure derivation for the per-message model usage popover. The persisted
// usage report mixes whole-turn totals (turn_* fields, present once a reply
// spans multiple model calls or sub-agents) with the latest call's counts and
// provider-native aliases for legacy messages; this module normalizes them
// into the values the popover renders.

export function deriveUsageStats(usage) {
  const timing = usage?.timing || null;
  const inputTokens = firstFinite(
    usage?.turn_prompt_tokens,
    usage?.prompt_tokens,
    usage?.input_tokens
  );
  const outputTokens = firstFinite(
    usage?.turn_completion_tokens,
    usage?.completion_tokens,
    usage?.output_tokens
  );
  const totalTokens = firstFinite(
    usage?.turn_total_tokens,
    usage?.total_tokens,
    inputTokens != null || outputTokens != null
      ? (inputTokens || 0) + (outputTokens || 0)
      : NaN
  );
  // Decode speed falls back to the whole duration when per-step decode time is
  // unavailable (e.g. messages persisted before timing capture existed).
  const decodeSeconds = timing?.decode_ms > 0
    ? timing.decode_ms / 1000
    : (timing?.duration_ms > 0 ? timing.duration_ms / 1000 : null);
  const speed = decodeSeconds && outputTokens > 0 ? outputTokens / decodeSeconds : null;
  const modelCallCount = Number(usage?.model_call_count);
  return {
    timing,
    inputTokens,
    outputTokens,
    totalTokens,
    decodeSeconds,
    speed,
    modelCallCount: Number.isFinite(modelCallCount) && modelCallCount > 0 ? modelCallCount : null,
  };
}

export function formatStatNumber(value) {
  if (value == null) return '—';
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : '—';
}

export function formatStatMs(ms) {
  if (ms == null) return '—';
  const number = Number(ms);
  if (!Number.isFinite(number) || number < 0) return '—';
  if (number < 1000) return `${Math.round(number)} ms`;
  return `${(number / 1000).toFixed(number < 10000 ? 2 : 1)} s`;
}

function firstFinite(...values) {
  for (const value of values) {
    if (value == null) continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return NaN;
}
