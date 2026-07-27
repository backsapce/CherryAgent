import assert from 'node:assert/strict';
import test from 'node:test';
import { stripLegacyContextFileSummary } from './contextFiles.js';

test('removes a generated legacy file summary when structured files exist', () => {
  const content = [
    'Please review this.',
    '',
    'Referenced files: 1 (~120 tokens)',
    '- [sandbox] contract.pdf (2.8 MB, ~120 tokens)',
  ].join('\n');

  assert.equal(
    stripLegacyContextFileSummary(content, [{ relativePath: 'contract.pdf' }]),
    'Please review this.'
  );
});

test('removes an attachment-only legacy summary', () => {
  const content = [
    'Referenced files: 1 (~120 tokens)',
    '- [workspace] notes.txt (480 B, ~120 tokens)',
  ].join('\n');

  assert.equal(
    stripLegacyContextFileSummary(content, [{ relativePath: 'notes.txt' }]),
    ''
  );
});

test('preserves user-authored text and messages without structured files', () => {
  const content = 'Referenced files: see the appendix';
  assert.equal(stripLegacyContextFileSummary(content, [{ relativePath: 'notes.txt' }]), content);
  assert.equal(stripLegacyContextFileSummary('hello', []), 'hello');
});

