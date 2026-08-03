import assert from 'node:assert/strict';
import test from 'node:test';
import { hasRenderableTranscript } from './transcriptVisibility.js';

test('an empty text-start segment does not hide fallback content or errors', () => {
  const transcript = [{ id: 'text:one', type: 'text', content: '', status: 'streaming' }];
  assert.equal(hasRenderableTranscript(transcript, [], true), false);
  assert.equal(hasRenderableTranscript(transcript, [], false), false);
});

test('visible text, tools, and active reasoning remain transcript-rendered', () => {
  assert.equal(hasRenderableTranscript([
    { id: 'text:one', type: 'text', content: 'answer', status: 'finished' },
  ], [], false), true);
  assert.equal(hasRenderableTranscript([
    { id: 'tool:one', type: 'tool', toolCallId: 'call-one', content: '' },
  ], [{ id: 'call-one' }], false), true);
  assert.equal(hasRenderableTranscript([
    { id: 'reasoning:one', type: 'reasoning', content: '', status: 'streaming' },
  ], [], true), true);
});
