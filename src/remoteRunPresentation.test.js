import assert from 'node:assert/strict';
import test from 'node:test';
import { canSupersedeRemoteRun, formatRunFailureContent } from './remoteRunPresentation.js';

test('run failures stay visible when the model already streamed partial text', () => {
  assert.equal(
    formatRunFailureContent('partial answer', new Error('provider disconnected')),
    'Error: provider disconnected\n\nPartial response:\n\npartial answer'
  );
});

test('run failure formatting is idempotent across terminal rediscovery', () => {
  const formatted = formatRunFailureContent('partial answer', 'provider disconnected');
  assert.equal(formatRunFailureContent(formatted, 'provider disconnected'), formatted);
  assert.equal(
    formatRunFailureContent('partial answer\n\nError: provider disconnected', 'provider disconnected'),
    formatted
  );
});

test('only non-running replaceable remote states are superseded by retry or a new turn', () => {
  for (const status of ['waiting', 'error', 'interrupted']) {
    assert.equal(canSupersedeRemoteRun({ status }), true);
  }
  for (const status of ['running', 'completed', 'aborted', undefined]) {
    assert.equal(canSupersedeRemoteRun({ status }), false);
  }
});
