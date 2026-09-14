import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SEARCH_PROVIDERS,
  formatSearchResults,
  getRuntimeSearchConfig,
  normalizeSearchSettings,
  providerIsConfigured,
  runWebSearch,
} from './search.js';

function mockFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return handler(String(input), init, calls.length);
  };
  return () => {
    globalThis.fetch = original;
    return calls;
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['content-type', 'application/json']]),
    json: async () => body,
  };
}

test('normalizeSearchSettings canonicalizes provider records and clamps maxResults', () => {
  const normalized = normalizeSearchSettings({
    provider: 'tavily',
    tavily: { apiKey: '  tvly-1  ' },
    searxng: { baseUrl: 'https://searx.example.com/' },
    maxResults: 99,
  });
  assert.equal(normalized.provider, 'tavily');
  assert.equal(normalized.providers.tavily.apiKey, 'tvly-1');
  assert.equal(normalized.providers.searxng.baseUrl, 'https://searx.example.com');
  assert.equal(normalized.maxResults, 10);

  assert.equal(normalizeSearchSettings({ provider: 'nope' }).provider, null);
  assert.equal(normalizeSearchSettings(null).maxResults, 5);
  assert.equal(normalizeSearchSettings('garbage').provider, null);
});

test('providerIsConfigured requires key or baseUrl per provider', () => {
  assert.equal(providerIsConfigured('tavily', { apiKey: 'k' }), true);
  assert.equal(providerIsConfigured('tavily', {}), false);
  assert.equal(providerIsConfigured('searxng', { baseUrl: 'https://s.example' }), true);
  assert.equal(providerIsConfigured('searxng', { baseUrl: 'ftp://bad' }), false);
  assert.equal(providerIsConfigured('unknown', { apiKey: 'k' }), false);
});

test('getRuntimeSearchConfig returns null unless the active provider is configured', () => {
  assert.equal(getRuntimeSearchConfig({ provider: 'brave', brave: {} }), null);
  assert.equal(getRuntimeSearchConfig({}), null);
  assert.deepEqual(
    getRuntimeSearchConfig({ provider: 'brave', providers: { brave: { apiKey: 'b1' } }, maxResults: 7 }),
    { provider: 'brave', apiKey: 'b1', maxResults: 7 }
  );
});

test('runWebSearch maps Tavily results and passes domain filters upstream', async () => {
  const restore = mockFetch(() => jsonResponse({
    results: [
      { title: 'Tavily One', url: 'https://one.example.com/a', content: 'First snippet' },
      { title: 'Tavily Two', url: 'https://two.example.com/b', content: 'Second <b>snippet</b> &amp; more' },
    ],
  }));
  try {
    const result = await runWebSearch(
      { provider: 'tavily', apiKey: 'tvly-x' },
      { query: 'hello world', allowedDomains: ['one.example.com'] },
    );
    assert.equal(result.provider, 'tavily');
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].url, 'https://one.example.com/a');
    assert.equal(result.results[0].snippet, 'First snippet');

    const calls = restore();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, 'https://api.tavily.com/search');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.query, 'hello world');
    assert.deepEqual(body.include_domains, ['one.example.com']);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tvly-x');
  } finally {
    restore();
  }
});

test('runWebSearch maps Brave results and post-filters domains', async () => {
  const restore = mockFetch(() => jsonResponse({
    web: {
      results: [
        { title: 'Brave <b>One</b>', url: 'https://a.example.com/1', description: 'desc &amp; one' },
        { title: 'Brave Two', url: 'https://b.example.org/2', description: 'desc two' },
      ],
    },
  }));
  try {
    const result = await runWebSearch(
      { provider: 'brave', apiKey: 'bsa-x' },
      { query: 'q', blockedDomains: ['example.org'] },
    );
    assert.deepEqual(result.results.map((r) => r.url), ['https://a.example.com/1']);
    assert.equal(result.results[0].title, 'Brave One');
    assert.equal(result.results[0].snippet, 'desc & one');

    const calls = restore();
    assert.match(calls[0].input, /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?q=q&count=/);
    assert.equal(calls[0].init.headers['X-Subscription-Token'], 'bsa-x');
  } finally {
    restore();
  }
});

test('runWebSearch maps SearXNG results against the instance baseUrl', async () => {
  const restore = mockFetch(() => jsonResponse({
    results: [
      { title: 'Sear Result', url: 'http://sear.example.com/x', content: 'sear snippet' },
    ],
  }));
  try {
    const result = await runWebSearch(
      { provider: 'searxng', baseUrl: 'https://searx.example.com/' },
      { query: 'term' },
    );
    assert.deepEqual(result.results, [
      { title: 'Sear Result', url: 'http://sear.example.com/x', snippet: 'sear snippet' },
    ]);
    const calls = restore();
    assert.equal(calls[0].input, 'https://searx.example.com/search?format=json&q=term');
  } finally {
    restore();
  }
});

test('runWebSearch rejects unconfigured providers, empty queries, and provider errors', async () => {
  await assert.rejects(() => runWebSearch({}, { query: 'x' }), /not configured/i);
  await assert.rejects(
    () => runWebSearch({ provider: 'tavily', apiKey: 'k' }, { query: '  ' }),
    /query is required/i,
  );

  const restore = mockFetch(() => jsonResponse({ detail: 'invalid api key' }, 401));
  try {
    await assert.rejects(
      () => runWebSearch({ provider: 'tavily', apiKey: 'bad' }, { query: 'x' }),
      /401: invalid api key/,
    );
  } finally {
    restore();
  }
});

test('runWebSearch dedupes URLs and clamps maxResults', async () => {
  const results = [1, 2, 3, 4].map((n) => ({
    title: `R${n}`,
    url: `https://x.example.com/${n <= 2 ? 'same' : `u${n}`}`,
    content: 'c',
  }));
  const restore = mockFetch(() => jsonResponse({ results }));
  try {
    const result = await runWebSearch(
      { provider: 'tavily', apiKey: 'k' },
      { query: 'q', maxResults: 99 },
    );
    assert.deepEqual(result.results.map((r) => r.url), [
      'https://x.example.com/same',
      'https://x.example.com/u3',
      'https://x.example.com/u4',
    ]);
  } finally {
    restore();
  }
});

test('formatSearchResults renders compact blocks and cites guidance', () => {
  const output = formatSearchResults({
    provider: 'tavily',
    query: 'q',
    results: [
      { title: 'T', url: 'https://e.com/1', snippet: 'S' },
      { title: 'T2', url: 'https://e.com/2', snippet: '' },
    ],
  });
  assert.match(output, /Web search results for "q" \(provider: tavily\)/);
  assert.match(output, /1\. T\n\s+https:\/\/e\.com\/1\n\s+S/);
  assert.match(output, /2\. T2\n\s+https:\/\/e\.com\/2/);
  assert.match(output, /markdown links/);
  assert.match(output, /web_fetch/);

  assert.equal(
    formatSearchResults({ provider: 'p', query: 'q', results: [] }),
    'No results found for "q" via p.',
  );
});

test('SEARCH_PROVIDERS advertises the three supported backends', () => {
  assert.deepEqual(SEARCH_PROVIDERS.map((p) => p.id), ['tavily', 'brave', 'searxng']);
});
