import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundContextFilesForPrompt,
  stripLegacyContextFileSummary,
} from './contextFiles.js';

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

test('bounds sandbox context files while prioritizing the newest message', () => {
  const messages = [
    {
      role: 'user',
      content: 'old',
      contextFiles: [{ relativePath: 'old.txt', content: 'o'.repeat(100) }],
    },
    {
      role: 'user',
      content: 'new',
      contextFiles: [
        { relativePath: 'new-a.txt', content: 'a'.repeat(80) },
        { relativePath: 'new-b.txt', content: 'b'.repeat(80) },
      ],
    },
  ];

  const bounded = boundContextFilesForPrompt(messages, {
    perFileChars: 70,
    totalChars: 120,
  });

  assert.equal(bounded[1].contextFiles[0].content.length, 70);
  assert.equal(bounded[1].contextFiles[1].content.length, 50);
  assert.equal(bounded[0].contextFiles[0].content, '');
  assert.equal(
    bounded.flatMap((message) => message.contextFiles).reduce(
      (total, file) => total + file.content.length,
      0
    ),
    120
  );
  assert.equal(messages[1].contextFiles[0].content.length, 80);
});
