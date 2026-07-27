import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterHiddenFileEntries,
  isHiddenEntryName,
  normalizeShowHiddenFiles,
  pathContainsHiddenEntry,
} from './fileVisibility.js';

test('hidden files stay disabled unless the setting is explicitly true', () => {
  assert.equal(normalizeShowHiddenFiles(undefined), false);
  assert.equal(normalizeShowHiddenFiles(false), false);
  assert.equal(normalizeShowHiddenFiles('true'), false);
  assert.equal(normalizeShowHiddenFiles(true), true);
});

test('hidden entry helpers recognize dot-prefixed names and path segments', () => {
  assert.equal(isHiddenEntryName('.env'), true);
  assert.equal(isHiddenEntryName('env'), false);
  assert.equal(pathContainsHiddenEntry('src/.cache/result.json'), true);
  assert.equal(pathContainsHiddenEntry('src/cache/result.json'), false);
});

test('file tree filtering removes hidden files and directories at every depth', () => {
  const listing = {
    id: 'root',
    name: '/',
    type: 'directory',
    children: [
      { id: 'hidden-file', name: '.env', type: 'file' },
      {
        id: 'src',
        name: 'src',
        type: 'directory',
        children: [
          { id: 'hidden-dir', name: '.cache', type: 'directory', children: [] },
          { id: 'visible-file', name: 'app.js', type: 'file' },
        ],
      },
    ],
  };

  const filtered = filterHiddenFileEntries(listing);
  assert.deepEqual(filtered.children.map((entry) => entry.name), ['src']);
  assert.deepEqual(filtered.children[0].children.map((entry) => entry.name), ['app.js']);
  assert.equal(listing.children.length, 2);
  assert.equal(filterHiddenFileEntries(listing, true), listing);
});
