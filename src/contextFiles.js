/**
 * Older CherryAgent versions appended a plain-text file summary to the user's
 * message. File metadata now renders as attachment cards, so remove that
 * generated suffix when the structured contextFiles data is available.
 */
export function stripLegacyContextFileSummary(content, contextFiles) {
  const value = String(content || '');
  if (!contextFiles?.length) return value;

  const marker = 'Referenced files:';
  const markerIndex = value.lastIndexOf(marker);
  if (markerIndex < 0) return value;
  if (markerIndex > 0 && value.slice(Math.max(0, markerIndex - 2), markerIndex) !== '\n\n') return value;

  const lines = value.slice(markerIndex).trim().split('\n');
  if (!/^Referenced files:\s+\d+\s+\(~[\d,]+\s+tokens\)$/.test(lines[0])) return value;
  if (lines.length < 2 || lines.slice(1).some((line) => !/^- \[(workspace|sandbox)\] .+/.test(line))) return value;

  return value.slice(0, markerIndex).trimEnd();
}

export const SANDBOX_CONTEXT_FILE_MAX_CHARS = 120_000;
export const SANDBOX_CONTEXT_FILES_TOTAL_MAX_CHARS = 300_000;

/**
 * Clone and bound context-file content before it is serialized to a sandbox
 * run. Newer messages receive the shared budget first; the stored session and
 * attachment cards keep their original content.
 */
export function boundContextFilesForPrompt(messages, options = {}) {
  const perFileLimit = positiveLimit(
    options.perFileChars,
    SANDBOX_CONTEXT_FILE_MAX_CHARS
  );
  let remaining = positiveLimit(
    options.totalChars,
    SANDBOX_CONTEXT_FILES_TOTAL_MAX_CHARS
  );
  const bounded = (messages || []).map((message) => (
    message?.contextFiles?.length
      ? {
        ...message,
        contextFiles: message.contextFiles.map((file) => ({ ...file })),
      }
      : message
  ));

  for (let messageIndex = bounded.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const files = bounded[messageIndex]?.contextFiles || [];
    for (const file of files) {
      const content = String(file?.content || '');
      const limit = Math.min(perFileLimit, remaining);
      file.content = truncateContextContent(content, limit);
      remaining -= file.content.length;
    }
  }

  return bounded;
}

function positiveLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function truncateContextContent(content, maxChars) {
  if (content.length <= maxChars) return content;
  if (maxChars <= 0) return '';
  const marker = '\n[context file truncated]\n';
  if (maxChars <= marker.length) return content.slice(0, maxChars);
  return `${content.slice(0, maxChars - marker.length)}${marker}`;
}
