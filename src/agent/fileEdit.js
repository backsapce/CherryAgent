/**
 * Structured edit results for the write-file tools.
 *
 * A write tool returns a JSON payload (same pattern as image references):
 * the chat UI parses it into a diff card, while the model reads the same
 * object as a compact confirmation with the applied change summary.
 */

import { computeLineDiff, formatUnifiedDiff, splitLines } from './lineDiff.js';
import { truncateMiddle } from './toolObservation.js';

// Keeps a single persisted tool result bounded even when a rewrite touches a
// huge region; the middle of the diff is cut with an explicit marker row.
const FILE_EDIT_DIFF_MAX_CHARS = 8_000;

/**
 * Build the JSON tool result for one completed file write.
 *
 * @param {{source: 'browser'|'sandbox', path: string,
 *   oldContent: string|null, newContent: string}} edit
 *   `oldContent` is null when the file did not exist before the write.
 */
export function buildFileEditResult({ source, path, oldContent, newContent }) {
  const oldText = oldContent == null ? '' : String(oldContent);
  const newText = String(newContent ?? '');
  const created = oldContent == null;
  const diff = computeLineDiff(oldText, newText);
  const diffText = (diff.added || diff.removed)
    ? formatUnifiedDiff(diff.rows, {
      oldPath: path,
      newPath: path,
      oldEndsNewline: diff.oldEndsNewline,
      newEndsNewline: diff.newEndsNewline,
    })
    : '';
  return JSON.stringify({
    kind: 'file_edit',
    source,
    path,
    created,
    added: diff.added,
    removed: diff.removed,
    old_lines: splitLines(oldText).length,
    new_lines: splitLines(newText).length,
    ...(diffText ? { diff: truncateMiddle(diffText, FILE_EDIT_DIFF_MAX_CHARS, 'diff truncated') } : {}),
  });
}
