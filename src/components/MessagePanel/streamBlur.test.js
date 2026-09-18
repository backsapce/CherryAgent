import assert from 'node:assert/strict';
import test from 'node:test';
import { rehypeStreamWords, splitStreamTokens, STREAM_BLUR_WORD_CLASS } from './streamBlur.js';

function reassembled(pieces) {
  return pieces.map((piece) => piece.value).join('');
}

test('splitStreamTokens round-trips text losslessly', () => {
  for (const value of [
    'Hello world, this streams!',
    '中英文混排 blur 效果测试。',
    '  leading,  inner   and trailing spaces \n\t',
    '!@#$%^&*()_+',
    '',
  ]) {
    assert.equal(reassembled(splitStreamTokens(value)), value);
  }
  assert.deepEqual(splitStreamTokens(null), []);
});

test('latin words stay whole while CJK chars split individually', () => {
  assert.deepEqual(splitStreamTokens('hi there'), [
    { type: 'word', value: 'hi' },
    { type: 'space', value: ' ' },
    { type: 'word', value: 'there' },
  ]);
  assert.deepEqual(splitStreamTokens('你好'), [
    { type: 'word', value: '你' },
    { type: 'word', value: '好' },
  ]);
  assert.deepEqual(splitStreamTokens('use用例x'), [
    { type: 'word', value: 'use' },
    { type: 'word', value: '用' },
    { type: 'word', value: '例' },
    { type: 'word', value: 'x' },
  ]);
});

test('appending a token keeps earlier tokens identical', () => {
  const before = splitStreamTokens('one two');
  const after = splitStreamTokens('one two three');
  assert.deepEqual(after.slice(0, before.length), before);
});

function runPlugin(tree) {
  rehypeStreamWords()(tree);
  return tree;
}

test('rehypeStreamWords wraps words but leaves whitespace text nodes bare', () => {
  const tree = runPlugin({
    type: 'root',
    children: [{ type: 'element', tagName: 'p', properties: {}, children: [
      { type: 'text', value: 'hello ' },
      { type: 'element', tagName: 'strong', properties: {}, children: [
        { type: 'text', value: 'big' },
      ] },
      { type: 'text', value: ' world' },
    ] }],
  });
  const paragraph = tree.children[0];
  assert.deepEqual(paragraph.children, [
    { type: 'element', tagName: 'span', properties: { className: [STREAM_BLUR_WORD_CLASS] }, children: [{ type: 'text', value: 'hello' }] },
    { type: 'text', value: ' ' },
    { type: 'element', tagName: 'strong', properties: {}, children: [
      { type: 'element', tagName: 'span', properties: { className: [STREAM_BLUR_WORD_CLASS] }, children: [{ type: 'text', value: 'big' }] },
    ] },
    { type: 'text', value: ' ' },
    { type: 'element', tagName: 'span', properties: { className: [STREAM_BLUR_WORD_CLASS] }, children: [{ type: 'text', value: 'world' }] },
  ]);
});

test('rehypeStreamWords leaves pure-whitespace and non-element nodes untouched', () => {
  const tree = runPlugin({
    type: 'root',
    children: [
      { type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: '  \n ' }] },
      { type: 'element', tagName: 'br', properties: {} },
    ],
  });
  assert.deepEqual(tree.children[0].children, [{ type: 'text', value: '  \n ' }]);
  assert.deepEqual(tree.children[1], { type: 'element', tagName: 'br', properties: {} });
});

test('wrapped tree preserves the full text content', () => {
  const value = '答案 answer 42';
  const tree = runPlugin({
    type: 'root',
    children: [{ type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value }] }],
  });
  const text = (node) => node.type === 'text'
    ? node.value
    : node.children.map(text).join('');
  assert.equal(text(tree.children[0]), value);
});
