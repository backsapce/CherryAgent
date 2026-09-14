import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearWebFetchCache,
  decodeHtmlEntities,
  fetchWebPage,
  formatWebPageForModel,
  htmlToReadableText,
  isPrivateWebHostname,
  normalizeWebUrl,
} from './webFetch.js';

function mockFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    const res = await handler(input, init, calls.length);
    if (!res.url) res.url = String(input);
    return res;
  };
  return () => {
    globalThis.fetch = original;
    return calls;
  };
}

function textResponse(text, { status = 200, contentType = 'text/html; charset=utf-8' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['content-type', contentType]]),
    text: async () => text,
    body: null,
  };
}

test('normalizeWebUrl upgrades http and rejects non-web schemes', () => {
  assert.equal(normalizeWebUrl('http://example.com/page'), 'https://example.com/page');
  assert.equal(normalizeWebUrl('https://example.com/page'), 'https://example.com/page');
  assert.equal(normalizeWebUrl('ftp://example.com/file'), null);
  assert.equal(normalizeWebUrl('javascript:alert(1)'), null);
  assert.equal(normalizeWebUrl('not a url'), null);
  assert.equal(normalizeWebUrl(''), null);
});

test('isPrivateWebHostname catches loopback and private literals only', () => {
  assert.equal(isPrivateWebHostname('localhost'), true);
  assert.equal(isPrivateWebHostname('127.0.0.1'), true);
  assert.equal(isPrivateWebHostname('10.1.2.3'), true);
  assert.equal(isPrivateWebHostname('192.168.1.5'), true);
  assert.equal(isPrivateWebHostname('172.16.0.9'), true);
  assert.equal(isPrivateWebHostname('[::1]'), true);
  assert.equal(isPrivateWebHostname('example.com'), false);
  assert.equal(isPrivateWebHostname('8.8.8.8'), false);
  assert.equal(isPrivateWebHostname('172.32.0.1'), false);
});

test('decodeHtmlEntities decodes named and numeric entities', () => {
  assert.equal(decodeHtmlEntities('a &amp; b &lt;c&gt; &#39;&#x27;'), "a & b <c> ''");
  assert.equal(decodeHtmlEntities('&nbsp;&mdash;&hellip;'), ' —…');
  assert.equal(decodeHtmlEntities('&unknown;'), '&unknown;');
});

test('htmlToReadableText extracts title, headings, links, and drops scripts', () => {
  const html = [
    '<html><head><title>Docs Page</title><style>.x{color:red}</style>',
    '<script>console.log("never visible")</script></head>',
    '<body>',
    '<h1>Main Title</h1>',
    '<p>First paragraph with <a href="https://example.com/link">a link</a> inside.</p>',
    '<ul><li>Item one</li><li>Item two</li></ul>',
    '<h2>Section</h2>',
    '<p>Second &amp; final paragraph.</p>',
    '<img src="x.png" alt="chart">',
    '</body></html>',
  ].join('');
  const text = htmlToReadableText(html);

  assert.ok(text.startsWith('# Docs Page'));
  assert.match(text, /# Main Title/);
  assert.match(text, /## Section/);
  assert.match(text, /\[a link\]\(https:\/\/example\.com\/link\)/);
  assert.match(text, /- Item one/);
  assert.match(text, /- Item two/);
  assert.match(text, /Second & final paragraph\./);
  assert.match(text, /\[image: chart\]/);
  assert.doesNotMatch(text, /console\.log/);
  assert.doesNotMatch(text, /color:red/);
});

test('fetchWebPage converts HTML, caps output, and caches successes', async () => {
  clearWebFetchCache();
  const restore = mockFetch(() => textResponse('<html><head><title>Cached</title></head><body><p>hello</p></body></html>', {
    url: 'https://example.com/cached',
  }));
  try {
    const first = await fetchWebPage('http://example.com/cached');
    assert.equal(first.status, 200);
    assert.equal(first.fromCache, false);
    assert.match(first.text, /# Cached/);
    assert.match(first.text, /hello/);

    const second = await fetchWebPage('https://example.com/cached');
    assert.equal(second.fromCache, true);

    const calls = restore();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, 'https://example.com/cached');
  } finally {
    restore();
  }
});

test('fetchWebPage rejects binary content types and invalid URLs', async () => {
  clearWebFetchCache();
  await assert.rejects(
    () => fetchWebPage('ftp://example.com/file'),
    /Invalid or unsupported URL/,
  );

  const restore = mockFetch(() => textResponse('binary', { contentType: 'application/zip' }));
  try {
    await assert.rejects(
      () => fetchWebPage('https://example.com/app.zip'),
      /Unsupported content type "application\/zip"/,
    );
  } finally {
    restore();
  }
});

test('fetchWebPage truncates oversized output with a marker', async () => {
  clearWebFetchCache();
  const longBody = `<html><body><p>${'x'.repeat(120_000)}</p></body></html>`;
  const restore = mockFetch(() => textResponse(longBody, { url: 'https://example.com/big' }));
  try {
    const page = await fetchWebPage('https://example.com/big', { maxChars: 5_000, noCache: true });
    assert.equal(page.truncated, true);
    assert.ok(page.text.length <= 6_000);
    assert.match(page.text, /page content truncated/);
  } finally {
    restore();
  }
});

test('formatWebPageForModel includes fetch metadata header', () => {
  const output = formatWebPageForModel({
    url: 'https://example.com/x',
    status: 404,
    contentType: 'text/html',
    text: 'Not found text',
    truncated: false,
  });
  assert.match(output, /Fetched https:\/\/example\.com\/x — HTTP 404, text\/html/);
  assert.match(output, /Not found text/);
});
