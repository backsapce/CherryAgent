/**
 * Web search service for CherryAgent.
 *
 * Mirrors the LLM layer's split between pure execution and browser-owned
 * configuration: runWebSearch() takes an explicit runtime config so the
 * browser runtime, the agent-server proxy, and durable sandbox runs all share
 * one implementation, while the default-exported service persists provider
 * credentials in config.yaml (`search` subtree) for the browser UI.
 *
 * ZCode-inspired contract: searches return compact title/URL/snippet blocks —
 * never full page content — and the model picks URLs to read with web_fetch.
 */

import config from '../config/config.js';
import { withDeadlineSignal, decodeHtmlEntities } from '../agent/webFetch.js';

export const SEARCH_SETTINGS_VERSION = 1;

export const SEARCH_PROVIDERS = [
  {
    id: 'tavily',
    name: 'Tavily',
    requiresApiKey: true,
    requiresBaseUrl: false,
    // api.tavily.com sends CORS headers, so the browser can call it directly.
    docsUrl: 'https://tavily.com',
  },
  {
    id: 'brave',
    name: 'Brave Search',
    requiresApiKey: true,
    requiresBaseUrl: false,
    // api.search.brave.com sends CORS headers, so the browser can call it directly.
    docsUrl: 'https://brave.com/search/api/',
  },
  {
    id: 'searxng',
    name: 'SearXNG',
    requiresApiKey: false,
    requiresBaseUrl: true,
    // Self-hosted instances must enable the JSON output format; CORS depends
    // on the instance. Browser fetches fall back to the agent-server proxy.
    docsUrl: 'https://docs.searxng.org',
  },
];

const SEARCH_PROVIDER_META = Object.fromEntries(SEARCH_PROVIDERS.map((p) => [p.id, p]));

const DEFAULT_MAX_RESULTS = 5;
const ABSOLUTE_MAX_RESULTS = 10;
const SEARCH_TIMEOUT_MS = 20_000;

// ─── Settings normalization ─────────────────────────────────────────────────

function nullableString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function normalizeBaseUrl(value) {
  const text = nullableString(value);
  return text ? text.replace(/\/+$/, '') : null;
}

/**
 * Canonicalize persisted settings. Accepts both the canonical
 * `{provider, providers: {tavily: {apiKey}}}` shape and a flat legacy
 * `{provider, tavily: {apiKey}}` shape.
 */
export function normalizeSearchSettings(saved = {}) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  const rawProviders = saved.providers && typeof saved.providers === 'object' && !Array.isArray(saved.providers)
    ? saved.providers
    : saved;
  const providers = {};
  for (const meta of SEARCH_PROVIDERS) {
    const record = rawProviders[meta.id];
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const apiKey = nullableString(record.apiKey);
    const baseUrl = normalizeBaseUrl(record.baseUrl);
    if (apiKey || baseUrl) {
      providers[meta.id] = {
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      };
    }
  }
  const provider = SEARCH_PROVIDER_META[saved.provider] ? saved.provider : null;
  const maxResultsRaw = Number(saved.maxResults);
  return {
    schemaVersion: SEARCH_SETTINGS_VERSION,
    provider,
    providers,
    maxResults: Number.isFinite(maxResultsRaw) && maxResultsRaw > 0
      ? Math.min(Math.floor(maxResultsRaw), ABSOLUTE_MAX_RESULTS)
      : DEFAULT_MAX_RESULTS,
  };
}

