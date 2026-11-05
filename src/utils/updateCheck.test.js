import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APP_VERSION,
  checkForUpdates,
  compareVersions,
  extractVersionFromPackageJson,
  getUpdateStatus,
  isNewerVersion,
  parseVersion,
  subscribeUpdateStatus,
} from './updateCheck.js';

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const handler = responses[url];
    if (!handler) throw new Error(`unexpected url ${url}`);
    if (typeof handler === 'function') return handler();
    return handler;
  };
  impl.calls = calls;
  return impl;
}

const okResponse = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

const SOURCES = [
  'https://raw.githubusercontent.com/backsapce/CherryAgent/main/package.json',
  'https://cdn.jsdelivr.net/gh/backsapce/CherryAgent@main/package.json',
];

const NEWER = okResponse({ version: '99.0.0' });
const SAME = okResponse({ version: APP_VERSION });

test('parseVersion accepts v-prefixes and rejects junk', () => {
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('1.2.3-beta.4'), [1, 2, 3]);
  assert.equal(parseVersion('hello'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(null), null);
});

test('compareVersions orders semver triples', () => {
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('junk', '1.0.0'), 0);
});

test('isNewerVersion detects strictly newer versions', () => {
  assert.equal(isNewerVersion('0.1.0', '0.0.23'), true);
  assert.equal(isNewerVersion('0.0.23', '0.0.23'), false);
  assert.equal(isNewerVersion('0.0.22', '0.0.23'), false);
});

test('extractVersionFromPackageJson pulls a valid version field', () => {
  assert.equal(extractVersionFromPackageJson({ version: '1.2.3' }), '1.2.3');
  assert.equal(extractVersionFromPackageJson({ version: 'nope' }), null);
  assert.equal(extractVersionFromPackageJson(null), null);
  assert.equal(extractVersionFromPackageJson('x'), null);
});

test('checkForUpdates reports an update when the remote version is newer', async () => {
  const fetchImpl = fakeFetch({ [SOURCES[0]]: NEWER });
  const seen = [];
  const unsubscribe = subscribeUpdateStatus((s) => seen.push(s.updateAvailable));

  const before = getUpdateStatus();
  assert.notEqual(before.status, 'checking');
  const result = await checkForUpdates({ force: true, fetchImpl, now: () => 1000 });

  assert.equal(result.status, 'checked');
  assert.equal(result.latestVersion, '99.0.0');
  assert.equal(result.currentVersion, APP_VERSION);
  assert.equal(result.updateAvailable, true);
  assert.deepEqual(fetchImpl.calls, [SOURCES[0]], 'stops at the first working source');
  assert.equal(seen.at(-1), true);

  unsubscribe();
});

test('checkForUpdates falls back to the CDN when raw.githubusercontent fails', async () => {
  const fetchImpl = fakeFetch({
    [SOURCES[0]]: { ok: false, status: 404 },
    [SOURCES[1]]: NEWER,
  });
  const result = await checkForUpdates({ force: true, fetchImpl, now: () => 2000 });
  assert.deepEqual(fetchImpl.calls, SOURCES);
  assert.equal(result.status, 'checked');
  assert.equal(result.latestVersion, '99.0.0');
});

test('checkForUpdates records failures without crashing', async () => {
  const fetchImpl = fakeFetch({});
  const result = await checkForUpdates({ force: true, fetchImpl, now: () => 3000 });
  assert.equal(result.status, 'error');
  assert.ok(result.error);
  // A failed refresh keeps the previously-known remote version; it must not
  // wipe a discovery that was already reported to the UI.
  assert.equal(result.latestVersion, '99.0.0');
  assert.equal(result.updateAvailable, true);
});

test('a same-version check reports no update', async () => {
  const fetchImpl = fakeFetch({ [SOURCES[0]]: SAME, [SOURCES[1]]: SAME });
  const result = await checkForUpdates({ force: true, fetchImpl, now: () => 4000 });
  assert.equal(result.latestVersion, APP_VERSION);
  assert.equal(result.updateAvailable, false);
});

test('a fresh successful check is replayed without refetching', async () => {
  const fetchImpl = fakeFetch({ [SOURCES[0]]: SAME, [SOURCES[1]]: SAME });
  await checkForUpdates({ force: true, fetchImpl, now: () => 5000 });
  const callsAfterFirst = fetchImpl.calls.length;

  const again = await checkForUpdates({ fetchImpl, now: () => 5100 });
  assert.equal(again.status, 'checked');
  assert.equal(fetchImpl.calls.length, callsAfterFirst, 'cached result short-circuits the fetch');
});
