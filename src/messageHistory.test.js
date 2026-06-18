import assert from 'node:assert/strict';
import test from 'node:test';
import { editUserMessageAndDiscardFollowing } from './messageHistory.js';

function buildConversation(turns) {
  return Array.from({ length: turns }, (_, index) => {
    const turn = index + 1;
    return [
      { id: `q${turn}`, role: 'user', content: `question ${turn}` },
      { id: `a${turn}`, role: 'assistant', content: `answer ${turn}` },
    ];
  }).flat();
}

test('editing an earlier user message discards following questions and answers', () => {
  const messages = buildConversation(10);
  const result = editUserMessageAndDiscardFollowing(messages, 'q3', 'edited question 3');

  assert.equal(result.messageIndex, 4);
  assert.deepEqual(
    result.messages.map((message) => message.id),
    ['q1', 'a1', 'q2', 'a2', 'q3']
  );
  assert.equal(result.messages.at(-1).content, 'edited question 3');
});

test('editing keeps the original user message metadata', () => {
  const messages = [
    { id: 'q1', role: 'user', content: 'old text', images: [{ name: 'photo.png' }], contextFiles: [{ relativePath: 'note.md' }] },
    { id: 'a1', role: 'assistant', content: 'answer' },
  ];

  const result = editUserMessageAndDiscardFollowing(messages, 'q1', 'new text');

  assert.deepEqual(result.messages, [
    { id: 'q1', role: 'user', content: 'new text', images: [{ name: 'photo.png' }], contextFiles: [{ relativePath: 'note.md' }] },
  ]);
});

test('only user messages can be edited into a new branch', () => {
  const messages = buildConversation(2);

  assert.equal(editUserMessageAndDiscardFollowing(messages, 'a1', 'edited answer'), null);
  assert.equal(editUserMessageAndDiscardFollowing(messages, 'missing', 'edited'), null);
});
