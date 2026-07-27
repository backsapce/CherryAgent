import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectAgentWorkspaceFiles,
  collectSandboxFiles,
} from './mentionFiles.js';

function file(size = 1, lastModified = 1) {
  return {
    kind: 'file',
    async getFile() {
      return { size, lastModified };
    },
  };
}

function directory(entries) {
  return {
    kind: 'directory',
    async *[Symbol.asyncIterator]() {
      yield* entries;
    },
  };
}

function inaccessibleDirectory() {
  return {
    kind: 'directory',
    [Symbol.asyncIterator]() {
      throw new Error('hidden directory should not be traversed');
    },
  };
}

test('workspace file search prunes hidden directories but keeps hidden files', async () => {
  const root = directory([
    ['.vertex-runs', inaccessibleDirectory()],
    ['.env', file(10, 20)],
    ['src', directory([
      ['.cache', inaccessibleDirectory()],
      ['app.js', file(30, 40)],
    ])],
  ]);

  const files = await collectAgentWorkspaceFiles('agent-1', async () => root);

  assert.deepEqual(files.map(({ relativePath }) => relativePath), ['.env', 'src/app.js']);
});

test('sandbox file search never lists descendants of hidden directories', async () => {
  const listedPaths = [];
  const listings = {
    '': {
      children: [
        { name: '.vertex-runs', path: '.vertex-runs', type: 'directory' },
        { name: '.env', path: '.env', type: 'file', size: 10 },
        { name: 'src', path: 'src', type: 'directory' },
      ],
    },
    src: [
      { name: '.cache', path: 'src/.cache', type: 'directory' },
      { name: 'app.js', path: 'src/app.js', type: 'file', size: 20 },
    ],
  };

  const files = await collectSandboxFiles('sandbox-url', async (path) => {
    listedPaths.push(path);
    return listings[path];
  });

  assert.deepEqual(listedPaths, ['', 'src']);
  assert.deepEqual(files.map(({ relativePath }) => relativePath), ['.env', 'src/app.js']);
});

test('sandbox file search uses a recursive listing without extra directory requests', async () => {
  const calls = [];
  const files = await collectSandboxFiles('sandbox-url', async (path, url, options) => {
    calls.push({ path, url, options });
    return {
      recursive: true,
      children: [
        { name: '.env', path: '/.env', type: 'file', size: 10 },
        { name: '.git', path: '/.git', type: 'directory' },
        { name: 'config', path: '/.git/config', type: 'file', size: 20 },
        { name: 'src', path: '/src', type: 'directory' },
        { name: 'app.js', path: '/src/app.js', type: 'file', size: 30 },
        { name: 'components', path: '/src/components', type: 'directory' },
        { name: 'Button.jsx', path: '/src/components/Button.jsx', type: 'file', size: 40 },
      ],
    };
  });

  assert.deepEqual(calls, [{
    path: '',
    url: 'sandbox-url',
    options: { recursive: true },
  }]);
  assert.deepEqual(
    files.map(({ relativePath }) => relativePath),
    ['.env', 'src/app.js', 'src/components/Button.jsx']
  );
});
