/**
 * Session message archiving plan.
 *
 * Long conversations are split into a plain-JSON "hot" tail that stays in
 * `sessions/<id>.json` (rewritten on every save, so it must stay small) and
 * immutable gzip "chunks" under `sessions/<id>/cNNNN.json.gz` that are only
 * ever appended. The most recent HOT_KEEP_MESSAGES messages are never
 * compressed; everything older migrates into chunks as soon as a full chunk
 * can be sealed.
 *
 * Invariants:
 * - A chunk is sealed only when it hits a cap (CHUNK_MAX_MESSAGES or
 *   CHUNK_MAX_SERIALIZED_BYTES), so appending messages never moves an
 *   existing chunk boundary: chunk files are write-once.
 * - The hot file is published after its chunks (same crash-safety ordering
 *   as the session.json index), so a crash can leave ignorable orphan chunk
 *   files but never a reference to a missing chunk.
 * - Sessions without chunks keep today's bare-array file format byte-for-byte.
 */

export const HOT_KEEP_MESSAGES = 100;
export const CHUNK_MAX_MESSAGES = 100;
export const CHUNK_MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;

const CHUNK_FILE_PATTERN = /^c(\d{4,})\.json\.gz$/;

/**
 * Cheap stable fingerprint of a serialized JSON string (FNV-1a-ish, two
 * lanes). Used to detect unchanged bodies/chunks without keeping them around.
 */
export function fingerprintString(serialized) {
  let hashA = 0x811c9dc5;
  let hashB = 0x9e3779b9;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    hashA = Math.imul(hashA ^ code, 0x01000193);
    hashB = Math.imul(hashB ^ code, 0x85ebca6b);
  }
  return `${serialized.length}:${hashA >>> 0}:${hashB >>> 0}`;
}

export function chunkFileName(index) {
  return `c${String(index).padStart(4, '0')}.json.gz`;
}

