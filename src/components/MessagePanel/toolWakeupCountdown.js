export function getScheduleWakeupRunAtMs(toolCall) {
  if (toolCall?.name !== 'schedule_wakeup') return null;

  let result = toolCall.result;
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch {
      return null;
    }
  }

  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  if (result.scheduled !== true || typeof result.run_at !== 'string') return null;

  const runAtMs = Date.parse(result.run_at);
  return Number.isFinite(runAtMs) ? runAtMs : null;
}
