/**
 * Structured memory for VertexAgent.
 *
 * Memory remains human-readable Markdown in OPFS, but entries are stored as
 * small records with ids and metadata so the agent can update, search, and
 * compact them instead of endlessly appending text.
 */

import {
  readMemoryFile,
  writeMemoryFile,
  deleteMemoryFile,
  readAgentMemoryFile,
  writeAgentMemoryFile,
  deleteAgentMemoryFile,
} from '../vfs/opfs.js';

export const MEMORY_MAX = 8000;
export const USER_MAX = 4000;

const MEMORY_PROMPT_MAX = 3600;
const USER_PROMPT_MAX = 1800;
const ENTRY_MAX = 1200;
const USER_ENTRY_MAX = 800;
const DELIMITER = '§';
const DOC_MARKER = '<!-- vertex-memory:v2 -->';
const MEMORY_FILE = 'MEMORY.md';
const USER_FILE = 'USER.md';

const FILES = {
  memory: {
    filename: MEMORY_FILE,
    title: 'Project Memory',
    maxChars: MEMORY_MAX,
    promptMax: MEMORY_PROMPT_MAX,
    entryMax: ENTRY_MAX,
  },
  user: {
    filename: USER_FILE,
    title: 'User Memory',
    maxChars: USER_MAX,
    promptMax: USER_PROMPT_MAX,
    entryMax: USER_ENTRY_MAX,
  },
};

/**
 * Load both memory files. Returns compact prompt strings plus parsed records.
 * @param {string} [agentId]
 * @returns {Promise<{ memory: string|null, user: string|null, records: { memory: Array, user: Array } }>}
 */
export async function loadMemory(agentId) {
  const [memoryRaw, userRaw] = await Promise.all([
    readMemoryDocument('memory', agentId),
    readMemoryDocument('user', agentId),
  ]);

  const memoryRecords = parseMemoryDocument(memoryRaw, 'memory');
  const userRecords = parseMemoryDocument(userRaw, 'user');

  return {
    memory: formatPromptRecords(memoryRecords, FILES.memory.promptMax),
    user: formatPromptRecords(userRecords, FILES.user.promptMax),
    records: {
      memory: memoryRecords,
      user: userRecords,
    },
  };
}

/**
 * Add or update a project/workspace memory note.
 * @param {string} content
 * @param {string} [agentId]
 * @param {{ id?: string, tags?: Array<string>|string, importance?: string }} [options]
 */
export async function saveMemory(content, agentId, options = {}) {
  return upsertMemoryEntry({ ...options, type: 'memory', content }, agentId);
}

/**
 * Add or update a user preference/profile memory note.
 * @param {string} content
 * @param {string} [agentId]
 * @param {{ id?: string, tags?: Array<string>|string, importance?: string }} [options]
 */
export async function saveUser(content, agentId, options = {}) {
  return upsertMemoryEntry({ ...options, type: 'user', content }, agentId);
}

/**
 * Add or update a structured memory entry.
 * @param {{ type?: string, content: string, id?: string, tags?: Array<string>|string, importance?: string }} entry
 * @param {string} [agentId]
 * @returns {Promise<Object>}
 */
export async function upsertMemoryEntry(entry, agentId) {
  const type = normalizeMemoryType(entry.type);
  const spec = FILES[type];
  const content = cleanContent(entry.content, spec.entryMax);
  if (!content) throw new Error('Memory content is required.');

  const existing = parseMemoryDocument(await readMemoryDocument(type, agentId), type);
  const now = new Date().toISOString();
  const tags = normalizeTags(entry.tags);
  const importance = normalizeImportance(entry.importance);
  const requestedId = normalizeId(entry.id);
  const index = requestedId ? existing.findIndex((record) => record.id === requestedId) : -1;

  let record;
  if (index >= 0) {
    record = {
      ...existing[index],
      content,
      tags,
      importance,
      updatedAt: now,
    };
    existing[index] = record;
  } else {
    record = {
      id: requestedId || createMemoryId(type),
      type,
      content,
      tags,
      importance,
      createdAt: now,
      updatedAt: now,
    };
    existing.push(record);
  }

  const compacted = compactRecords(existing, spec.maxChars, type);
  await writeMemoryDocument(type, formatMemoryDocument(compacted, spec.title), agentId);
  return record;
}

/**
 * List/search memory records.
 * @param {{ type?: string, query?: string, maxEntries?: number }} [options]
 * @param {string} [agentId]
 * @returns {Promise<Array<Object>>}
 */
