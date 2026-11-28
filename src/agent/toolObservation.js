const TOOL_OBSERVATION_CONTEXT_RATIO = 0.04;
const TOOL_OBSERVATION_MIN_CHARS = 4_000;
const TOOL_OBSERVATION_MAX_CHARS = 24_000;
const TOOL_OBSERVATION_HEAD_RATIO = 0.62;
const COMMAND_JOB_TOOLS = new Set(['start_command', 'get_command', 'wait_command', 'stop_command']);

// Delegation reports are the entire point of a spawn_agent call, so the parent
// model gets a much larger share of the context window for them.
const TOOL_OBSERVATION_OVERRIDES = {
  spawn_agent: { ratio: 0.1, minChars: 8_000, maxChars: 48_000 },
};

export function compactToolResultForModel(toolCall, result, opts = {}) {
  const text = String(result ?? '');
  const maxChars = opts.maxChars ?? getToolObservationMaxChars(opts.contextWindow, toolCall);
  if (text.length <= maxChars) return text;

  if (COMMAND_JOB_TOOLS.has(toolCall?.name)) {
    const snapshot = compactCommandLog(text, maxChars);
    if (snapshot) return snapshot;
  }
  const notice = [
    `[tool result compacted for next model turn: ${text.length} chars -> ${maxChars} chars]`,
    `Tool: ${toolCall?.name || 'unknown'}`,
    'Fuller output remains available in the visible tool result/debug export. If missing detail matters, call a narrower command or read a smaller range.',
    '',
  ].join('\n');
  const contentBudget = maxChars - notice.length;
  if (contentBudget < 80) {
    return maxChars < 100
      ? '[Tool output omitted to fit the context budget.]'
      : truncateMiddle(text, maxChars, 'tool result compacted');
  }
  return `${notice}${truncateMiddle(text, contentBudget)}`;
}

// Job cursors remain usable even when the log needs truncation. Keep the
// snapshot as JSON and shorten only the log field, not the surrounding state.
function compactCommandLog(text, maxChars) {
  try {
    const snapshot = JSON.parse(text);
    if (typeof snapshot?.log !== 'string') return null;
    const log = snapshot.log;
    snapshot.log = '';
    const remaining = maxChars - JSON.stringify(snapshot, null, 2).length;
    if (remaining < 300) return null;
    // JSON escaping can expand a log character by up to six characters.
    snapshot.log = truncateMiddle(log, Math.floor(remaining / 6), 'command log compacted');
    return JSON.stringify(snapshot, null, 2);
  } catch {
    return null;
  }
}

function getToolObservationMaxChars(contextWindow, toolCall) {
  // A skill read is instructions, not noisy logs. Apply this same bounded
  // limit on its first observation and on replay, with no pinned copy.
  const override = toolCall?.name === 'skill' && toolCall.parsedArgs?.action === 'read'
    ? { ratio: 0.2, minChars: 8_000, maxChars: 80_000 }
    : TOOL_OBSERVATION_OVERRIDES[toolCall?.name];
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
