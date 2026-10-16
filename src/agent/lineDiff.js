/**
 * Line-level diff utilities shared by the write-file tools, the durable
 * sandbox runtime, and the chat/editor UIs.
 *
 * The core is a classic LCS diff over lines with common prefix/suffix
 * trimming, a size guard that degrades to a whole-region replace for huge
 * inputs, plus unified-diff formatting/parsing. Everything is dependency-free
 * so the same module runs in the browser, in Node, and inside persisted
 * session replay.
 */

const CONTEXT_LINES = 3;
// LCS DP is O(n*m); past this many cells the middle is treated as one
// wholesale replace instead of paying quadratic time and memory.
const MAX_LCS_CELLS = 2_000_000;

/**
 * Split text into lines without their terminators. A trailing terminator does
 * not produce a final empty line.
 */
export function splitLines(text) {
  const value = String(text ?? '');
  if (value === '') return [];
  const lines = value.split(/\r\n|\r|\n/);
  if (lines.length > 1 && (value.endsWith('\n') || value.endsWith('\r'))) lines.pop();
  return lines;
}

/**
 * Compute a line diff between two texts.
 *
 * @returns {{ rows: Array<{type: 'context'|'del'|'add', text: string, oldLine: number, newLine: number}>,
 *   added: number, removed: number, oldEndsNewline: boolean, newEndsNewline: boolean }}
 *   Rows are ordered; deletions for one hunk precede its additions. Every row
 *   carries both counters (they only advance on the side that consumes it),
 *   which is what unified hunk headers are derived from.
 */
export function computeLineDiff(oldText, newText) {
  const oldTextValue = String(oldText ?? '');
  const newTextValue = String(newText ?? '');
  const oldLines = splitLines(oldTextValue);
  const newLines = splitLines(newTextValue);

  // Trim the common prefix and suffix first: typical edits touch a small
  // middle region, so the quadratic LCS only ever sees that region.
  let start = 0;
  const maxStart = Math.min(oldLines.length, newLines.length);
  while (start < maxStart && oldLines[start] === newLines[start]) start += 1;
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }

  const middleOld = oldLines.slice(start, endOld);
  const middleNew = newLines.slice(start, endNew);
  const ops = middleOld.length * middleNew.length > MAX_LCS_CELLS
    ? replaceOps(middleOld, middleNew)
    : lcsOps(middleOld, middleNew);

  const rows = [];
  let oldLine = 1;
  let newLine = 1;
  let added = 0;
  let removed = 0;
  const pushRow = (type, text) => {
    rows.push({ type, text, oldLine, newLine });
    if (type !== 'add') oldLine += 1;
    if (type !== 'del') newLine += 1;
    if (type === 'add') added += 1;
    if (type === 'del') removed += 1;
  };
  for (let index = 0; index < start; index += 1) pushRow('context', oldLines[index]);
  for (const op of ops) {
    if (op.type === 'context') pushRow('context', middleOld[op.oldIndex]);
    else if (op.type === 'del') pushRow('del', middleOld[op.oldIndex]);
    else pushRow('add', middleNew[op.newIndex]);
  }
  for (let index = endOld; index < oldLines.length; index += 1) pushRow('context', oldLines[index]);

  return {
    rows,
    added,
    removed,
    oldEndsNewline: oldTextValue === '' || oldTextValue.endsWith('\n'),
    newEndsNewline: newTextValue === '' || newTextValue.endsWith('\n'),
  };
}

function replaceOps(oldLines, newLines) {
  const ops = oldLines.map((_, index) => ({ type: 'del', oldIndex: index }));
  for (let index = 0; index < newLines.length; index += 1) {
    ops.push({ type: 'add', newIndex: index });
  }
  return ops;
}

/**
 * LCS backtrack over a length table. `oldLines`/`newLines` are the middle
 * regions (prefix/suffix already removed).
 */
