/**
 * Web page fetch utility for the web_fetch tool.
 *
 * Isomorphic (browser + Node): global fetch, TextDecoder, and regex-based HTML
 * extraction only — no DOMParser, so the browser runtime, the agent-server
 * fetch proxy, and durable sandbox runs share one implementation.
 *
 * Behaviors modelled after ZCode's WebFetch: http is upgraded to https, only
 * http(s) URLs are accepted, responses are converted to readable text, source
 * and output sizes are capped, and successful fetches are cached for a short
 * TTL so repeated reads of the same URL do not re-download.
 */

import { truncateMiddle } from './toolObservation.js';

const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const ABSOLUTE_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 50_000;
const ABSOLUTE_MAX_CHARS = 200_000;
const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX_ENTRIES = 32;

const TEXT_CONTENT_TYPE_RE = /^(?:text\/|application\/(?:json|xml|\S+\+(?:json|xml))\b|application\/javascript\b)/i;
const HTML_CONTENT_TYPE_RE = /^text\/html\b|^application\/xhtml\+xml\b/i;

// ─── URL validation ─────────────────────────────────────────────────────────

/**
 * Normalize a URL for fetching. http is upgraded to https; any other scheme is
 * rejected. Returns the normalized URL string or null when unusable.
 */
export function normalizeWebUrl(rawUrl) {
  const text = String(rawUrl || '').trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol === 'http:') {
    parsed.protocol = 'https:';
  } else if (parsed.protocol !== 'https:') {
    return null;
  }
  if (!parsed.hostname || parsed.hostname === '.') return null;
  return parsed.toString();
}

/**
 * Lexical private-address check for the agent-server fetch proxy. Catches the
 * obvious loopback/RFC1918/link-local literals before connecting; a token
 * holder can already run arbitrary shell, so this is defense-in-depth (mainly
 * against CSRF-shaped misuse when auth is disabled), not a hard boundary.
 */
export function isPrivateWebHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || a >= 224;
  }
  if (host.includes(':')) {
    return host === '::' || host === '::1'
      || /^f[cd][0-9a-f]{2}:/i.test(host)
      || /^fe[89ab][0-9a-f]?:/i.test(host);
  }
  return false;
}

// ─── Signal helpers ─────────────────────────────────────────────────────────

/**
 * Combine an optional caller signal with a timeout into one signal. Uses
 * AbortSignal.any when available; falls back to a manual controller.
 * Returns { signal, cancel } — cancel() removes listeners and clears timers.
 */
export function withDeadlineSignal(signal, timeoutMs) {
  const timeout = Math.max(1_000, Number(timeoutMs) || DEFAULT_FETCH_TIMEOUT_MS);
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException('Timeout', 'TimeoutError'));
  const timeoutId = setTimeout(abort, timeout);
  const onAbort = () => controller.abort(signal.reason);
  let linked = false;
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeoutId);
      controller.abort(signal.reason);
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
      linked = true;
    }
  }
  return {
    signal: controller.signal,
    cancel() {
      clearTimeout(timeoutId);
      if (linked) signal.removeEventListener('abort', onAbort);
    },
  };
}

// ─── HTML → readable text ───────────────────────────────────────────────────

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', rsquo: '\u2019', lsquo: '\u2018',
  rdquo: '\u201D', ldquo: '\u201C', laquo: '\u00AB', raquo: '\u00BB',
  copy: '©', reg: '®', trade: '™', deg: '°', middot: '·', bull: '•',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü', ouml: 'ö',
  auml: 'ä', szlig: 'ß', ntilde: 'ñ', aacute: 'á', euro: '€', pound: '£',
  yen: '¥', cent: '¢', sect: '§', para: '¶', times: '×', divide: '÷',
};

function decodeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

export function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => decodeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => decodeCodePoint(Number(dec)))
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function stripTags(text) {
  return String(text || '').replace(/<[^>]*>/g, '');
}

const DROP_BLOCK_RE = /<(script|style|noscript|template|svg|iframe|canvas|object|embed|head|select|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const BLOCK_CLOSE_RE = /<\/(?:p|div|section|article|aside|header|footer|main|nav|li|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|tr|blockquote|pre|figure|figcaption|h[1-6]|body|html|address|details|summary|fieldset|legend|option|label)\s*>/gi;

/** Collapse intra-line whitespace but keep line structure. */
function collapseSpaces(text) {
  return text.replace(/[ \t\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n');
}

function anchorReplacement(match, href, inner) {
  const text = collapseSpaces(stripTags(inner)).trim();
  let absolute = null;
  try {
    const parsed = new URL(href);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') absolute = parsed.toString();
  } catch {
    absolute = null;
  }
  if (!absolute) return text || '';
  if (!text || text === absolute) return absolute;
  return `[${text}](${absolute})`;
}

/**
 * Convert an HTML document to compact readable text: drop scripts/styles,
 * keep the title, convert headings/list items/links into a Markdown-like
 * shape, decode entities, and collapse whitespace.
 */
export function htmlToReadableText(html) {
  const source = String(html || '');
  const titleMatch = source.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = titleMatch ? collapseSpaces(stripTags(titleMatch[1])).trim() : '';

  let text = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(DROP_BLOCK_RE, ' ')
    .replace(/<img\b[^>]*>/gi, (match) => {
      const alt = match.match(/\balt=["']([^"']*)["']/i);
      const label = alt ? collapseSpaces(decodeHtmlEntities(alt[1])).trim() : '';
      return label ? `[image: ${label}]` : ' ';
    })
    .replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, anchorReplacement)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level, inner) => {
      const heading = collapseSpaces(stripTags(inner)).trim();
      return heading ? `\n\n${'#'.repeat(Number(level))} ${heading}\n\n` : '\n\n';
    })
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, (_, inner) => {
      const item = collapseSpaces(stripTags(inner)).trim();
      return item ? `\n- ${item}` : '';
    })
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(BLOCK_CLOSE_RE, '\n\n')
    .replace(/<[^>]*>/g, ' ');

  text = collapseSpaces(decodeHtmlEntities(text))
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (title && !text.startsWith(title)) {
    text = `# ${title}\n\n${text}`;
  }
  return text;
}