export function providerIsConfigured(providerId, record) {
  const meta = SEARCH_PROVIDER_META[providerId];
  if (!meta) return false;
  const apiKey = record?.apiKey ? String(record.apiKey) : null;
  const baseUrl = normalizeBaseUrl(record?.baseUrl);
  if (meta.requiresApiKey && !apiKey) return false;
  if (meta.requiresBaseUrl && !baseUrl) return false;
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Execution config for a normalized settings document: the active provider
 * plus only its credential. Sent to sandbox runs like llm.getRuntimeConfig()
 * sends model credentials, and never returned by the UI-facing getters.
 */
export function getRuntimeSearchConfig(settings) {
  const normalized = normalizeSearchSettings(settings);
  const { provider } = normalized;
  if (!provider || !providerIsConfigured(provider, normalized.providers[provider])) return null;
  const record = normalized.providers[provider];
  return {
    provider,
    ...(record.apiKey ? { apiKey: record.apiKey } : {}),
    ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
    maxResults: normalized.maxResults,
  };
}

/** UI-facing settings view: keys are presence flags, never values. */
function publicSearchSettings(settings) {
  const normalized = normalizeSearchSettings(settings);
  const providers = {};
  for (const meta of SEARCH_PROVIDERS) {
    const record = normalized.providers[meta.id] || {};
    providers[meta.id] = {
      hasApiKey: Boolean(record.apiKey),
      ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
    };
  }
  return {
    schemaVersion: SEARCH_SETTINGS_VERSION,
    provider: normalized.provider,
    providers,
    maxResults: normalized.maxResults,
    configured: Boolean(normalized.provider && providerIsConfigured(normalized.provider, normalized.providers[normalized.provider])),
  };
}

// ─── Domain filters ─────────────────────────────────────────────────────────

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function domainMatches(hostname, domain) {
  const clean = String(domain || '').toLowerCase().replace(/^\./, '');
  if (!clean || !hostname) return false;
  return hostname === clean || hostname.endsWith(`.${clean}`);
}

function filterResultsByDomains(results, allowedDomains, blockedDomains) {
  const allowed = (allowedDomains || []).map(String).filter(Boolean);
  const blocked = (blockedDomains || []).map(String).filter(Boolean);
  if (!allowed.length && !blocked.length) return results;
  return results.filter((result) => {
    const host = hostnameOf(result.url);
    if (!host) return false;
    if (blocked.some((domain) => domainMatches(host, domain))) return false;
    if (allowed.length && !allowed.some((domain) => domainMatches(host, domain))) return false;
    return true;
  });
}

// ─── Provider adapters ──────────────────────────────────────────────────────

function stripHtml(text) {
  return decodeHtmlEntities(String(text || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

async function requestJson(url, init, { signal, timeoutMs } = {}) {
  const deadline = withDeadlineSignal(signal, timeoutMs || SEARCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { ...init, signal: deadline.signal });
  } catch (err) {
    deadline.cancel();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new Error(`Search request to ${new URL(url).host} failed: ${err?.message || 'network error'}`);
  }
  deadline.cancel();
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body?.detail || body?.message || body?.error;
    const error = new Error(
      `Search provider returned ${res.status}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`
    );
    error.statusCode = res.status;
    throw error;
  }
  return body;
}

async function tavilySearch(config, request, opts) {
  const body = await requestJson('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      query: request.query,
      max_results: request.maxResults,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
      ...(request.allowedDomains.length ? { include_domains: request.allowedDomains } : {}),
      ...(request.blockedDomains.length ? { exclude_domains: request.blockedDomains } : {}),
    }),
  }, opts);
  return (Array.isArray(body.results) ? body.results : []).map((result) => ({
    title: stripHtml(result.title) || result.url,
    url: String(result.url || ''),
    snippet: stripHtml(result.content).slice(0, 1_000),
  }));
}

