import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeLineDiff,
  formatUnifiedDiff,
  parseUnifiedDiff,
  splitLines,
} from './lineDiff.js';

test('splitLines handles terminators and trailing newline', () => {
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\r\nb'), ['a', 'b']);
  assert.deepEqual(splitLines('\n'), ['']);
});

test('computeLineDiff counts additions and removals', () => {
  const diff = computeLineDiff('a\nb\nc\n', 'a\nx\nc\n');
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  const del = diff.rows.find((row) => row.type === 'del');
  const add = diff.rows.find((row) => row.type === 'add');
  assert.equal(del.text, 'b');
  assert.equal(del.oldLine, 2);
  assert.equal(add.text, 'x');
  assert.equal(add.newLine, 2);
});

test('computeLineDiff reports empty diff for identical texts', () => {
  const diff = computeLineDiff('same\nlines\n', 'same\nlines\n');
  assert.equal(diff.added, 0);
  assert.equal(diff.removed, 0);
  assert.deepEqual(diff.rows.map((row) => row.type), ['context', 'context']);
});

test('computeLineDiff handles new and emptied files', () => {
  const created = computeLineDiff(null, 'one\ntwo\n');
  assert.equal(created.added, 2);
  assert.equal(created.removed, 0);
  const emptied = computeLineDiff('one\ntwo\n', '');
  assert.equal(emptied.added, 0);
  assert.equal(emptied.removed, 2);
});

test('computeLineDiff keeps hunk ordering: deletions before additions', () => {
  const diff = computeLineDiff('a\nb\n', 'x\nb\n');
  const changeTypes = diff.rows.filter((row) => row.type !== 'context').map((row) => row.type);
  assert.deepEqual(changeTypes, ['del', 'add']);
});

test('formatUnifiedDiff emits standard hunks with context', () => {
  const oldText = ['keep1', 'keep2', 'old1', 'old2', 'keep3', 'keep4', 'keep5', 'keep6'].join('\n') + '\n';
  const newText = ['keep1', 'keep2', 'new1', 'keep3', 'keep4', 'keep5', 'keep6'].join('\n') + '\n';
  const diff = computeLineDiff(oldText, newText);
  const text = formatUnifiedDiff(diff.rows, {
    oldPath: 'file.js',
    newPath: 'file.js',
    oldEndsNewline: diff.oldEndsNewline,
    newEndsNewline: diff.newEndsNewline,
  });
  assert.match(text, /^--- file\.js\n\+\+\+ file\.js\n@@ -1,7 \+1,6 @@/);
  assert.ok(text.includes('-old1'));
  assert.ok(text.includes('-old2'));
  assert.ok(text.includes('+new1'));
  assert.ok(text.includes(' keep2'));
  // No context row outside the 3-line window around the change.
  assert.ok(!text.includes('keep6'));
});

test('formatUnifiedDiff marks missing trailing newline', () => {
  const diff = computeLineDiff('a\nb', 'a\nb\nc');
  const text = formatUnifiedDiff(diff.rows, {
    oldEndsNewline: diff.oldEndsNewline,
    newEndsNewline: diff.newEndsNewline,
  });
  assert.ok(text.includes('\\ No newline at end of file'));
});

test('parseUnifiedDiff round-trips row types and line numbers', () => {
  const diff = computeLineDiff('a\nb\nc\nd\n', 'a\nB\nc\nd\nE\n');
  const text = formatUnifiedDiff(diff.rows, {
    oldEndsNewline: diff.oldEndsNewline,
    newEndsNewline: diff.newEndsNewline,
  });
  const rows = parseUnifiedDiff(text);
  assert.equal(rows[0].type, 'meta');
  assert.equal(rows[1].type, 'meta');
  assert.equal(rows[2].type, 'hunk');
  const add = rows.find((row) => row.type === 'add' && row.text === 'B');
  assert.equal(add.newLine, 2);
  const del = rows.find((row) => row.type === 'del');
  assert.equal(del.text, 'b');
  assert.equal(del.oldLine, 2);
  const tail = rows.find((row) => row.type === 'add' && row.text === 'E');
  assert.equal(tail.newLine, 5);
});

test('parseUnifiedDiff tolerates truncation markers', () => {
  const text = [
    '--- a',
    '+++ b',
    '@@ -1,2 +1,2 @@',
    ' ctx',
    '-old',
    '[diff truncated: 10 chars omitted from middle]',
    '+new',
  ].join('\n');
  const rows = parseUnifiedDiff(text);
  assert.deepEqual(
    rows.map((row) => row.type),
    ['meta', 'meta', 'hunk', 'context', 'del', 'meta', 'add']
  );
});

test('large middles degrade to a replace instead of quadratic LCS', () => {
  const oldMiddle = Array.from({ length: 5_000 }, (_, i) => `old-${i}`);
  const newMiddle = Array.from({ length: 5_000 }, (_, i) => `new-${i}`);
  const diff = computeLineDiff(
    ['header'].concat(oldMiddle, ['footer']).join('\n'),
    ['header'].concat(newMiddle, ['footer']).join('\n')
  );
  assert.equal(diff.added, 5_000);
  assert.equal(diff.removed, 5_000);
  assert.equal(diff.rows[0].type, 'context');
  assert.equal(diff.rows[diff.rows.length - 1].type, 'context');
});
