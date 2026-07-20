export const MIN_WAKEUP_DELAY_SECONDS = 5;
export const MAX_WAKEUP_DELAY_SECONDS = 7 * 24 * 60 * 60;

const WAKEUP_DELAY_UNIT_SECONDS = Object.freeze({
  seconds: 1,
  minutes: 60,
  hours: 60 * 60,
  days: 24 * 60 * 60,
});

export function wakeupDelayToSeconds(delay, unit) {
  const value = Number(delay);
  const multiplier = WAKEUP_DELAY_UNIT_SECONDS[unit];

  if (!Number.isInteger(value) || value < 1) {
    throw new Error('delay must be a positive integer.');
  }
  if (!multiplier) {
    throw new Error('unit must be one of seconds, minutes, hours, or days.');
  }

  return value * multiplier;
}

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

export function createOrReplaceTurnWakeup({ currentWakeup, id, delaySeconds, prompt, now = Date.now() }) {
  const next = createWakeup({
    id: currentWakeup?.id || id,
    delaySeconds,
    prompt,
    now,
  });
  const requestedDelayMs = next.runAtMs - next.createdAtMs;
  const currentDelayMs = currentWakeup?.runAtMs - currentWakeup?.createdAtMs;

  if (currentWakeup?.prompt === next.prompt && currentDelayMs === requestedDelayMs) {
    return currentWakeup;
  }
  return next;
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
