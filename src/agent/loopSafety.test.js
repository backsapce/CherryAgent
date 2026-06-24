import assert from 'node:assert/strict';
import test from 'node:test';
import { DOOM_LOOP_THRESHOLD, createToolLoopGuard, stableToolInput } from './loopSafety.js';

test('stableToolInput treats equivalent object key order as the same input', () => {
  assert.equal(
    stableToolInput({ command: 'rg', options: { hidden: true, glob: '*.js' } }),
    stableToolInput({ options: { glob: '*.js', hidden: true }, command: 'rg' })
  );
});

test('tool loop guard flags the third consecutive identical tool call', () => {
  const guard = createToolLoopGuard();

  assert.equal(guard.check({ toolName: 'execute_command', input: { command: 'pwd' } }).repeated, false);
  assert.equal(guard.check({ toolName: 'execute_command', input: { command: 'pwd' } }).repeated, false);
  const third = guard.check({ toolName: 'execute_command', input: { command: 'pwd' } });

  assert.equal(third.repeated, true);
  assert.equal(third.threshold, DOOM_LOOP_THRESHOLD);
  assert.equal(third.occurrences, DOOM_LOOP_THRESHOLD);
});

test('tool loop guard resets the consecutive sequence when tool or input changes', () => {
  const guard = createToolLoopGuard();

  guard.check({ toolName: 'execute_command', input: { command: 'pwd' } });
  guard.check({ toolName: 'execute_command', input: { command: 'pwd' } });
  assert.equal(guard.check({ toolName: 'execute_command', input: { command: 'ls' } }).repeated, false);
  assert.equal(guard.check({ toolName: 'read_browser_file', input: { path: 'a.txt' } }).repeated, false);
  assert.equal(guard.check({ toolName: 'execute_command', input: { command: 'pwd' } }).repeated, false);
});
