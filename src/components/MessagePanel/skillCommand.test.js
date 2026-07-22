import test from 'node:test';
import assert from 'node:assert/strict';
import { getSkillCommandRange } from './skillCommand.js';

test('skill command opens for a slash at the start of the composer', () => {
  assert.deepEqual(getSkillCommandRange('/', 1), { start: 0, end: 1, query: '' });
  assert.deepEqual(getSkillCommandRange('/code-review', 12), {
    start: 0,
    end: 12,
    query: 'code-review',
  });
});

test('skill command closes after its argument separator', () => {
  assert.equal(getSkillCommandRange('/code-review inspect this', 25), null);
  assert.equal(getSkillCommandRange('please /code-review', 19), null);
  assert.equal(getSkillCommandRange('//code-review', 13), null);
});

