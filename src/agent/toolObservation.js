const TOOL_OBSERVATION_CONTEXT_RATIO = 0.04;
const TOOL_OBSERVATION_MIN_CHARS = 4_000;
const TOOL_OBSERVATION_MAX_CHARS = 24_000;
const TOOL_OBSERVATION_HEAD_RATIO = 0.62;

// Delegation reports are the entire point of a spawn_agent call, so the parent
// model gets a much larger share of the context window for them.
const TOOL_OBSERVATION_OVERRIDES = {
  spawn_agent: { ratio: 0.1, minChars: 8_000, maxChars: 48_000 },
};

export function compactToolResultForModel(toolCall, result, opts = {}) {
  const text = String(result ?? '');
  const maxChars = getToolObservationMaxChars(opts.contextWindow, toolCall?.name);
  if (text.length <= maxChars) return text;

  const notice = [
    `[tool result compacted for next model turn: ${text.length} chars -> ${maxChars} chars]`,
    `Tool: ${toolCall?.name || 'unknown'}`,
    'Fuller output remains available in the visible tool result/debug export. If missing detail matters, call a narrower command or read a smaller range.',
    '',
  ].join('\n');
  const contentBudget = Math.max(1_000, maxChars - notice.length);
  return `${notice}${truncateMiddle(text, contentBudget)}`;
}

function getToolObservationMaxChars(contextWindow, toolName) {
  const override = TOOL_OBSERVATION_OVERRIDES[toolName];
  const ratio = override?.ratio ?? TOOL_OBSERVATION_CONTEXT_RATIO;
  const parsed = Number(contextWindow);
  const rawLimit = Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed * ratio)
    : (override?.maxChars ?? TOOL_OBSERVATION_MAX_CHARS);
  return clampNumber(
    rawLimit,
    override?.minChars ?? TOOL_OBSERVATION_MIN_CHARS,
    override?.maxChars ?? TOOL_OBSERVATION_MAX_CHARS
  );
}

/**
 * Two-pass middle truncation shared with the tool registry. Without `label`
 * the marker is the observation style; with it, `label` prefixes the
 * omitted-chars count (tool-result style).
 */
export function truncateMiddle(text, maxChars, label = null) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;

  let marker = label ? `\n[${label}]\n` : '\n[... truncated middle ...]\n';
  let available = Math.max(1, maxChars - marker.length);
  let headChars = Math.ceil(available * TOOL_OBSERVATION_HEAD_RATIO);
  let tailChars = Math.max(0, available - headChars);
  let omitted = Math.max(0, value.length - headChars - tailChars);

  marker = label
    ? `\n[${label}: ${omitted} chars omitted from middle]\n`
    : `\n[... omitted ${omitted} chars from middle ...]\n`;
  available = Math.max(1, maxChars - marker.length);
  headChars = Math.ceil(available * TOOL_OBSERVATION_HEAD_RATIO);
  tailChars = Math.max(0, available - headChars);

  return `${value.slice(0, headChars)}${marker}${value.slice(value.length - tailChars)}`;
}

function clampNumber(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
}
