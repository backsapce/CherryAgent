const MAX_WAIT_SECONDS = 7 * 24 * 60 * 60;

/**
 * Effective wait duration in seconds, defaulting to 30 when absent. Prefers a
 * runtime-reported per-call budget (sandbox runs slice long waits into bounded
 * calls) over the model-requested duration.
 */
export function getWaitCommandWaitSeconds(toolCall) {
  if (toolCall?.name !== 'wait_command') return null;
  const budgetSeconds = Number(toolCall.waitBudgetSeconds);
  if (Number.isFinite(budgetSeconds) && budgetSeconds >= 1) {
    return Math.min(MAX_WAIT_SECONDS, Math.round(budgetSeconds));
  }
  const seconds = Number(toolCall.parsedArgs?.wait_seconds);
  if (!Number.isFinite(seconds) || seconds < 1) return 30;
  return Math.min(MAX_WAIT_SECONDS, Math.round(seconds));
}

/** Timestamp (ms) of when the tool call left pending, if the snapshot has it. */
export function getWaitCommandStartedAtMs(toolCall) {
  if (toolCall?.name !== 'wait_command') return null;
  const startedAtMs = Date.parse(toolCall.startedAt || '');
  return Number.isFinite(startedAtMs) ? startedAtMs : null;
}

/** Compact duration such as "45s", "5m", "2h 05m", "1d 3h". */
export function formatWaitDuration(totalSeconds) {
  const seconds = Math.max(1, Math.round(Number(totalSeconds) || 0));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}
