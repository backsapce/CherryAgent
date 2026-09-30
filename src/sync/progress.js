// Presentation helpers for the sync run progress reported by getSyncStatus().
// Kept out of syncManager.js so the engine stays free of i18n concerns.

const PHASE_LABEL_KEYS = {
  connect: 'syncSettings.progressConnecting',
  scan: 'syncSettings.progressScanning',
  pull: 'syncSettings.progressPulling',
  push: 'syncSettings.progressPushing',
  commit: 'syncSettings.progressCommitting',
};

/** Percent (0-100), preferring transferred bytes; null when indeterminate. */
export function syncProgressPercent(progress) {
  if (!progress) return null;
  const totalBytes = Number(progress.totalBytes) || 0;
  if (totalBytes > 0) {
    const doneBytes = Number(progress.doneBytes) || 0;
    return Math.max(0, Math.min(100, Math.floor((doneBytes / totalBytes) * 100)));
  }
  const total = Number(progress.total) || 0;
  if (total > 0) {
    const done = Number(progress.done) || 0;
    return Math.max(0, Math.min(100, Math.floor((done / total) * 100)));
  }
  return null;
}

/** Short status text, e.g. "Pulling 45%" or "Committing manifest". */
export function syncProgressLabel(progress, t) {
  if (!progress) return '';
  const phaseLabel = t(PHASE_LABEL_KEYS[progress.phase] || 'syncSettings.working');
  const percent = syncProgressPercent(progress);
  return percent == null ? phaseLabel : `${phaseLabel} ${percent}%`;
}

/** Longer tooltip text with item counts, e.g. "Pulling 45% (12/48)". */
export function syncProgressDetail(progress, t) {
  if (!progress) return '';
  const label = syncProgressLabel(progress, t);
  const total = Number(progress.total) || 0;
  if (total <= 0) return label;
  const done = Math.min(Number(progress.done) || 0, total);
  return `${label} (${t('syncSettings.progressCount', { done, total })})`;
}
