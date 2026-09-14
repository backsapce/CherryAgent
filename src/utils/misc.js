/**
 * Small pure helpers shared by the browser UI, the agent loop, and the
 * Node agent server (which imports from src/). Keep this module free of
 * environment-specific imports; DOM access is allowed only inside
 * function bodies.
 */

/** Truncate to maxChars and mark how much was cut. */
export function truncateText(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

export function clampNumber(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
}

/** Human-readable byte size; `invalid` is returned for non-finite input. */
export function formatBytes(bytes, invalid = '') {
  if (!Number.isFinite(bytes)) return invalid;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const IMAGE_MIME_TYPES = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

/** Best-effort image MIME type from a file extension ('' when unknown). */
export function imageMimeFromPath(path) {
  const extension = String(path || '').split('.').pop()?.toLowerCase();
  return IMAGE_MIME_TYPES[extension] || '';
}

/** Split a POSIX-ish path (backslashes treated as separators) into parent + name. */
export function splitFilePath(path) {
  const parts = String(path || '').replace(/\\/g, '/').split('/').filter(Boolean);
  const name = parts.pop() || '';
  return { parent: parts.join('/'), name };
}

/** Race a promise against a timeout; true when it settled, false on timeout. */
export async function waitForSettlement(promise, timeoutMs) {
  let timerId;
  const settled = await Promise.race([
    Promise.resolve(promise).then(() => true, () => true),
    new Promise((resolve) => {
      timerId = setTimeout(() => resolve(false), Math.max(0, Number(timeoutMs) || 0));
    }),
  ]);
  clearTimeout(timerId);
  return settled;
}

/** Random id preferring crypto UUID with a sortable-ish fallback. */
export function randomId() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Trigger a browser download for a blob. */
export function downloadBlobFile(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
