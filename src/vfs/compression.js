/**
 * Gzip codec over the native Web CompressionStream API.
 *
 * Chosen after benchmarking on realistic session JSON (mixed CJK/English
 * chat + tool calls + base64 images):
 * - native gzip ≈ pako's deflate output byte-for-byte, but with zero bundle
 *   cost and a native-code engine (~3ms per 100-message chunk);
 * - brotli/zstd only beat DEFLATE by a few percent on chat text and are not
 *   exposed through CompressionStream, so they would require a wasm dep;
 * - image-laden sessions are bounded by the base64 payload (~73%) for every
 *   algorithm, so splitting + gzip captures nearly all of the win.
 *
 * Every engine that supports this app's OPFS `createWritable` persistence
 * baseline (Chrome 86+, Firefox 111+, Safari 16.4+) is new enough for
 * CompressionStream except Firefox 111/112; `gzipSupported()` lets callers
 * degrade gracefully (keep everything in the plain hot file) there.
 */

const GZIP_FORMAT = 'gzip';

export function gzipSupported() {
  return typeof CompressionStream === 'function'
    && typeof DecompressionStream === 'function'
    && typeof Blob === 'function'
    && typeof Response === 'function';
}

async function pipeThroughCodec(bytes, Codec) {
  const stream = new Blob([bytes]).stream().pipeThrough(new Codec(GZIP_FORMAT));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

/** Compress UTF-8 text into gzip bytes. */
export async function gzipText(text) {
  return pipeThroughCodec(new TextEncoder().encode(text), CompressionStream);
}

/** Decompress gzip bytes back to UTF-8 text. */
export async function gunzipText(bytes) {
  const text = new TextDecoder().decode(await pipeThroughCodec(bytes, DecompressionStream));
  return text;
}

/** Compress a JSON-serializable value; returns gzip bytes of the compact JSON. */
export async function gzipJson(value) {
  return gzipText(JSON.stringify(value));
}

/** Decompress gzip bytes and parse the JSON payload. */
export async function gunzipJson(bytes) {
  return JSON.parse(await gunzipText(bytes));
}
