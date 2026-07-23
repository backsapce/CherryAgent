import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUploadBatch,
  normalizeUploadRelativePath,
  readDroppedUploadBatch,
  uploadBatchToDestination,
} from './uploadUtils.js';

function fakeFile(name, webkitRelativePath = '') {
  return { name, webkitRelativePath };
}

function legacyFile(name) {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file(resolve) {
      resolve(fakeFile(name));
    },
  };
}

function legacyDirectory(name, batches) {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      let index = 0;
      return {
        readEntries(resolve) {
          resolve(batches[index++] || []);
        },
      };
    },
  };
}

test('creates a relative upload batch for folder input files', () => {
  const batch = createUploadBatch([
    fakeFile('one.txt', 'project/one.txt'),
    fakeFile('two.txt', 'project/nested/two.txt'),
  ]);

  assert.deepEqual(batch.directories, ['project', 'project/nested']);
  assert.deepEqual(
    batch.files.map(({ relativePath }) => relativePath),
    ['project/one.txt', 'project/nested/two.txt']
  );
});

test('normalizes separators and rejects paths outside the destination', () => {
  assert.equal(normalizeUploadRelativePath('folder\\nested/file.txt'), 'folder/nested/file.txt');
  assert.throws(() => normalizeUploadRelativePath('../secret.txt'), /cannot leave/);
  assert.throws(() => normalizeUploadRelativePath('/absolute.txt'), /must be relative/);
});

test('recursively reads dragged folders and preserves empty directories', async () => {
  const empty = legacyDirectory('empty', [[]]);
  const nested = legacyDirectory('nested', [[legacyFile('two.txt')], []]);
  const project = legacyDirectory('project', [[legacyFile('one.txt')], [nested, empty], []]);
  const batch = await readDroppedUploadBatch({
    items: [{
      kind: 'file',
      webkitGetAsEntry: () => project,
    }],
  });

  assert.deepEqual(batch.directories, ['project', 'project/empty', 'project/nested']);
  assert.deepEqual(
    batch.files.map(({ relativePath }) => relativePath),
    ['project/one.txt', 'project/nested/two.txt']
  );
});

test('uses File System Access handles when legacy drag entries are unavailable', async () => {
  const fileHandle = {
    kind: 'file',
    name: 'file.txt',
    getFile: async () => fakeFile('file.txt'),
  };
  const folderHandle = {
    kind: 'directory',
    name: 'folder',
    async *values() {
      yield fileHandle;
    },
  };

  const batch = await readDroppedUploadBatch({
    items: [{
      kind: 'file',
      getAsFileSystemHandle: () => Promise.resolve(folderHandle),
    }],
  });

  assert.deepEqual(batch.directories, ['folder']);
  assert.deepEqual(batch.files.map(({ relativePath }) => relativePath), ['folder/file.txt']);
});

test('maps the same relative folder structure onto a storage adapter target', async () => {
  const calls = [];
  const batch = createUploadBatch([
    fakeFile('one.txt', 'project/one.txt'),
    fakeFile('two.txt', 'project/nested/two.txt'),
  ]);
  const fileOps = {
    createDir: async (name, parentPath) => calls.push(['directory', name, parentPath]),
    upload: async (name, _file, parentPath) => calls.push(['file', name, parentPath]),
  };

  const result = await uploadBatchToDestination(batch, 'destination', fileOps);

  assert.deepEqual(result, { successCount: 4, failCount: 0 });
  assert.deepEqual(calls, [
    ['directory', 'project', 'destination'],
    ['directory', 'nested', 'destination/project'],
    ['file', 'one.txt', 'destination/project'],
    ['file', 'two.txt', 'destination/project/nested'],
  ]);
});