export async function listMemoryEntries(options = {}, agentId) {
  const type = options.type || 'both';
  const query = String(options.query || '').trim().toLowerCase();
  const maxEntries = clampNumber(options.maxEntries, 1, 50, 20);
  const types = type === 'both' ? ['memory', 'user'] : [normalizeMemoryType(type)];
  const groups = await Promise.all(
    types.map(async (kind) => parseMemoryDocument(await readMemoryDocument(kind, agentId), kind))
  );
  let records = groups.flat();
  if (query) {
    records = records
      .map((record) => ({ record, score: scoreMemoryRecord(record, query) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || compareRecords(a.record, b.record))
      .map((item) => item.record);
  } else {
    records.sort(compareRecords);
  }
  return records.slice(0, maxEntries);
}

/**
 * Delete one memory entry by id.
 * @param {string} type
 * @param {string} id
 * @param {string} [agentId]
 */
export async function deleteMemoryEntry(type, id, agentId) {
  const normalizedType = normalizeMemoryType(type);
  const normalizedId = normalizeId(id);
  if (!normalizedId) throw new Error('Memory id is required.');
  const spec = FILES[normalizedType];
  const existing = parseMemoryDocument(await readMemoryDocument(normalizedType, agentId), normalizedType);
  const next = existing.filter((record) => record.id !== normalizedId);
  if (next.length === existing.length) return false;
  await writeMemoryDocument(normalizedType, formatMemoryDocument(next, spec.title), agentId);
  return true;
}

/**
 * Clear one or both memory files.
 * @param {string} type - 'memory', 'user', or 'both'
 * @param {string} [agentId]
 */
export async function clearMemory(type = 'both', agentId) {
  const normalized = type === 'both' ? 'both' : normalizeMemoryType(type);
  if (normalized === 'memory' || normalized === 'both') {
    if (agentId) await deleteAgentMemoryFile(agentId, MEMORY_FILE);
    else await deleteMemoryFile(MEMORY_FILE);
  }
  if (normalized === 'user' || normalized === 'both') {
    if (agentId) await deleteAgentMemoryFile(agentId, USER_FILE);
    else await deleteMemoryFile(USER_FILE);
  }
}

/**
 * Build the memory section for the system prompt.
 * @param {{ memory: string|null, user: string|null }} snapshot
 * @returns {string}
 */
export function buildMemorySection(snapshot) {
  if (!snapshot) return '';
  const sections = [];
  if (snapshot.memory) {
    sections.push(`<project_memory>\n${snapshot.memory}\n</project_memory>`);
  }
  if (snapshot.user) {
    sections.push(`<user_memory>\n${snapshot.user}\n</user_memory>`);
  }
  if (!sections.length) return '';
  return [
    '<memory_context>',
    'These memory notes are stored in browser OPFS with the agent workspace, not in the sandbox runtime and not inside workspace/<active-agent>/files/. Use memory tools to manage them; do not try to edit memory by browser file path. Use them when relevant. They may be incomplete or stale; verify with tools when accuracy matters.',
    ...sections,
    '</memory_context>',
  ].join('\n');
}

// ─── File IO ────────────────────────────────────────────────────────────────

async function readMemoryDocument(type, agentId) {
  const filename = FILES[type].filename;
  return agentId ? readAgentMemoryFile(agentId, filename) : readMemoryFile(filename);
}

async function writeMemoryDocument(type, content, agentId) {
  const filename = FILES[type].filename;
  if (agentId) await writeAgentMemoryFile(agentId, filename, content);
  else await writeMemoryFile(filename, content);
}

// ─── Parsing and formatting ─────────────────────────────────────────────────

function parseMemoryDocument(content, type) {
  const text = String(content || '').trim();
  if (!text) return [];
  if (!text.includes(DOC_MARKER)) return parseLegacyMemory(text, type);

  const records = [];
  const recordRe = /^##\s+([^\n]+)\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/gm;
  let match;
  while ((match = recordRe.exec(text)) !== null) {
    const id = normalizeId(match[1]);
    const body = match[2].trim();
    if (!id || !body) continue;
    const { meta, content: recordContent } = splitRecordBody(body);
    const cleaned = cleanContent(recordContent, FILES[type].entryMax);
    if (!cleaned) continue;
    records.push({
      id,
      type,
      content: cleaned,
      tags: normalizeTags(meta.tags),
      importance: normalizeImportance(meta.importance),
      createdAt: normalizeDate(meta.created) || normalizeDate(meta.createdAt) || new Date(0).toISOString(),
      updatedAt: normalizeDate(meta.updated) || normalizeDate(meta.updatedAt) || normalizeDate(meta.created) || new Date(0).toISOString(),
    });
  }

  return dedupeRecords(records, type);
}

function parseLegacyMemory(text, type) {
  return text
    .split(DELIMITER)
    .map((entry) => cleanContent(entry, FILES[type].entryMax))
    .filter(Boolean)
    .map((content, index) => {
      const createdAt = new Date(0 + index).toISOString();
      return {
        id: createMemoryId(type, index),
        type,
        content,
        tags: [],
        importance: 'normal',
        createdAt,
        updatedAt: createdAt,
      };
    });
}

function splitRecordBody(body) {
  const lines = body.split('\n');
  const meta = {};
  let contentStart = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      contentStart = i + 1;
      break;
    }
    const separator = line.indexOf(':');
    if (separator <= 0) {
      contentStart = i;
      break;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    meta[key] = value;
    contentStart = i + 1;
  }

  return {
    meta,
    content: lines.slice(contentStart).join('\n').trim(),
  };
}

function formatMemoryDocument(records, title) {
  const body = [...records]
    .sort(compareRecords)
    .map((record) => [
      `## ${record.id}`,
      `created: ${record.createdAt}`,
      `updated: ${record.updatedAt}`,
      `importance: ${record.importance}`,
      `tags: ${record.tags.join(', ')}`,
      '',
      record.content.trim(),
    ].join('\n'))
    .join('\n\n');

  return [`# ${title}`, DOC_MARKER, '', body].filter(Boolean).join('\n').trim() + '\n';
}

function formatPromptRecords(records, maxChars) {
  if (!records?.length) return null;
  const lines = [...records]
    .sort(compareRecords)
    .map((record) => {
      const tags = record.tags.length ? ` tags=${record.tags.join(',')}` : '';
      return `- (${record.id}; ${record.importance}${tags}) ${record.content}`;
    });

  const out = [];
  let total = 0;
  for (const line of lines) {
    const addition = line.length + 1;
    if (total + addition > maxChars) break;
    out.push(line);
    total += addition;
  }
  return out.length ? out.join('\n') : null;
}

// ─── Compaction and scoring ─────────────────────────────────────────────────

function compactRecords(records, maxChars, type) {
  let next = dedupeRecords(records, type);
  let doc = formatMemoryDocument(next, FILES[type].title);
  if (doc.length <= maxChars) return next;

  const removalOrder = [...next].sort((a, b) => {
    const byImportance = importanceWeight(a.importance) - importanceWeight(b.importance);
    if (byImportance !== 0) return byImportance;
    return Date.parse(a.updatedAt || 0) - Date.parse(b.updatedAt || 0);
  });

  for (const record of removalOrder) {
    if (next.length <= 1) break;
    next = next.filter((item) => item.id !== record.id);
    doc = formatMemoryDocument(next, FILES[type].title);
    if (doc.length <= maxChars) break;
  }

  return next;
}

function dedupeRecords(records, type) {
  const byId = new Map();
  for (const record of records) {
    const id = normalizeId(record.id);
    const content = cleanContent(record.content, FILES[type].entryMax);
    if (!id || !content) continue;
    const existing = byId.get(id);
    const normalized = {
      ...record,
      id,
      type,
      content,
      tags: normalizeTags(record.tags),
      importance: normalizeImportance(record.importance),
      createdAt: normalizeDate(record.createdAt) || new Date(0).toISOString(),
      updatedAt: normalizeDate(record.updatedAt) || normalizeDate(record.createdAt) || new Date(0).toISOString(),
    };
    if (!existing || Date.parse(normalized.updatedAt) >= Date.parse(existing.updatedAt)) {
      byId.set(id, normalized);
    }
  }
  return Array.from(byId.values());
}

function scoreMemoryRecord(record, query) {
  const haystack = `${record.id} ${record.type} ${record.importance} ${record.tags.join(' ')} ${record.content}`.toLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  if (!terms.length) return 1;
  let score = 0;
  for (const term of terms) {
    if (record.id.toLowerCase() === term) score += 6;
    if (record.tags.some((tag) => tag.toLowerCase() === term)) score += 4;
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

function compareRecords(a, b) {
  const byImportance = importanceWeight(b.importance) - importanceWeight(a.importance);
  if (byImportance !== 0) return byImportance;
  return Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0);
}

function importanceWeight(value) {
  if (value === 'high') return 3;
  if (value === 'low') return 1;
  return 2;
}

// ─── Normalization ──────────────────────────────────────────────────────────

function normalizeMemoryType(type) {
  return type === 'user' ? 'user' : 'memory';
}

function normalizeImportance(value) {
  return ['low', 'normal', 'high'].includes(value) ? value : 'normal';
}

function normalizeTags(tags) {
  const raw = Array.isArray(tags) ? tags : String(tags || '').split(',');
  return Array.from(new Set(raw
    .map((tag) => String(tag).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-'))
    .filter(Boolean)))
    .slice(0, 8);
}

function normalizeId(id) {
  const value = String(id || '').trim();
  if (!value) return '';
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function normalizeDate(value) {
  const parsed = Date.parse(value || '');
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function cleanContent(content, maxChars) {
  const cleaned = String(content || '').replace(/\r\n/g, '\n').trim();
  if (!cleaned) return '';
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars).trim() : cleaned;
}

function createMemoryId(type, salt = '') {
  const random = globalThis.crypto?.randomUUID?.().slice(0, 8)
    || Math.random().toString(36).slice(2, 10);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${type}_${stamp}_${salt ? `${salt}_` : ''}${random}`;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}
