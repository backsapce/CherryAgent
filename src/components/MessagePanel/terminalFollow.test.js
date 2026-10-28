import test from 'node:test';
import assert from 'node:assert/strict';
import { isTerminalAtBottom } from './terminalFollow.js';

const terminalWith = ({ rows, viewportY, length }) => ({
  rows,
  buffer: { active: { viewportY, length } },
});

test('isTerminalAtBottom is true when the viewport shows the last rows', () => {
  assert.equal(isTerminalAtBottom(terminalWith({ rows: 10, viewportY: 90, length: 100 })), true);
  assert.equal(isTerminalAtBottom(terminalWith({ rows: 10, viewportY: 95, length: 100 })), true);
  // Short buffer (fewer lines than rows) is always at the bottom.
  assert.equal(isTerminalAtBottom(terminalWith({ rows: 24, viewportY: 0, length: 1 })), true);
});

test('isTerminalAtBottom is false once the user scrolled up', () => {
  assert.equal(isTerminalAtBottom(terminalWith({ rows: 10, viewportY: 40, length: 100 })), false);
  assert.equal(isTerminalAtBottom(terminalWith({ rows: 10, viewportY: 89, length: 100 })), false);
});

test('isTerminalAtBottom fails open for unreachable viewport state', () => {
  assert.equal(isTerminalAtBottom(null), true);
  assert.equal(isTerminalAtBottom({ rows: 0, buffer: { active: { viewportY: 0, length: 0 } } }), true);
  assert.equal(isTerminalAtBottom({ rows: 10 }), true);
  assert.equal(isTerminalAtBottom({ rows: 10, buffer: {} }), true);
  assert.equal(isTerminalAtBottom({
    rows: 10,
    get buffer() { throw new Error('disposed'); },
  }), true);
});
