/**
 * Detect repeated identical tool calls before they become a costly doom loop.
 *
 * The guard is intentionally independent from providers and UI code. The loop
 * decides how to request approval; this module only makes the decision
 * deterministic and keeps a bounded history for one agent run.
 */

export const DOOM_LOOP_THRESHOLD = 3;
const DEFAULT_HISTORY_LIMIT = 80;

export function createToolLoopGuard({
  threshold = DOOM_LOOP_THRESHOLD,
  historyLimit = DEFAULT_HISTORY_LIMIT,
} = {}) {
  const calls = [];
  const safeThreshold = normalizePositiveInteger(threshold, DOOM_LOOP_THRESHOLD);
  const safeHistoryLimit = Math.max(safeThreshold, normalizePositiveInteger(historyLimit, DEFAULT_HISTORY_LIMIT));

  return {
    check({ toolName, input }) {
      const candidate = {
        toolName: String(toolName || 'unknown_tool'),
        inputKey: stableToolInput(input),
      };
      const recent = calls.slice(-(safeThreshold - 1));
      const repeated = recent.length === safeThreshold - 1
        && recent.every((call) => call.toolName === candidate.toolName && call.inputKey === candidate.inputKey);

      calls.push(candidate);
      if (calls.length > safeHistoryLimit) calls.splice(0, calls.length - safeHistoryLimit);

      return {
        repeated,
        threshold: safeThreshold,
        occurrences: repeated ? safeThreshold : countTrailingMatches(calls, candidate),
      };
    },
    snapshot() {
      return calls.map((call) => ({ ...call }));
    },
  };
}

/** Serialize JSON-like tool input with sorted object keys for stable matching. */
export function stableToolInput(input) {
  try {
    return JSON.stringify(normalizeValue(input));
  } catch {
    return String(input);
  }
}

function normalizeValue(value) {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        if (value[key] !== undefined) result[key] = normalizeValue(value[key]);
        return result;
      }, {});
  }
  return value;
}

function countTrailingMatches(calls, candidate) {
  let count = 0;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call.toolName !== candidate.toolName || call.inputKey !== candidate.inputKey) break;
    count += 1;
  }
  return count;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
