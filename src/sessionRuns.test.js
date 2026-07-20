import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRunRegistry } from './sessionRuns.js';

test('session runs start, abort, and finish independently', async () => {
  const snapshots = [];
  const registry = createSessionRunRegistry({
    onChange: (ids) => snapshots.push([...ids].sort()),
  });

  const first = registry.begin('session-a', { streamingContent: '' });
  const second = registry.begin('session-b', { streamingContent: '' });

  assert.ok(first);
  assert.ok(second);
  assert.notStrictEqual(first.controller, second.controller);
  assert.equal(registry.begin('session-a'), null);

  const firstCompletion = registry.abort('session-a');
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(second.controller.signal.aborted, false);
  assert.equal(registry.has('session-b'), true);

  assert.equal(registry.finish('session-a', first), true);
  await firstCompletion;
  assert.deepEqual([...registry.runningSessionIds()], ['session-b']);
  assert.equal(registry.finish('session-b', second), true);
  assert.deepEqual(snapshots, [
    ['session-a'],
    ['session-a', 'session-b'],
    ['session-b'],
    [],
  ]);
});

test('a stale completion cannot clear a newer run for the same session', () => {
  const registry = createSessionRunRegistry();
  const first = registry.begin('session-a');
  assert.equal(registry.finish('session-a', first), true);

  const second = registry.begin('session-a');
  assert.equal(registry.finish('session-a', first), false);
  assert.strictEqual(registry.get('session-a'), second);
  assert.equal(registry.finish('session-a', second), true);
});

test('abortAll signals every active session and returns every completion', async () => {
  const registry = createSessionRunRegistry();
  const first = registry.begin('session-a');
  const second = registry.begin('session-b');

  const completions = registry.abortAll();
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(second.controller.signal.aborted, true);
  assert.equal(completions.length, 2);

  registry.finish('session-a', first);
  registry.finish('session-b', second);
  await Promise.all(completions);
});
