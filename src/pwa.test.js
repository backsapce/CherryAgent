import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const origin = 'https://site.example';

function worker(scope, storage) {
  const handlers = new Map();
  runInNewContext(source, {
    self: {
      registration: { scope: origin + scope },
      location: new URL(origin + scope + 'sw.js'),
      clients: { claim: async () => {} },
      addEventListener: (name, handler) => handlers.set(name, handler),
    },
    URL,
    caches: {
      keys: async () => [...storage.keys()],
      delete: async (key) => storage.delete(key),
      match: async (request, { cacheName }) => storage.get(cacheName)?.get(request.url ?? request),
    },
    fetch: async () => { throw new Error('offline'); },
  });
  return {
    activate: () => new Promise((resolve) => handlers.get('activate')({ waitUntil: resolve })),
    navigate(path) {
      let response;
      handlers.get('fetch')({
        request: { url: origin + path, method: 'GET', mode: 'navigate' },
        respondWith: (promise) => { response = promise; },
      });
      return response;
    },
  };
}

test('PWA workers only clean and serve their own deployment cache', async () => {
  const stable = '/CherryAgent/';
  const preview = '/CherryAgent/test/';
  const stableCache = 'cherry-agent:%2FCherryAgent%2F:v1';
  const previewCache = 'cherry-agent:%2FCherryAgent%2Ftest%2F:v1';
  const storage = new Map([
    [previewCache, new Map([[origin + preview + 'index.html', 'preview']])],
    [stableCache, new Map([[origin + stable + 'index.html', 'stable']])],
    ['cherry-agent:%2FCherryAgent%2F:old', new Map()],
    ['cherry-agent:%2FCherryAgent%2Ftest%2F:old', new Map()],
    ['unrelated-app', new Map([[origin + stable + 'index.html', 'wrong']])],
  ]);
  const release = worker(stable, storage);
  const testSite = worker(preview, storage);
  await release.activate();
  assert.deepEqual([...storage.keys()], [previewCache, stableCache, 'cherry-agent:%2FCherryAgent%2Ftest%2F:old', 'unrelated-app']);
  await testSite.activate();
  assert.deepEqual([...storage.keys()], [previewCache, stableCache, 'unrelated-app']);

  assert.equal(await release.navigate(stable + '?offline=1'), 'stable');
  assert.equal(await testSite.navigate(preview + '?offline=1'), 'preview');
  assert.equal(release.navigate(preview), undefined);
  storage.delete(stableCache);
  await assert.rejects(release.navigate(stable), /offline/);
});