async function braveSearch(config, request, opts) {
  const endpoint = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(request.query)}&count=${request.maxResults}`;
  const body = await requestJson(endpoint, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': config.apiKey,
    },
  }, opts);
  const results = Array.isArray(body?.web?.results) ? body.web.results : [];
  return results.map((result) => ({
    title: stripHtml(result.title) || result.url,
    url: String(result.url || ''),
    snippet: stripHtml(result.description).slice(0, 1_000),
  }));
}

async function searxngSearch(config, request, opts) {
  const base = String(config.baseUrl || '').replace(/\/+$/, '');
  const endpoint = `${base}/search?format=json&q=${encodeURIComponent(request.query)}`;
  const body = await requestJson(endpoint, {
    headers: { Accept: 'application/json' },
  }, opts);
  const results = Array.isArray(body?.results) ? body.results : [];
  return results.map((result) => ({
    title: stripHtml(result.title) || result.url,
    url: String(result.url || ''),
    snippet: stripHtml(result.content).slice(0, 1_000),
  }));
}

const PROVIDER_ADAPTERS = {
  tavily: tavilySearch,
  brave: braveSearch,
  searxng: searxngSearch,
};

// ─── Execution ──────────────────────────────────────────────────────────────

/**
 * Run one web search with an explicit runtime config (see
 * getRuntimeSearchConfig). Tavily filters domains server-side; other
 * providers post-filter results client-side.
 *
 * @returns {Promise<{provider: string, query: string, results: Array<{title: string, url: string, snippet: string}>}>}
 */
export async function runWebSearch(searchConfig, request = {}, opts = {}) {
  const provider = SEARCH_PROVIDER_META[searchConfig?.provider] ? searchConfig.provider : null;
  if (!provider || !providerIsConfigured(provider, searchConfig)) {
    throw new Error('Web search is not configured. Select a provider and complete its credentials in Settings.');
  }
  const query = String(request.query || '').trim();
  if (!query) throw new Error('A search query is required.');
  const maxResults = Math.min(
    Math.max(1, Number(request.maxResults) || searchConfig.maxResults || DEFAULT_MAX_RESULTS),
    ABSOLUTE_MAX_RESULTS
  );
  const normalizedRequest = {
    query,
    maxResults,
    allowedDomains: (request.allowedDomains || []).map(String).filter(Boolean),
    blockedDomains: (request.blockedDomains || []).map(String).filter(Boolean),
  };

  const adapter = PROVIDER_ADAPTERS[provider];
  let results = await adapter(searchConfig, normalizedRequest, opts);
  results = filterResultsByDomains(results, normalizedRequest.allowedDomains, normalizedRequest.blockedDomains);

  const seen = new Set();
  results = results
    .filter((result) => {
      if (!result.url || !/^https?:/i.test(result.url)) return false;
      const key = result.url.replace(/\/+$/, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxResults);

  return { provider, query, results };
}

/**
 * Format search results as the compact model-facing block the web_search tool
 * returns (title / URL / snippet per result).
 */
export function formatSearchResults({ provider, query, results } = {}) {
  if (!results?.length) {
    return `No results found for "${query}" via ${provider}.`;
  }
  const lines = [`Web search results for "${query}" (provider: ${provider}):`, ''];
  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title || result.url}`);
    lines.push(`   ${result.url}`);
    if (result.snippet) lines.push(`   ${result.snippet}`);
    lines.push('');
  });
  lines.push('Cite used sources as markdown links. Use web_fetch on a result URL when a page must be read in depth.');
  return lines.join('\n').trim();
}

// ─── Browser-side settings service ──────────────────────────────────────────

/**
 * Persists search provider credentials under config.yaml → search. Follows the
 * LLM settings convention: keys never appear in getters (hasApiKey flags
 * only) and stay device-local in sync (see syncManager strip/restore).
 */
const search = {
  getProviderTypes() {
    return SEARCH_PROVIDERS.map(({ id, name, requiresApiKey, requiresBaseUrl, docsUrl }) => ({
      id,
      name,
      requiresApiKey,
      requiresBaseUrl,
      docsUrl,
    }));
  },

  getSettings() {
    return publicSearchSettings(config.get('search') || {});
  },

  async configure(patch = {}) {
    const current = normalizeSearchSettings(config.get('search') || {});
    const providers = { ...current.providers };
    for (const meta of SEARCH_PROVIDERS) {
      const record = { ...(providers[meta.id] || {}) };
      const input = patch.providers?.[meta.id] || {};
      if (input.clearApiKey) delete record.apiKey;
      else if (input.apiKey) record.apiKey = nullableString(input.apiKey);
      if (hasOwn(input, 'baseUrl')) record.baseUrl = normalizeBaseUrl(input.baseUrl);
      const apiKey = record.apiKey || null;
      const baseUrl = record.baseUrl || null;
      if (apiKey || baseUrl) providers[meta.id] = { ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}) };
      else delete providers[meta.id];
    }
    const provider = SEARCH_PROVIDER_META[patch.provider] ? patch.provider : current.provider;
    const maxResultsRaw = Number(patch.maxResults);
    const next = normalizeSearchSettings({
      ...current,
      provider,
      providers,
      maxResults: Number.isFinite(maxResultsRaw) && maxResultsRaw > 0 ? maxResultsRaw : current.maxResults,
    });
    await config.set('search', next);
    return search.getSettings();
  },

  isConfigured() {
    return search.getSettings().configured;
  },

  /**
   * Execution config for sandbox runs. Mirrors llm.getRuntimeConfig(): only
   * sent over the authenticated sandbox-run channel, never exposed to the UI.
   */
  getRuntimeConfig() {
    return getRuntimeSearchConfig(config.get('search') || {});
  },

  /** Convenience wrapper running a search with the local persisted settings. */
  async search(request, opts = {}) {
    const runtimeConfig = search.getRuntimeConfig();
    if (!runtimeConfig) {
      throw new Error('Web search is not configured. Select a provider in Settings → Web Search.');
    }
    return runWebSearch(runtimeConfig, request, opts);
  },
};

export default search;