// ─── Fetch cache ────────────────────────────────────────────────────────────

const cache = new Map();

export function clearWebFetchCache() {
  cache.clear();
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value) {
  cache.delete(key);
  cache.set(key, { value, at: Date.now() });
  while (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

// ─── Page fetch ─────────────────────────────────────────────────────────────

function clampNumber(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

/** Read a response body as text, stopping early once maxBytes is exceeded. */
async function readBodyCapped(res, maxBytes) {
  if (!res.body?.getReader) {
    const raw = await res.text();
    return { text: raw.slice(0, maxBytes * 4), truncated: raw.length > maxBytes * 4 };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let received = 0;
  let text = '';
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      text += decoder.decode(value.subarray(0, Math.max(0, maxBytes - (received - value.byteLength))), { stream: false });
      truncated = true;
      try { await reader.cancel(); } catch { /* already closed */ }
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  if (!truncated) text += decoder.decode();
  return { text, truncated };
}

/**
 * Fetch a web page and convert it to readable text.
 *
 * @param {string} rawUrl - target URL (http upgraded to https)
 * @param {{signal?: AbortSignal, timeoutMs?: number, maxSourceBytes?: number, maxChars?: number, noCache?: boolean}} [opts]
 * @returns {Promise<{url: string, status: number, contentType: string, text: string, truncated: boolean, fromCache: boolean}>}
 * @throws {Error} with `.statusCode` for client-visible failures (bad URL, unsupported content type, HTTP transport errors)
 */
export async function fetchWebPage(rawUrl, opts = {}) {
  const url = normalizeWebUrl(rawUrl);
  if (!url) {
    const error = new Error(`Invalid or unsupported URL: ${rawUrl}. Only http(s) URLs can be fetched.`);
    error.statusCode = 400;
    throw error;
  }
  if (!opts.noCache) {
    const cached = cacheGet(url);
    if (cached) return { ...cached, fromCache: true };
  }
  const maxSourceBytes = clampNumber(opts.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES, ABSOLUTE_MAX_SOURCE_BYTES);
  const maxChars = clampNumber(opts.maxChars, DEFAULT_MAX_CHARS, ABSOLUTE_MAX_CHARS);
  const deadline = withDeadlineSignal(opts.signal, opts.timeoutMs || DEFAULT_FETCH_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        'User-Agent': 'Mozilla/5.0 (compatible; CherryAgent)',
      },
      redirect: 'follow',
      signal: deadline.signal,
    });
  } catch (err) {
    deadline.cancel();
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const error = new Error(
      `Could not fetch ${url}: ${err?.message || 'network error'}. ` +
      (typeof window !== 'undefined'
        ? 'Browser-side fetches only reach CORS-enabled sites; connect an agent server so web_fetch can proxy.'
        : '')
    );
    error.statusCode = 502;
    throw error;
  }
  deadline.cancel();
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const contentType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType && !TEXT_CONTENT_TYPE_RE.test(contentType)) {
    const error = new Error(`Unsupported content type "${contentType}" at ${res.url || url}; only text, HTML, JSON, and XML can be read.`);
    error.statusCode = 415;
    throw error;
  }

  let { text, truncated } = await readBodyCapped(res, maxSourceBytes);
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  if (!contentType || HTML_CONTENT_TYPE_RE.test(contentType)) {
    text = htmlToReadableText(text);
  }

  if (text.length > maxChars) {
    text = `${truncateMiddle(text, maxChars, 'page content truncated')}`;
    truncated = true;
  }

  const page = {
    url: res.url || url,
    status: res.status,
    contentType: contentType || 'unknown',
    text,
    truncated,
    fromCache: false,
  };
  if (res.ok) cacheSet(page.url, page);
  return page;
}

/**
 * Format a fetched page as the model-facing tool result string.
 */
export function formatWebPageForModel(page) {
  const header = `[Fetched ${page.url} — HTTP ${page.status}${page.contentType && page.contentType !== 'unknown' ? `, ${page.contentType}` : ''}${page.truncated ? ', content truncated' : ''}]`;
  return `${header}\n\n${page.text}`;
}
