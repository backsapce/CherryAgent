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

test('a terminal state update queued by the current run survives later cleanup', () => {
  const registry = createSessionRunRegistry();
  const run = registry.begin('session-a');
  const queued = [];
  let state = { remoteStatus: 'running', toolStatus: 'running' };

  assert.equal(registry.enqueueIfCurrent('session-a', run, () => {
    queued.push((current) => ({
      ...current,
      remoteStatus: 'waiting',
      toolStatus: 'completed',
    }));
  }), true);
  assert.equal(registry.finish('session-a', run), true);

  // React functional updaters can run after finish() because state updates are
  // batched. Ownership was established at enqueue time, so the terminal state
  // must still be applied.
  for (const update of queued) state = update(state);
  assert.deepEqual(state, { remoteStatus: 'waiting', toolStatus: 'completed' });

  const replacement = registry.begin('session-a');
  assert.equal(registry.enqueueIfCurrent('session-a', run, () => queued.push(() => state)), false);
  assert.equal(registry.finish('session-a', replacement), true);
});

test('a replacement run update remains newer than an already queued terminal update', () => {
  const registry = createSessionRunRegistry();
  const queued = [];
  let state = { remoteStatus: 'running-old' };
  const first = registry.begin('session-a');

  registry.enqueueIfCurrent('session-a', first, () => {
    queued.push((current) => ({ ...current, remoteStatus: 'waiting-old' }));
  });
  registry.finish('session-a', first);

  const replacement = registry.begin('session-a');
  registry.enqueueIfCurrent('session-a', replacement, () => {
    queued.push((current) => ({ ...current, remoteStatus: 'running-new' }));
  });

  for (const update of queued) state = update(state);
  assert.equal(state.remoteStatus, 'running-new');
  registry.finish('session-a', replacement);
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
