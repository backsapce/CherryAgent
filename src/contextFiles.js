/**
 * Older VertexAgent versions appended a plain-text file summary to the user's
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

