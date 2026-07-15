import assert from 'node:assert/strict';
import test from 'node:test';
import { __e2bInternals } from './e2b.js';

const {
  createSandboxLifecycle,
  isE2bNotFoundError,
  openPersistentSandbox,
  runUntilAbort,
} = __e2bInternals;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('abort releases a caller waiting for sandbox startup', async () => {
  const controller = new AbortController();
  let finishStartup;
  let commandStarted = false;
  const startup = new Promise((resolve) => { finishStartup = resolve; });

  const pending = runUntilAbort(async () => {
    await startup;
    if (controller.signal.aborted) return;
    commandStarted = true;
  }, controller.signal);

  controller.abort();
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  finishStartup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(commandStarted, false);
});

test('a signal aborted before invocation never starts work', async () => {
  const controller = new AbortController();
  controller.abort();
  let started = false;

  await assert.rejects(
    runUntilAbort(() => { started = true; }, controller.signal),
    (error) => error?.name === 'AbortError'
  );
  assert.equal(started, false);
});

test('an unaborted operation resolves normally', async () => {
  const controller = new AbortController();
  assert.equal(await runUntilAbort(async () => 42, controller.signal), 42);
});

test('only explicit E2B not-found failures are treated as missing entries', () => {
  assert.equal(isE2bNotFoundError({ status: 404 }), true);
  assert.equal(isE2bNotFoundError({ name: 'FileNotFound' }), true);
  assert.equal(isE2bNotFoundError({ status: 401, name: 'Unauthorized' }), false);
  assert.equal(isE2bNotFoundError(new TypeError('network failed')), false);
});

test('concurrent sandbox starts share one SDK startup', async () => {
  const opening = deferred();
  const sandbox = { sandboxId: 'shared' };
  let openCalls = 0;
  const lifecycle = createSandboxLifecycle({
    open() {
      openCalls += 1;
      return opening.promise;
    },
    close: async () => {},
  });

  const first = lifecycle.start();
  const second = lifecycle.start();
  assert.strictEqual(first, second);
  await Promise.resolve();
  assert.equal(openCalls, 1);

  opening.resolve(sandbox);
  assert.strictEqual(await first, sandbox);
  assert.deepEqual(lifecycle.getStatus(), {
    status: 'connected',
    sandboxId: 'shared',
    error: null,
  });
});

test('stop invalidates a pending startup without waiting for the SDK', async () => {
  const opening = deferred();
  const staleSandbox = { sandboxId: 'stale' };
  const closed = [];
  const lifecycle = createSandboxLifecycle({
    open: () => opening.promise,
    close: async (sandbox) => { closed.push(sandbox); },
  });

  const pending = lifecycle.start();
  await Promise.resolve();
  await lifecycle.stop();
  assert.deepEqual(lifecycle.getStatus(), {
    status: 'none',
    sandboxId: null,
    error: null,
  });

  opening.resolve(staleSandbox);
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  await lifecycle.drainCleanups();
  assert.deepEqual(closed, [staleSandbox]);
  assert.equal(lifecycle.getSandbox(), null);
});

test('a stale startup cannot overwrite a newer sandbox generation', async () => {
  const oldOpening = deferred();
  const newOpening = deferred();
  const openings = [oldOpening, newOpening];
  const closed = [];
  const lifecycle = createSandboxLifecycle({
    open: () => openings.shift().promise,
    close: async (sandbox) => { closed.push(sandbox.sandboxId); },
  });

  const oldStart = lifecycle.start();
  await Promise.resolve();
  await lifecycle.stop();
  const newStart = lifecycle.start();
  await Promise.resolve();

  const newSandbox = { sandboxId: 'new' };
  newOpening.resolve(newSandbox);
  assert.strictEqual(await newStart, newSandbox);

  oldOpening.resolve({ sandboxId: 'old' });
  await assert.rejects(oldStart, (error) => error?.name === 'AbortError');
  await lifecycle.drainCleanups();

  assert.strictEqual(lifecycle.getSandbox(), newSandbox);
  assert.deepEqual(closed, ['old']);
  assert.equal(lifecycle.getStatus().status, 'connected');
});

test('stale cleanup never kills a newer handle for the same remote sandbox', async () => {
  const oldOpening = deferred();
  const newOpening = deferred();
  const openings = [oldOpening, newOpening];
  const closed = [];
  const lifecycle = createSandboxLifecycle({
    open: () => openings.shift().promise,
    close: async (sandbox) => { closed.push(sandbox); },
  });

  const oldStart = lifecycle.start();
  await Promise.resolve();
  await lifecycle.stop();
  const newStart = lifecycle.start();
  await Promise.resolve();

  const newHandle = { sandboxId: 'persistent-id' };
  newOpening.resolve(newHandle);
  await newStart;
  oldOpening.resolve({ sandboxId: 'persistent-id' });
  await assert.rejects(oldStart, (error) => error?.name === 'AbortError');
  await lifecycle.drainCleanups();

  assert.strictEqual(lifecycle.getSandbox(), newHandle);
  assert.deepEqual(closed, []);
});

test('restart waits for an older connected sandbox to finish closing', async () => {
  const closeGate = deferred();
  const oldSandbox = { sandboxId: 'persistent-id' };
  const newSandbox = { sandboxId: 'persistent-id' };
  let openCalls = 0;
  const lifecycle = createSandboxLifecycle({
    open() {
      openCalls += 1;
      return openCalls === 1 ? oldSandbox : newSandbox;
    },
    close: () => closeGate.promise,
  });

  assert.strictEqual(await lifecycle.start(), oldSandbox);
  const stopping = lifecycle.stop();
  const restarting = lifecycle.start();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(openCalls, 1);

  closeGate.resolve();
  await stopping;
  assert.strictEqual(await restarting, newSandbox);
  assert.equal(openCalls, 2);
  assert.strictEqual(lifecycle.getSandbox(), newSandbox);
});

test('failed persistent sandbox lookup never falls through to create', async () => {
  let createCalls = 0;

  await assert.rejects(
    openPersistentSandbox({
      apiKey: 'test-key',
      metaId: 'browser-id',
      find: async () => { throw new Error('temporary list failure'); },
      connect: async () => { throw new Error('connect should not run'); },
      create: async () => {
        createCalls += 1;
        return { sandboxId: 'duplicate' };
      },
    }),
    /temporary list failure/
  );

  assert.equal(createCalls, 0);
});

test('a late startup failure after stop is observed without restoring error state', async () => {
  const opening = deferred();
  const lifecycle = createSandboxLifecycle({
    open: () => opening.promise,
    close: async () => {},
  });

  const pending = lifecycle.start();
  await Promise.resolve();
  await lifecycle.stop();
  opening.reject(new Error('late SDK failure'));

  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.deepEqual(lifecycle.getStatus(), {
    status: 'none',
    sandboxId: null,
    error: null,
  });
});
