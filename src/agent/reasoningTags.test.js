import assert from 'node:assert/strict';
import test from 'node:test';
import {
  consumeTaggedReasoning,
  createTaggedReasoningParser,
  splitTaggedReasoningContent,
} from './reasoningTags.js';

test('tagged reasoning parser handles tags split across chunks', () => {
  let parser = createTaggedReasoningParser();
  const emissions = [];
  for (const chunk of ['<think', 'ing>Inspect files.', '</think', 'ing>正常回答。']) {
    const result = consumeTaggedReasoning(parser, chunk);
    parser = result.parser;
    emissions.push(...result.emissions);
  }

  assert.deepEqual(emissions.map(({ type, text }) => ({ type, text })), [
    { type: 'reasoning', text: 'Inspect files.' },
    { type: 'text', text: '正常回答。' },
  ]);
  assert.equal(parser.sawClosingTag, true);
});

test('tagged reasoning parser supports repeated thinking sections before final text', () => {
  const parsed = splitTaggedReasoningContent([
    'First plan.\n',
    '</thinking>\n',
    '<thinking>\n',
    'Second plan.\n',
    '</thinking>\n\n',
    '最终回答。',
  ].join(''));

  assert.equal(parsed.thinking, 'First plan.\n\nSecond plan.\n');
  assert.equal(parsed.text, '\n\n\n最终回答。');
  assert.equal(parsed.closed, true);
});

test('native reasoning without tags remains reasoning', () => {
  const parsed = splitTaggedReasoningContent('Inspect the repository.');
  assert.deepEqual(parsed, {
    thinking: 'Inspect the repository.',
    text: '',
    closed: false,
  });
});
