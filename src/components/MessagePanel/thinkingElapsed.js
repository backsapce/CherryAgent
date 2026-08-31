export function timestampOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function elapsedSeconds(startedAt, finishedAt) {
  const start = timestampOf(startedAt);
  const finish = timestampOf(finishedAt);
  if (start === null || finish === null) return null;
  return Math.max(0, Math.floor((finish - start) / 1000));
}

export function resolveThinkingElapsed({ startedAt, finishedAt, isThinking, nowMs }) {
  if (isThinking) return elapsedSeconds(startedAt, nowMs);
  return elapsedSeconds(startedAt, finishedAt);
}
