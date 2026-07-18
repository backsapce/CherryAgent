export const MIN_WAKEUP_DELAY_SECONDS = 5;
export const MAX_WAKEUP_DELAY_SECONDS = 7 * 24 * 60 * 60;

export function createWakeup({ id, delaySeconds, prompt, now = Date.now() }) {
  const delay = Number(delaySeconds);
  const instruction = String(prompt || '').trim();

  if (!Number.isInteger(delay)) throw new Error('delay_seconds must be an integer.');
  if (delay < MIN_WAKEUP_DELAY_SECONDS || delay > MAX_WAKEUP_DELAY_SECONDS) {
    throw new Error(`delay_seconds must be between ${MIN_WAKEUP_DELAY_SECONDS} and ${MAX_WAKEUP_DELAY_SECONDS}.`);
  }
  if (!instruction) throw new Error('prompt is required.');

  return {
    id,
    prompt: instruction,
    createdAtMs: now,
    runAtMs: now + delay * 1000,
  };
}

export function findNextWakeup(sessions, claimedIds = new Set()) {
  let next = null;
  for (const session of sessions || []) {
    for (const wakeup of session?.wakeups || []) {
      if (!wakeup?.id || !Number.isFinite(wakeup.runAtMs) || claimedIds.has(wakeup.id)) continue;
      if (!next || wakeup.runAtMs < next.wakeup.runAtMs) next = { session, wakeup };
    }
  }
  return next;
}

export function buildWakeupMessage(wakeup) {
  return [
    'Scheduled wake-up fired. Continue the task using the conversation context.',
    `Instruction saved when scheduled: ${wakeup.prompt}`,
    'If the task is still not ready, inspect its current state and schedule another wake-up. Do not merely wait in this turn.',
  ].join('\n\n');
}
