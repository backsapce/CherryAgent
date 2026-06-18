import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  deleteMemoryEntry,
  listMemoryEntries,
  loadMemory,
  upsertMemoryEntry,
} from './memory.js';
import { registry } from './tools.js';

let rootDir;

beforeEach(() => {
  rootDir = new TestDirectoryHandle();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      storage: {
        getDirectory: async () => rootDir,
      },
    },
  });
});

test('structured memory records round-trip through the memory API', async () => {
  const saved = await upsertMemoryEntry({
    type: 'memory',
    content: 'Remember that project memories are stored in OPFS.',
    tags: ['Project Notes'],
    importance: 'high',
  });

  let entries = await listMemoryEntries({ type: 'memory' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, saved.id);
  assert.equal(entries[0].content, 'Remember that project memories are stored in OPFS.');
  assert.deepEqual(entries[0].tags, ['project-notes']);
  assert.equal(entries[0].importance, 'high');

  const snapshot = await loadMemory();
  assert.match(snapshot.memory, /project memories are stored in OPFS/);
  assert.equal(snapshot.records.memory.length, 1);

  await upsertMemoryEntry({
    type: 'memory',
    id: saved.id,
    content: 'Updated project memory survives structured parsing.',
    tags: 'updated',
    importance: 'low',
  });

  entries = await listMemoryEntries({ type: 'both', query: 'structured parsing' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, saved.id);
  assert.equal(entries[0].content, 'Updated project memory survives structured parsing.');
  assert.deepEqual(entries[0].tags, ['updated']);
  assert.equal(entries[0].importance, 'low');

  assert.equal(await deleteMemoryEntry('memory', saved.id), true);
  assert.deepEqual(await listMemoryEntries({ type: 'both' }), []);
});

test('memory registry tool can write, search, and delete records', async () => {
  const writeResult = await registry.dispatch('memory', {
    action: 'write',
    type: 'user',
    content: 'The user prefers concise answers.',
    tags: ['preference'],
    importance: 'high',
  }, {});
  const id = writeResult.match(/Saved user memory ([^.]+)\./)?.[1];
  assert.ok(id, writeResult);

  const listResult = await registry.dispatch('memory', {
    action: 'list',
    type: 'user',
  }, {});
  assert.match(listResult, new RegExp(id));
  assert.match(listResult, /prefers concise answers/);

  const searchResult = await registry.dispatch('memory', {
    action: 'search',
    type: 'both',
    query: 'concise',
  }, {});
  assert.match(searchResult, new RegExp(id));

  const deleteResult = await registry.dispatch('memory', {
    action: 'delete',
    type: 'both',
    id,
  }, {});
  assert.equal(deleteResult, `Deleted memory ${id}.`);
  assert.equal(await registry.dispatch('memory', { action: 'list', type: 'both' }, {}), 'No memory records found.');
});

class TestDirectoryHandle {
  kind = 'directory';

  constructor() {
    this.entries = new Map();
  }

  async getDirectoryHandle(name, options = {}) {
    const existing = this.entries.get(name);
    if (existing) {
      if (existing.kind !== 'directory') throw new Error(`${name} is not a directory`);
      return existing;
    }
    if (!options.create) throw new Error(`Directory not found: ${name}`);
    const dir = new TestDirectoryHandle();
    this.entries.set(name, dir);
    return dir;
  }

  async getFileHandle(name, options = {}) {
    const existing = this.entries.get(name);
    if (existing) {
      if (existing.kind !== 'file') throw new Error(`${name} is not a file`);
      return existing;
    }
    if (!options.create) throw new Error(`File not found: ${name}`);
    const file = new TestFileHandle();
    this.entries.set(name, file);
    return file;
  }

  async removeEntry(name) {
    if (!this.entries.delete(name)) throw new Error(`Entry not found: ${name}`);
  }

  async *[Symbol.asyncIterator]() {
    for (const entry of this.entries) {
      yield entry;
    }
  }
}

class TestFileHandle {
  kind = 'file';

  constructor() {
    this.content = '';
  }

  async getFile() {
    return {
      text: async () => this.content,
    };
  }

  async createWritable() {
    const chunks = [];
    return {
      write: async (content) => {
        chunks.push(String(content));
      },
      close: async () => {
        this.content = chunks.join('');
      },
    };
  }
}
