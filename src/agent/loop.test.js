import assert from 'node:assert/strict';
import test from 'node:test';
import { compactToolResultForModel } from './toolObservation.js';

test('compactToolResultForModel leaves short tool results unchanged', () => {
  const result = 'Exit code: 0\nStdout:\nok';

  assert.equal(
    compactToolResultForModel({ name: 'execute_command' }, result, { contextWindow: 100_000 }),
    result
  );
});

test('compactToolResultForModel bounds long tool results and preserves head and tail', () => {
  const result = `Exit code: 1\nStdout:\nSTART\n${'x'.repeat(12_000)}\nStderr:\nEND_MARKER`;
  const compacted = compactToolResultForModel(
    { name: 'execute_command' },
    result,
    { contextWindow: 100_000 }
  );

  assert.ok(compacted.length <= 4_000);
  assert.match(compacted, /tool result compacted/);
  assert.match(compacted, /Tool: execute_command/);
  assert.match(compacted, /START/);
  assert.match(compacted, /END_MARKER/);
  assert.match(compacted, /omitted \d+ chars from middle/);
});
