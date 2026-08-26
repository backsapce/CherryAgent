export function hasScheduledWakeup(session) {
  return (Array.isArray(session?.wakeups) && session.wakeups.length > 0)
    || (session?.remoteRun?.status === 'waiting' && Boolean(session.remoteRun.wakeup));
}

export function getNextScheduledWakeup(session) {
  const wakeups = Array.isArray(session?.wakeups) ? session.wakeups : [];
  const remoteWakeup = session?.remoteRun?.status === 'waiting'
    ? session.remoteRun.wakeup
    : null;
  const candidates = remoteWakeup ? [...wakeups, remoteWakeup] : wakeups;

  return candidates.reduce((next, wakeup) => {
    if (!Number.isFinite(wakeup?.runAtMs)) return next;
    if (!next || wakeup.runAtMs < next.runAtMs) return wakeup;
    return next;
  }, null);
}

export function formatWakeupCountdown(runAtMs, nowMs = Date.now()) {
  if (!Number.isFinite(runAtMs) || !Number.isFinite(nowMs)) return '';

  const totalSeconds = Math.max(0, Math.ceil((runAtMs - nowMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value) => String(value).padStart(2, '0');

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}
