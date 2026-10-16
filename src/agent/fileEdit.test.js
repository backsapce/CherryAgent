import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFileEditResult } from './fileEdit.js';
import { parseUnifiedDiff } from './lineDiff.js';

test('buildFileEditResult describes a created file', () => {
  const result = JSON.parse(buildFileEditResult({
    source: 'browser',
    path: 'src/new.js',
    oldContent: null,
    newContent: 'line1\nline2\n',
  }));
  assert.equal(result.kind, 'file_edit');
  assert.equal(result.created, true);
  assert.equal(result.added, 2);
  assert.equal(result.removed, 0);
  assert.equal(result.old_lines, 0);
  assert.equal(result.new_lines, 2);
  assert.match(result.diff, /\+line1/);
  const rows = parseUnifiedDiff(result.diff);
  assert.ok(rows.every((row) => row.type !== 'del'));
});

test('buildFileEditResult reports edit counts', () => {
  const result = JSON.parse(buildFileEditResult({
    source: 'sandbox',
    path: 'app.py',
    oldContent: 'a\nb\nc\n',
    newContent: 'a\nB\nc\nd\n',
  }));
  assert.equal(result.created, false);
  assert.equal(result.added, 2);
  assert.equal(result.removed, 1);
  assert.equal(result.old_lines, 3);
  assert.equal(result.new_lines, 4);
});

test('buildFileEditResult caps the embedded diff', () => {
  const big = Array.from({ length: 2_000 }, (_, i) => `old-${i}`).join('\n');
  const rewritten = Array.from({ length: 2_000 }, (_, i) => `new-${i}`).join('\n') + '\nlast-changed\n';
  const result = JSON.parse(buildFileEditResult({
    source: 'browser',
    path: 'big.txt',
    oldContent: big,
    newContent: rewritten,
  }));
  assert.ok(result.diff.length < 10_000);
  assert.match(result.diff, /diff truncated: \d+ chars omitted from middle/);
  // The changed tail survives the middle cut.
  assert.ok(result.diff.includes('last-changed'));
});
