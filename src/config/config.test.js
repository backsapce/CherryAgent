import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfigDocument } from './config.js';

let freshModuleId = 0;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function notFoundError(message = 'File not found') {
  const error = new Error(message);
  error.name = 'NotFoundError';
  return error;
}

class MemoryConfigDirectory {
  constructor(text = null) {
    this.text = text;
    this.writeCount = 0;
    this.activeWritables = 0;
    this.maxActiveWritables = 0;
    this.nextReadControl = null;
    this.nextCloseControl = null;
    this.nextCloseError = null;
    this.nextRemoveError = null;
  }

  pauseNextRead() {
    const started = deferred();
    const release = deferred();
    this.nextReadControl = { started, release };
    return { started: started.promise, release: release.resolve };
  }

  pauseNextClose() {
    const started = deferred();
    const release = deferred();
    this.nextCloseControl = { started, release };
    return { started: started.promise, release: release.resolve };
  }

  async getFileHandle(filename, options = {}) {
    assert.equal(filename, 'config.yaml');
    if (this.text == null && !options.create) throw notFoundError();
    return {
      getFile: async () => {
        const snapshot = this.text ?? '';
        const control = this.nextReadControl;
        this.nextReadControl = null;
        return {
          text: async () => {
            if (control) {
              control.started.resolve();
              await control.release.promise;
            }
            return snapshot;
          },
        };
      },
      createWritable: async () => {
        this.writeCount += 1;
        this.activeWritables += 1;
        this.maxActiveWritables = Math.max(this.maxActiveWritables, this.activeWritables);
        const control = this.nextCloseControl;
        const closeError = this.nextCloseError;
        this.nextCloseControl = null;
        this.nextCloseError = null;
        let staged = '';
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          this.activeWritables -= 1;
        };
        return {
          write: async (value) => { staged = String(value); },
          close: async () => {
            if (control) {
              control.started.resolve();
              await control.release.promise;
            }
            if (closeError) {
              finish();
              throw closeError;
            }
            this.text = staged;
            finish();
          },
          abort: async () => { finish(); },
        };
      },
    };
  }

  async removeEntry(filename) {
    assert.equal(filename, 'config.yaml');
    if (this.nextRemoveError) {
      const error = this.nextRemoveError;
      this.nextRemoveError = null;
      throw error;
    }
    if (this.text == null) throw notFoundError();
    this.text = null;
  }
}

async function freshConfig(directory) {
  const origin = {
    getDirectoryHandle: async (name) => {
      assert.equal(name, 'vertex-agent');
      return directory;
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: async () => origin } },
  });
  freshModuleId += 1;
  return (await import(`./config.js?config-test=${freshModuleId}`)).default;
}

test('config parser accepts an empty document and YAML mappings', () => {
  assert.deepEqual(parseConfigDocument(null), {});
  assert.deepEqual(parseConfigDocument('  \n'), {});
  assert.deepEqual(parseConfigDocument('theme: dark\nsync:\n  enabled: true\n'), {
    theme: 'dark',
    sync: { enabled: true },
  });
});

test('config parser fails closed on malformed or non-mapping YAML', () => {
  for (const input of [
    'sync: [unterminated',
    'null\n',
    'false\n',
    '- first\n- second\n',
    'plain scalar\n',
  ]) {
    assert.throws(() => parseConfigDocument(input), /config\.yaml/i);
  }
});

test('init and set are serialized so a late read cannot replace a newer write', async () => {
  const directory = new MemoryConfigDirectory('theme: light\nuntouched: keep\n');
  const config = await freshConfig(directory);
  const read = directory.pauseNextRead();

  const initializing = config.init();
  await read.started;
  const setting = config.set('theme', 'dark');
  await Promise.resolve();

  assert.equal(directory.writeCount, 0, 'set must wait for the earlier init read');
  read.release();
  await Promise.all([initializing, setting]);

  assert.deepEqual(config.get(), { theme: 'dark', untouched: 'keep' });
  assert.deepEqual(parseConfigDocument(directory.text), { theme: 'dark', untouched: 'keep' });
});