function lcsOps(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = oldLines[i] === newLines[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: 'context', oldIndex: i, newIndex: j });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ type: 'del', oldIndex: i });
      i += 1;
    } else {
      ops.push({ type: 'add', newIndex: j });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', oldIndex: i });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'add', newIndex: j });
    j += 1;
  }
  return ops;
}

/**
 * Render diff rows as a unified diff (with `---`/`+++` headers). Hunks use
 * `CONTEXT_LINES` of surrounding context and merge when their context ranges
 * overlap or touch. `\ No newline at end of file` markers are emitted after
 * the final old/new line when that side lacks a trailing newline.
 */
export function formatUnifiedDiff(rows, { oldPath = 'a', newPath = 'b', oldEndsNewline = true, newEndsNewline = true } = {}) {
  const changes = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].type !== 'context') changes.push(index);
  }
  if (!changes.length) return '';

  const hunks = [];
  let current = null;
  for (const changeIndex of changes) {
    const start = Math.max(0, changeIndex - CONTEXT_LINES);
    const end = Math.min(rows.length - 1, changeIndex + CONTEXT_LINES);
    if (current && start <= current.end + 1) {
      current.end = Math.max(current.end, end);
    } else {
      current = { start, end };
      hunks.push(current);
    }
  }

  const oldTotal = rows.reduce((max, row) => Math.max(max, row.oldLine || 0), 0);
  const newTotal = rows.reduce((max, row) => Math.max(max, row.newLine || 0), 0);

  const lines = [`--- ${oldPath}`, `+++ ${newPath}`];
  for (const hunk of hunks) {
    let oldCount = 0;
    let newCount = 0;
    for (let index = hunk.start; index <= hunk.end; index += 1) {
      const row = rows[index];
      if (row.type !== 'add') oldCount += 1;
      if (row.type !== 'del') newCount += 1;
    }
    const first = rows[hunk.start];
    lines.push(`@@ -${formatHunkRange(first.oldLine, oldCount)} +${formatHunkRange(first.newLine, newCount)} @@`);
    for (let index = hunk.start; index <= hunk.end; index += 1) {
      const row = rows[index];
      lines.push(`${row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}${row.text ?? ''}`);
      if (row.type !== 'add' && !oldEndsNewline && row.oldLine === oldTotal) {
        lines.push('\\ No newline at end of file');
      }
      if (row.type !== 'del' && !newEndsNewline && row.newLine === newTotal) {
        lines.push('\\ No newline at end of file');
      }
    }
  }
  return lines.join('\n');
}

// A zero-count side is anchored to the line *before* the hunk position.
function formatHunkRange(position, count) {
  if (count === 0) return `${Math.max(0, position - 1)},0`;
  return `${position},${count}`;
}

/**
 * Parse a unified diff back into renderable rows for the UI. Accepts the
 * output of `formatUnifiedDiff` and tolerates truncation markers that were
 * inserted into capped diffs.
 *
 * @returns {Array<{type: 'hunk'|'context'|'del'|'add'|'meta', text: string,
 *   oldLine?: number, newLine?: number, noNewline?: boolean}>}
 */
export function parseUnifiedDiff(diffText) {
  const lines = splitLines(diffText);
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of lines) {
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      oldLine = Number(line.match(/^@@ -(\d+)/)?.[1] || 1);
      newLine = Number(line.match(/ \+(\d+)/)?.[1] || 1);
      rows.push({ type: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff --git')) {
      rows.push({ type: 'meta', text: line });
      continue;
    }
    if (line.startsWith('+')) {
      rows.push({ type: 'add', text: line.slice(1), newLine });
      newLine += 1;
    } else if (line.startsWith('-')) {
      rows.push({ type: 'del', text: line.slice(1), oldLine });
      oldLine += 1;
    } else if (line.startsWith('\\')) {
      const previous = rows[rows.length - 1];
      if (previous && (previous.type === 'add' || previous.type === 'del' || previous.type === 'context')) {
        previous.noNewline = true;
      }
    } else if (line.startsWith(' ')) {
      rows.push({ type: 'context', text: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    } else {
      rows.push({ type: 'meta', text: line });
    }
  }
  return rows;
}
