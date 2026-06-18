const TOOL_OBSERVATION_CONTEXT_RATIO = 0.04;
const TOOL_OBSERVATION_MIN_CHARS = 4_000;
const TOOL_OBSERVATION_MAX_CHARS = 24_000;
const TOOL_OBSERVATION_HEAD_RATIO = 0.62;

export function compactToolResultForModel(toolCall, result, opts = {}) {
  const text = String(result ?? '');
  const maxChars = getToolObservationMaxChars(opts.contextWindow);
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

function getToolObservationMaxChars(contextWindow) {
  const parsed = Number(contextWindow);
  const rawLimit = Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed * TOOL_OBSERVATION_CONTEXT_RATIO)
    : TOOL_OBSERVATION_MAX_CHARS;
  return clampNumber(rawLimit, TOOL_OBSERVATION_MIN_CHARS, TOOL_OBSERVATION_MAX_CHARS);
}

function truncateMiddle(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;

  let marker = '\n[... truncated middle ...]\n';
  let available = Math.max(1, maxChars - marker.length);
  let headChars = Math.ceil(available * TOOL_OBSERVATION_HEAD_RATIO);
  let tailChars = Math.max(0, available - headChars);
  let omitted = Math.max(0, value.length - headChars - tailChars);

  marker = `\n[... omitted ${omitted} chars from middle ...]\n`;
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