test('concurrent mutations use one writable at a time and build on committed state', async () => {
  const directory = new MemoryConfigDirectory('base: true\n');
  const config = await freshConfig(directory);
  await config.init();
  const close = directory.pauseNextClose();

  const first = config.set('first', 1);
  await close.started;
  const second = config.merge('nested', { second: 2 });
  await Promise.resolve();

  assert.equal(directory.writeCount, 1, 'the second mutation must not open a competing stream');
  assert.equal(config.get('first'), undefined, 'memory changes only after persistence succeeds');
  close.release();
  await Promise.all([first, second]);

  const expected = { base: true, first: 1, nested: { second: 2 } };
  assert.deepEqual(config.get(), expected);
  assert.deepEqual(parseConfigDocument(directory.text), expected);
  assert.equal(directory.maxActiveWritables, 1);
});

test('failed persistence leaves memory and subscribers unchanged and does not poison the queue', async () => {
  const directory = new MemoryConfigDirectory('theme: light\n');
  const config = await freshConfig(directory);
  await config.init();
  const notifications = [];
  config.subscribe((snapshot) => notifications.push(snapshot));
  directory.nextCloseError = new Error('disk full');

  await assert.rejects(config.set('theme', 'dark'), /disk full/);
  assert.equal(config.get('theme'), 'light');
  assert.deepEqual(parseConfigDocument(directory.text), { theme: 'light' });
  assert.deepEqual(notifications, []);

  await config.set('theme', 'blue');
  assert.equal(config.get('theme'), 'blue');
  assert.deepEqual(parseConfigDocument(directory.text), { theme: 'blue' });
  assert.deepEqual(notifications, [{ theme: 'blue' }]);
});

test('failed clear retains the last committed config', async () => {
  const directory = new MemoryConfigDirectory('theme: light\n');
  const config = await freshConfig(directory);
  await config.init();
  directory.nextRemoveError = new Error('permission denied');

  await assert.rejects(config.clear(), /permission denied/);
  assert.deepEqual(config.get(), { theme: 'light' });
  assert.deepEqual(parseConfigDocument(directory.text), { theme: 'light' });

  await config.clear();
  assert.deepEqual(config.get(), {});
  assert.equal(directory.text, null);
});

test('config paths preserve __proto__ as data without inherited reads', async () => {
  const directory = new MemoryConfigDirectory('theme: light\n');
  const config = await freshConfig(directory);
  await config.init();

  await config.set('__proto__.polluted', 'user-owned');
  const stored = config.get();
  assert.equal(Object.getPrototypeOf(stored), Object.prototype);
  assert.equal(Object.hasOwn(stored, '__proto__'), true);
  assert.equal(stored.__proto__.polluted, 'user-owned');
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(config.get('toString'), undefined);

  const reloaded = await freshConfig(directory);
  await reloaded.init();
  assert.equal(reloaded.get('__proto__.polluted'), 'user-owned');
  assert.equal(Object.prototype.polluted, undefined);
});

test('setAll rejects a non-mapping before touching disk', async () => {
  const directory = new MemoryConfigDirectory('theme: light\n');
  const config = await freshConfig(directory);
  await config.init();

  await assert.rejects(config.setAll(['invalid']), /must be a mapping/i);
  assert.deepEqual(config.get(), { theme: 'light' });
  assert.deepEqual(parseConfigDocument(directory.text), { theme: 'light' });
});

test('factory-reset fence drains prior writes and rejects secret resurrection', async () => {
  const directory = new MemoryConfigDirectory('sync:\n  secretAccessKey: old\n');
  const config = await freshConfig(directory);
  await config.init();
  const close = directory.pauseNextClose();

  const priorWrite = config.set('sync.secretAccessKey', 'queued-secret');
  await close.started;
  const reset = config.clearForFactoryReset();
  await assert.rejects(
    config.set('sync.secretAccessKey', 'late-secret'),
    /locked for factory reset/i
  );

  close.release();
  await priorWrite;
  await reset;
  assert.equal(directory.text, null);
  assert.deepEqual(config.get(), {});
  await assert.rejects(config.init(), /locked for factory reset/i);

  config.cancelFactoryReset();
  await config.set('theme', 'light');
  assert.deepEqual(parseConfigDocument(directory.text), { theme: 'light' });
});
