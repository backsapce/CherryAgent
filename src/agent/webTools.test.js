import assert from 'node:assert/strict';
import test from 'node:test';
import { getEnabledToolSchemas, registry } from './tools.js';

test('web tools are registered; web_search stays hidden until configured', () => {
  const names = getEnabledToolSchemas({}).map((tool) => tool.name);
  assert.ok(names.includes('web_fetch'));
  // No search provider is configured in the plain Node test environment, so
  // the schema must be filtered away from the model.
  assert.ok(!names.includes('web_search'));

  const tool = registry.get('web_fetch');
  assert.equal(tool.category, 'web');
  assert.equal(tool.readOnly, true);
  assert.equal(tool.parallelSafe, true);

  assert.ok(registry.get('web_search').schema.description.length > 40);
});

test('web_fetch dispatch converts a page without an agent server', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'https://example.com/docs',
    headers: new Map([['content-type', 'text/html']]),
    text: async () => '<html><head><title>Docs</title></head><body><p>Hello docs</p></body></html>',
    body: null,
  });
  try {
    const result = await registry.dispatch('web_fetch', { url: 'https://example.com/docs' }, {});
    assert.match(result, /Fetched https:\/\/example\.com\/docs — HTTP 200/);
    assert.match(result, /# Docs/);
    assert.match(result, /Hello docs/);
  } finally {
    globalThis.fetch = original;
  }
});
