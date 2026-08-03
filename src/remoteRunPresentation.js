const SUPERSEDABLE_REMOTE_RUN_STATUSES = new Set(['waiting', 'error', 'interrupted']);

export function canSupersedeRemoteRun(remoteRun) {
  return SUPERSEDABLE_REMOTE_RUN_STATUSES.has(remoteRun?.status);
}

export function formatRunFailureContent(partialContent, error) {
  const rawDetail = String(error?.message || error || 'Unknown sandbox run error').trim();
  const detail = rawDetail.replace(/^Error:\s*/i, '') || 'Unknown sandbox run error';
  const errorLine = `Error: ${detail}`;
  let partial = String(partialContent || '').trim();

  if (!partial || partial === errorLine) return errorLine;
  if (partial.startsWith(`${errorLine}\n`)) return partial;

  // Normalize the older "partial then error" layout so rediscovery remains
  // idempotent and the Error prefix (and Retry button) stays visible.
  const legacySuffix = `\n\n${errorLine}`;
  if (partial.endsWith(legacySuffix)) partial = partial.slice(0, -legacySuffix.length).trim();
  if (!partial) return errorLine;

  return `${errorLine}\n\nPartial response:\n\n${partial}`;
}
