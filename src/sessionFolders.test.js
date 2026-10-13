import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_FOLDER_ID,
  DEFAULT_FOLDER_NAME,
  FOLDER_PAGE_SIZE,
  groupSessionsByFolder,
  nextFolderName,
  sessionFolderKey,
  sortSessionFolders,
} from './sessionFolders.js';

test('sessionFolderKey falls back to the default folder for unsafe references', () => {
  assert.equal(sessionFolderKey({ folderId: 'work' }), 'work');
  assert.equal(sessionFolderKey({}), DEFAULT_FOLDER_ID);
  assert.equal(sessionFolderKey({ folderId: null }), DEFAULT_FOLDER_ID);
  assert.equal(sessionFolderKey({ folderId: '  ' }), DEFAULT_FOLDER_ID);
  assert.equal(sessionFolderKey({ folderId: 'a/b' }), DEFAULT_FOLDER_ID);
});

test('sortSessionFolders orders by creation time and drops invalid records', () => {
  const sorted = sortSessionFolders([
    { id: 'later', name: 'Later', createdAtMs: 200 },
    null,
    { id: 'earlier', name: 'Earlier', createdAtMs: 100 },
    { name: 'missing id' },
  ]);
  assert.deepEqual(sorted.map((folder) => folder.id), ['earlier', 'later']);
});

test('nextFolderName picks the free base name then the lowest free suffix', () => {
  assert.equal(nextFolderName([], '未命名'), '未命名');
  assert.equal(nextFolderName([{ name: '未命名' }], '未命名'), '未命名2');
  assert.equal(
    nextFolderName([{ name: '未命名' }, { name: '未命名2' }], '未命名'),
    '未命名3',
  );
  assert.equal(nextFolderName([{ name: '其他' }], '未命名'), '未命名');
});

test('groupSessionsByFolder puts the default group first in creation order', () => {
  const folders = [
    { id: 'z', name: 'Zed', createdAtMs: 200 },
    { id: 'a', name: 'Ay', createdAtMs: 100 },
  ];
  const groups = groupSessionsByFolder(
    [
      { id: 's1' },
      { id: 's2', folderId: 'z' },
      { id: 's3', folderId: 'a' },
      { id: 's4' },
    ],
    folders,
  );
  assert.deepEqual(groups.map((group) => group.id), [DEFAULT_FOLDER_ID, 'a', 'z']);
  assert.equal(groups[0].name, DEFAULT_FOLDER_NAME);
  assert.equal(groups[0].folder, null);
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['s1', 's4']);
  assert.deepEqual(groups[1].sessions.map((s) => s.id), ['s3']);
  assert.deepEqual(groups[2].sessions.map((s) => s.id), ['s2']);
});

test('sessions referencing a missing folder land in the default group', () => {
  const groups = groupSessionsByFolder(
    [{ id: 's1', folderId: 'ghost' }, { id: 's2' }],
    [{ id: 'real', name: 'Real', createdAtMs: 1 }],
  );
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['s1', 's2']);
  assert.deepEqual(groups[1].sessions, []);
});

test('folders without sessions still produce an empty group', () => {
  const groups = groupSessionsByFolder([], [{ id: 'empty', name: 'Empty', createdAtMs: 1 }]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[1].sessions, []);
  assert.equal(groups[1].name, 'Empty');
});

test('folder page size is 50', () => {
  assert.equal(FOLDER_PAGE_SIZE, 50);
});