export function parseChunkFileName(name) {
  const match = CHUNK_FILE_PATTERN.exec(String(name || ''));
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

function serializedByteLength(serialized) {
  // Avoid re-encoding to UTF-8 twice: JSON.stringify already produced the
  // string; its UTF-8 size is what lands on disk.
  let bytes = 0;
  for (let i = 0; i < serialized.length; i += 1) {
    const code = serialized.charCodeAt(i);
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
  }
  return bytes;
}

/**
 * Greedily split `[start, regionEnd)` of `messages` into chunks. A chunk
 * closes when it reaches `maxMessages`, or when appending the next message
 * would push it past `maxBytes` (serialized, UTF-8). A single message larger
 * than `maxBytes` becomes its own chunk rather than an infinite loop.
 */
function buildChunks(messages, start, regionEnd, { maxMessages, maxBytes }) {
  const chunks = [];
  let cursor = start;
  while (cursor < regionEnd) {
    const parts = [];
    let bytes = 2; // [ and ]
    let end = cursor;
    let closedBy = 'region';
    while (end < regionEnd) {
      const part = JSON.stringify(messages[end]);
      const partBytes = serializedByteLength(part) + (parts.length ? 1 : 0);
      if (parts.length > 0 && bytes + partBytes > maxBytes) {
        closedBy = 'bytes';
        break;
      }
      parts.push(part);
      bytes += partBytes;
      end += 1;
      if (parts.length >= maxMessages) {
        closedBy = 'messages';
        break;
      }
    }
    const serialized = `[${parts.join(',')}]`;
    chunks.push({
      index: chunks.length,
      start: cursor,
      end,
      count: end - cursor,
      closedBy,
      serialized,
      fingerprint: fingerprintString(serialized),
    });
    cursor = end;
  }
  return chunks;
}

/**
 * Plan how a full in-memory message array maps onto disk.
 *
 * @returns {{
 *   hotMessages: Array,
 *   chunks: Array<{index, start, end, count, serialized, fingerprint}>,
 *   sealedCount: number,
 *   archivedCount: number,
 * }}
 * `sealedCount`/`archivedCount` are the number of chunks that actually go to
 * disk; a trailing partial chunk (closed only by the region end) stays in the
 * hot file until it fills up, which is what makes chunk files write-once.
 */
export function planSessionArchive(messages, options = {}) {
  const hotKeep = options.hotKeep ?? HOT_KEEP_MESSAGES;
  const maxMessages = options.maxMessages ?? CHUNK_MAX_MESSAGES;
  const maxBytes = options.maxBytes ?? CHUNK_MAX_SERIALIZED_BYTES;
  const list = Array.isArray(messages) ? messages : [];

  if (list.length <= hotKeep || maxMessages <= 0 || maxBytes <= 0) {
    return { hotMessages: list, chunks: [], sealedCount: 0, archivedCount: 0 };
  }

  const regionEnd = list.length - hotKeep;
  const chunks = buildChunks(list, 0, regionEnd, { maxMessages, maxBytes });
  if (chunks.length === 0) {
    return { hotMessages: list, chunks: [], sealedCount: 0, archivedCount: 0 };
  }

  const last = chunks[chunks.length - 1];
  // A chunk that ran out of region (instead of hitting a cap) is still hot:
  // keeping it out of the archive preserves write-once chunk boundaries as
  // the conversation grows.
  const lastIsPartial = last.closedBy === 'region';
  const sealed = lastIsPartial ? chunks.slice(0, -1) : chunks;
  if (sealed.length === 0) {
    return { hotMessages: list, chunks: [], sealedCount: 0, archivedCount: 0 };
  }
  const archivedCount = sealed[sealed.length - 1].end;
  return {
    hotMessages: list.slice(archivedCount),
    chunks: sealed,
    sealedCount: sealed.length,
    archivedCount,
  };
}

export const HOT_ENVELOPE_VERSION = 1;

/**
 * Serialize the hot-file body. Chunks present → versioned envelope object;
 * no chunks → bare array, exactly the historical on-disk format.
 */
export function formatHotFileBody({ chunks, hotMessages }) {
  if (!chunks || chunks.length === 0) {
    return JSON.stringify(hotMessages ?? []);
  }
  return JSON.stringify({
    v: HOT_ENVELOPE_VERSION,
    chunks: chunks.map(({ index, count, bytes, fingerprint }) => ({
      index,
      count,
      bytes,
      fingerprint,
    })),
    messages: hotMessages ?? [],
  });
}

/**
 * Parse a hot-file payload.
 *
 * @returns {{chunks: Array, hotMessages: Array}|null} null when the payload
 * is neither a message array nor a supported envelope.
 */
export function parseHotFileBody(parsed) {
  if (Array.isArray(parsed)) {
    return { chunks: [], hotMessages: parsed };
  }
  if (
    parsed
    && typeof parsed === 'object'
    && parsed.v === HOT_ENVELOPE_VERSION
    && Array.isArray(parsed.messages)
    && (parsed.chunks === undefined || Array.isArray(parsed.chunks))
  ) {
    const chunks = [];
    for (const entry of parsed.chunks || []) {
      if (
        entry
        && typeof entry === 'object'
        && Number.isSafeInteger(entry.index)
        && entry.index >= 0
        && Number.isSafeInteger(entry.count)
        && entry.count >= 0
        && typeof entry.fingerprint === 'string'
      ) {
        chunks.push({
          index: entry.index,
          count: entry.count,
          bytes: Number.isSafeInteger(entry.bytes) ? entry.bytes : null,
          fingerprint: entry.fingerprint,
        });
      }
    }
    chunks.sort((left, right) => left.index - right.index);
    return { chunks, hotMessages: parsed.messages };
  }
  if (parsed && typeof parsed === 'object' && Number.isSafeInteger(parsed?.v)) {
    // A future envelope version: refuse loudly instead of silently dropping
    // either half of the conversation.
    return null;
  }
  return null;
}

/**
 * Reassemble the full message list from archived chunk payloads plus the hot
 * tail. Messages repeating an id (possible transiently after a sync/import
 * race between two devices that archived different prefixes) keep their first
 * position but take the later (hot) content, so no variant is silently lost.
 */
export function mergeArchivedView(chunkMessageArrays, hotMessages) {
  const merged = [];
  const positions = new Map();
  const absorb = (source) => {
    for (const message of source || []) {
      const id = message && message.id != null ? String(message.id) : null;
      if (id != null && positions.has(id)) {
        const position = positions.get(id);
        merged[position.index] = message;
        continue;
      }
      if (id != null) positions.set(id, { index: merged.length });
      merged.push(message);
    }
  };
  for (const chunk of chunkMessageArrays || []) absorb(chunk);
  absorb(hotMessages);
  return merged;
}
