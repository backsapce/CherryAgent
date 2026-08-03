import config from '../config/config.js';
import {
  deleteEmptyPathTree,
  deletePath,
  deletePathNonRecursive,
  hashBlob,
  listOpfsFiles,
  readPathBlob,
  readPathBytes,
  readPathText,
  registerOpfsSyncHook,
  writePathBlob,
  writePathBytes,
  writePathText,
} from '../vfs/opfs.js';
import {
  createS3Backend,
  isConditionalRequestUnsupported,
  isConditionalWriteConflictError,
  isPreconditionFailed,
  objectKey,
} from './s3Backend.js';
import { normalizeProviderConfig, normalizeProviderPreset } from './providerPresets.js';
import {
  formatStructuredContent,
  isStructuredPath,
  mergeStructuredThreeWay,
  mergeStructuredUpdates,
  parseStructuredContent,
  readStructuredUpdate,
  createStructuredUpdate,
} from './yjsMerge.js';

const MANIFEST_FILE = 'manifest.v3.json';
const LEGACY_MANIFEST_FILE = 'manifest.json';
const LEGACY_AUTHORITY_MARKER_FILE = 'authority.json';
const AUTHORITY_MARKER_DIR = 'authority';
const MANIFEST_SHARD_DIR = 'manifests';
const STATE_FILE = '.sync/state.json';
const STRUCTURED_BASE_DIR = '.sync/bases';
const AUTO_DEBOUNCE_MS = 3000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;
const MAX_CONCURRENT_REQUESTS = 8;
const MAX_MANIFEST_COMMIT_ATTEMPTS = 3;
const MAX_MANIFEST_FILES = 20_000;
const MAX_MANIFEST_SHARDS = 128;
const MAX_LISTED_MANIFEST_SHARDS = 512;
const MAX_AGGREGATE_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_OBJECT_BYTES = 16 * 1024 * 1024;
const MAX_STRUCTURED_CANDIDATES = 32;
const MAX_REMOTE_PAYLOAD_BYTES = 512 * 1024 * 1024;
const MAX_PAYLOAD_DEDUPE_CACHE_BYTES = 64 * 1024 * 1024;
// Version 3 keeps storage/E2B credentials local, but intentionally includes
// LLM API keys so a restored profile is immediately usable on another client.
const CONFIG_REDACTION_VERSION = 3;
const LARGE_FILE_BYTES = 16 * 1024 * 1024;
const VERY_LARGE_FILE_BYTES = 64 * 1024 * 1024;
// WebCrypto hashing and S3 response handling materialize payloads as
// ArrayBuffers. Keep their combined working set bounded as well as limiting
// the raw request count; otherwise several medium files can exhaust a browser
// process even though none of them crosses the "large file" threshold.
const MAX_CONCURRENT_PAYLOAD_BYTES = 32 * 1024 * 1024;
const CONSTRAINED_MAX_CONCURRENT_PAYLOAD_BYTES = 12 * 1024 * 1024;
const CONSTRAINED_MAX_CONCURRENT_REQUESTS = 2;
const SHARD_ATTEMPT_ID_HEX_LENGTH = 16;

let unsubscribeHook = null;
let intervalId = null;
let debounceId = null;
let activeRun = null;
let pendingAutoSync = false;
let autoRefreshCallback = null;
let autoBeforeSyncCallback = null;
let autoSyncSuspendDepth = 0;
let autoRunInProgress = false;
let activeAutoCompletion = null;
let stateWriteQueue = Promise.resolve();
const statusListeners = new Set();
const backendNamespaceCache = new Map();
const structuredBaseLegacyNamespaces = new Map();
const conditionalDeleteCapabilities = new Map();
const persistedStateSnapshots = new WeakMap();
let syncBackendFactory = createS3Backend;

function isMissingLocalPathError(error) {
  return error?.name === 'NotFoundError'
    || /(?:file|entry|directory) not found/i.test(String(error?.message || ''));
}

function isLocalPathTypeMismatchError(error) {
  return error?.name === 'TypeMismatchError'
    || /(?:is not a file|not a file|is a directory)/i.test(String(error?.message || ''));
}

export function getSyncStatus() {
  return {
    syncing: Boolean(activeRun || autoRunInProgress),
    queued: pendingAutoSync,
  };
}

function notifySyncStatus() {
  const status = getSyncStatus();
  for (const listener of statusListeners) {
    try { listener(status); } catch (err) { console.warn('Sync status listener failed:', err); }
  }
}

export function subscribeSyncStatus(listener) {
  statusListeners.add(listener);
  listener(getSyncStatus());
  return () => statusListeners.delete(listener);
}

function statsChangedLocal(stats) {
  return Boolean(stats && (
    stats.downloaded > 0 ||
    stats.merged > 0 ||
    stats.deleted > 0
  ));
}

export function syncResultChangedLocal(result) {
  if (!result || result === true) return false;
  if (result.pulled || result.pushed) {
    return statsChangedLocal(result.pulled) || statsChangedLocal(result.pushed);
  }
  return statsChangedLocal(result);
}

function maxConcurrentRequests(syncConfig = {}) {
  const requested = Number(syncConfig.maxConcurrentRequests);
  const configured = !Number.isFinite(requested)
    ? DEFAULT_MAX_CONCURRENT_REQUESTS
    : Math.min(MAX_CONCURRENT_REQUESTS, Math.max(1, Math.floor(requested)));
  return isConstrainedSyncDevice()
    ? Math.min(CONSTRAINED_MAX_CONCURRENT_REQUESTS, configured)
    : configured;
}

function isConstrainedSyncDevice() {
  const navigatorInfo = globalThis.navigator;
  const deviceMemory = Number(navigatorInfo?.deviceMemory);
  const hardwareConcurrency = Number(navigatorInfo?.hardwareConcurrency);
  if (Number.isFinite(deviceMemory) && deviceMemory > 0 && deviceMemory <= 4) return true;
  if (Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0 && hardwareConcurrency <= 4) return true;
  try {
    return Boolean(globalThis.matchMedia?.('(max-width: 768px) and (pointer: coarse)').matches);
  } catch {
    return false;
  }
}

function maxConcurrentRequestsForEntries(syncConfig = {}, entries = []) {
  const configured = maxConcurrentRequests(syncConfig);
  const payloadBudget = isConstrainedSyncDevice()
    ? CONSTRAINED_MAX_CONCURRENT_PAYLOAD_BYTES
    : MAX_CONCURRENT_PAYLOAD_BYTES;
  const largest = entries.reduce((max, entry) => Math.max(max, Number(entry?.size) || 0), 0);
  if (largest >= VERY_LARGE_FILE_BYTES) return 1;
  if (largest > 0) {
    return Math.min(
      largest >= LARGE_FILE_BYTES ? 2 : configured,
      configured,
      Math.max(1, Math.floor(payloadBudget / largest))
    );
  }
  return configured;
}

function remoteTransferSize(entry = {}) {
  if (!entry.structured) {
    return entry.size == null ? VERY_LARGE_FILE_BYTES : (Number(entry.size) || 0);
  }
  const candidates = structuredCandidateEntries(entry);
  const seenBases = new Set();
  let total = 0;
  for (const candidate of candidates) {
    if (!candidate.payloadHash || !Number.isSafeInteger(Number(candidate.payloadSize))) {
      return VERY_LARGE_FILE_BYTES;
    }
    total += Number(candidate.payloadSize);
    if (candidate.baseYjsKey && !seenBases.has(candidate.baseYjsKey)) {
      if (!candidate.basePayloadHash || !Number.isSafeInteger(Number(candidate.basePayloadSize))) {
        return VERY_LARGE_FILE_BYTES;
      }
      seenBases.add(candidate.baseYjsKey);
      total += Number(candidate.basePayloadSize);
    }
    if (total >= VERY_LARGE_FILE_BYTES) return total;
  }
  return total;
}

function localTransferSize(path, entry = {}) {
  if (!isStructuredPath(path)) return Number(entry.size) || 0;
  // Tree-encoded Yjs updates can be much larger than scalar-heavy JSON/YAML.
  // A conservative pre-encoding weight prevents several large allocations
  // from being built concurrently before their exact payload sizes are known.
  return Math.min(
    MAX_REMOTE_PAYLOAD_BYTES,
    (Number(entry.size) || 0) * 32 + 1024 * 1024
  );
}

async function mapWithConcurrency(items, mapper, concurrency = DEFAULT_MAX_CONCURRENT_REQUESTS) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let firstError = null;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  async function worker() {
    while (!firstError && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await mapper(items[index], index);
      } catch (err) {
        firstError ||= err;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError) throw firstError;
  return results;
}

function encodePath(path) {
  const bytes = new TextEncoder().encode(String(path));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function legacyObjectPath(path, hash = null) {
  const encoded = `objects/${encodePath(path)}`;
  return hash ? `${encoded}/${hash}` : encoded;
}

function legacyYjsPath(path, hash = null) {
  const encoded = `yjs/${encodePath(path)}`;
  return hash ? `${encoded}/${hash}.bin` : `${encoded}.bin`;
}

function objectPath(path, hash = null) {
  if (!hash) return legacyObjectPath(path);
  // The manifest retains the original path, so embedding it in every payload
  // key only wastes bytes and can breach S3's 1,024-byte key ceiling. Hash-only
  // keys are fixed-size, content-addressed, and deduplicate identical files.
  return `objects/by-hash/${String(hash).slice(0, 2)}/${hash}`;
}

function yjsPath(path, hash = null) {
  if (!hash) return legacyYjsPath(path);
  return `yjs/by-hash/${String(hash).slice(0, 2)}/${hash}.bin`;
}

function matchesContentAddressedKey(syncConfig, type, path, hash, key) {
  if (!hash || typeof key !== 'string') return false;
  const paths = type === 'yjs'
    ? [yjsPath(path, hash), legacyYjsPath(path, hash)]
    : [objectPath(path, hash), legacyObjectPath(path, hash)];
  return paths.some((candidate) => key === objectKey(syncConfig, candidate));
}

function normalizeEndpoint(endpoint) {
  const value = String(endpoint || '').trim().replace(/\/+$/g, '');
  if (!value) return '';
  try {
    const parsed = new URL(value);
    const origin = `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}`;
    return `${origin}${parsed.pathname.replace(/\/+$/g, '')}${parsed.search}${parsed.hash}`;
  } catch {
    // Preserve case in custom proxy paths even when the endpoint is not a URL.
    return value;
  }
}

export function syncBackendIdentity(syncConfig = {}) {
  const normalized = normalizeProviderConfig(syncConfig);
  return JSON.stringify([
    normalized.providerPreset,
    normalizeEndpoint(normalized.endpoint),
    String(normalized.region || 'us-east-1').trim().toLowerCase(),
    // A bucket endpoint (for example an OSS CNAME) already identifies the
    // bucket in its host. Keeping an ignored bucket field in the namespace
    // identity would strand state and caches when that cosmetic value changes.
    normalized.bucketEndpoint ? null : String(normalized.bucket || '').trim(),
    String(normalized.prefix || '').replace(/^\/+|\/+$/g, ''),
    Boolean(normalized.forcePathStyle),
    Boolean(normalized.bucketEndpoint),
  ]);
}

function syncCredentialScope(syncConfig = {}) {
  const normalized = normalizeProviderConfig(syncConfig);
  return JSON.stringify([
    syncBackendIdentity(normalized),
    String(normalized.accessKeyId || '').trim(),
  ]);
}

async function namespaceDigest(identity) {
  let namespace = backendNamespaceCache.get(identity);
  if (!namespace) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
    namespace = [...new Uint8Array(digest)]
      .slice(0, 16)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    backendNamespaceCache.set(identity, namespace);
  }
  return namespace;
}

async function structuredBaseNamespace(syncConfig) {
  return namespaceDigest(syncBackendIdentity(syncConfig));
}

async function structuredBasePath(path, syncConfig) {
  const namespace = await structuredBaseNamespace(syncConfig);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(path)));
  const pathHash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${STRUCTURED_BASE_DIR}/${namespace}/${pathHash}.bin`;
}

async function structuredBaseCandidatePaths(path, syncConfig) {
  const backendId = syncBackendIdentity(syncConfig);
  const namespaces = new Set([
    await structuredBaseNamespace(syncConfig),
    ...(structuredBaseLegacyNamespaces.get(backendId) || []),
  ]);
  const pathDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(path)));
  const pathHash = [...new Uint8Array(pathDigest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return [...namespaces].flatMap((namespace) => [
    `${STRUCTURED_BASE_DIR}/${namespace}/${pathHash}.bin`,
    `${STRUCTURED_BASE_DIR}/${namespace}/${encodePath(path)}.bin`,
  ]);
}

function isSafeSyncPath(path) {
  if (typeof path !== 'string' || !path || path !== normalizeSyncPath(path)) return false;
  if ([...path].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) return false;
  const parts = path.split('/');
  return path.length <= 4096
    && parts[0] !== '.sync'
    && parts.every((part) => (
      part
      && part !== '.'
      && part !== '..'
    ));
}

function assertSafeSyncPath(path) {
  if (!isSafeSyncPath(path)) throw new Error(`Remote manifest contains an unsafe path: ${String(path)}`);
  return path;
}

function sessionIdFromMessagesPath(path) {
  return /^(?:sessions|messages)\/([^/]+)\.json$/.exec(path)?.[1] || null;
}

function agentIdFromWorkspacePath(path) {
  return /^workspace\/([^/]+)(?:\/|$)/.exec(path)?.[1] || null;
}

function agentIdFromWorkspaceRootPath(path) {
  return /^workspace\/([^/]+)$/.exec(path)?.[1] || null;
}

function isSessionMessagesPath(path) {
  return Boolean(sessionIdFromMessagesPath(path));
}

function isAgentWorkspacePath(path) {
  return Boolean(agentIdFromWorkspacePath(path));
}

function isPathOrChild(path, parentPath) {
  return path === parentPath || path.startsWith(`${parentPath}/`);
}

function normalizeSyncPath(path) {
  return String(path || '').split('/').filter(Boolean).join('/');
}

function restoredPathCandidates(path) {
  const parts = normalizeSyncPath(path).split('/').filter(Boolean);
  const candidates = [];
  for (let i = 1; i <= parts.length; i += 1) {
    candidates.push(parts.slice(0, i).join('/'));
  }
  return candidates;
}

function makeRestoreEntry(previous = {}, revisionBy = null) {
  const restoredAt = nowIso();
  return {
    deleted: false,
    restored: true,
    restoredAt,
    updatedAt: restoredAt,
    revision: nextEntryRevision(previous),
    revisionBy,
  };
}

function clearDeletedPathCandidates(files = {}, path, options = {}) {
  let changed = false;
  for (const candidate of restoredPathCandidates(path)) {
    if (files[candidate]?.deleted) {
      const deletedEntry = files[candidate];
      options.restoredEntries?.push(deletedEntry);
      if (options.preserveRestoreMarkers) {
        files[candidate] = makeRestoreEntry(deletedEntry, options.revisionBy);
      } else {
        delete files[candidate];
      }
      changed = true;
    }
  }
  return changed;
}

function hasDeletedAncestor(files = {}, path) {
  return Boolean(findDeletedAncestor(files, path));
}

function collectDeletedSessionIds(files = {}) {
  const ids = new Set();
  for (const [path, entry] of Object.entries(files || {})) {
    if (!entry?.deleted) continue;
    const id = sessionIdFromMessagesPath(path);
    if (id) ids.add(id);
  }
  return ids;
}

function collectDeletedPaths(files = {}) {
  const paths = new Set();
  for (const [path, entry] of Object.entries(files || {})) {
    if (entry?.deleted) paths.add(path);
  }
  return paths;
}

function acknowledgeManifestTombstones(stateFiles = {}, manifestFiles = {}) {
  for (const [path, entry] of Object.entries(stateFiles || {})) {
    if (!entry?.deleted) continue;
    const deletion = findDeletedAncestor(manifestFiles, path, true);
    if (!deletion) continue;
    entry.remoteDeleted = true;
    entry.remoteRevision = entryRevision(deletion.entry);
    entry.remoteUpdatedAt = deletion.entry.updatedAt || entry.remoteUpdatedAt || null;
    entry.remoteHash = deletion.entry.hash || entry.remoteHash || null;
    entry.remoteFingerprint = remoteEntryFingerprint(deletion.entry);
  }
}

function collectDeletedAgentIds(files = {}) {
  const ids = new Set();
  for (const [path, entry] of Object.entries(files || {})) {
    if (!entry?.deleted) continue;
    const id = agentIdFromWorkspaceRootPath(path);
    if (id) ids.add(id);
  }
  return ids;
}

function pruneDeletedSessions(data, deletedSessionIds) {
  if (deletedSessionIds.size === 0) return data;

  if (Array.isArray(data)) {
    return data.filter((session) => !deletedSessionIds.has(String(session?.id)));
  }

  if (data && typeof data === 'object' && Array.isArray(data.sessions)) {
    return {
      ...data,
      sessions: data.sessions.filter((session) => !deletedSessionIds.has(String(session?.id))),
    };
  }

  return data;
}

function pruneDeletedAgents(data, deletedAgentIds) {
  if (deletedAgentIds.size === 0) return data;
  if (!data || typeof data !== 'object' || !Array.isArray(data.agentsList)) return data;

  return {
    ...data,
    agentsList: data.agentsList.filter((agent) => !deletedAgentIds.has(String(agent?.id))),
  };
}

function collectDeletedLlmIds(data) {
  const ids = [
    ...(Array.isArray(data?.llm?.deletedLlmIds) ? data.llm.deletedLlmIds : []),
    // Pre-v2 clients called LLM records "profiles". Keep consuming their
    // tombstones so an upgrade cannot resurrect a deleted model binding.
    ...(Array.isArray(data?.llm?.deletedProfileIds) ? data.llm.deletedProfileIds : []),
  ];
  return new Set(ids.map((id) => String(id)).filter(Boolean));
}

function collectDeletedLlmProviderIds(data) {
  const ids = data?.llm?.deletedProviderIds;
  if (!Array.isArray(ids)) return new Set();
  return new Set(ids.map((id) => String(id)).filter(Boolean));
}

function mergeSets(...sets) {
  const merged = new Set();
  for (const set of sets) {
    for (const value of set || []) merged.add(value);
  }
  return merged;
}

function pruneDeletedLlmRecords(data, deletedLlmIds, deletedProviderIds) {
  if (deletedLlmIds.size === 0 && deletedProviderIds.size === 0) return data;
  if (!data || typeof data !== 'object' || !data.llm || typeof data.llm !== 'object') return data;

  const llms = data.llm.llms && typeof data.llm.llms === 'object'
    ? { ...data.llm.llms }
    : data.llm.llms;
  if (llms && typeof llms === 'object' && !Array.isArray(llms)) {
    for (const id of deletedLlmIds) delete llms[id];
  }

  // Also prune the legacy map when merging with a pre-v2 snapshot.
  const profiles = data.llm.profiles && typeof data.llm.profiles === 'object'
    ? { ...data.llm.profiles }
    : data.llm.profiles;
  if (profiles && typeof profiles === 'object' && !Array.isArray(profiles)) {
    for (const id of deletedLlmIds) delete profiles[id];
  }

  const providers = data.llm.providers && typeof data.llm.providers === 'object'
    ? { ...data.llm.providers }
    : data.llm.providers;
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    for (const id of deletedProviderIds) delete providers[id];
  }

  const remainingLlmIds = llms && typeof llms === 'object' && !Array.isArray(llms)
    ? Object.keys(llms)
    : [];
  const remainingProfileIds = profiles && typeof profiles === 'object' && !Array.isArray(profiles)
    ? Object.keys(profiles)
    : [];
  const activeLlmId = deletedLlmIds.has(String(data.llm.activeLlmId))
    ? (remainingLlmIds[0] || null)
    : data.llm.activeLlmId;
  const activeProfileId = deletedLlmIds.has(String(data.llm.activeProfileId))
    ? (remainingProfileIds[0] || null)
    : data.llm.activeProfileId;

  return {
    ...data,
    llm: {
      ...data.llm,
      ...(Object.prototype.hasOwnProperty.call(data.llm, 'activeLlmId') ? { activeLlmId } : {}),
      ...(Object.prototype.hasOwnProperty.call(data.llm, 'activeProfileId') ? { activeProfileId } : {}),
      ...(Object.prototype.hasOwnProperty.call(data.llm, 'llms') ? { llms } : {}),
      ...(Object.prototype.hasOwnProperty.call(data.llm, 'profiles') ? { profiles } : {}),
      ...(Object.prototype.hasOwnProperty.call(data.llm, 'providers') ? { providers } : {}),
      ...(data.llm.schemaVersion === 2 || Object.prototype.hasOwnProperty.call(data.llm, 'deletedLlmIds')
        ? { deletedLlmIds: [...deletedLlmIds] }
        : { deletedProfileIds: [...deletedLlmIds] }),
      ...(data.llm.schemaVersion === 2 || Object.prototype.hasOwnProperty.call(data.llm, 'deletedProviderIds')
        ? { deletedProviderIds: [...deletedProviderIds] }
        : {}),
    },
  };
}

function collectDeletedRecordIds(path, ...records) {
  if (!(path === 'config.yaml' || path === 'config.yml' || path === 'config.json')) {
    return { llmIds: new Set(), providerIds: new Set() };
  }
  return {
    llmIds: mergeSets(...records.map((record) => collectDeletedLlmIds(record))),
    providerIds: mergeSets(...records.map((record) => collectDeletedLlmProviderIds(record))),
  };
}

function isConfigPath(path) {
  return path === 'config.yaml' || path === 'config.yml' || path === 'config.json';
}

function stripLocalOnlyConfig(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const next = { ...data };
  delete next.sync;
  delete next.selectedAgent;
  delete next.dismissedAgents;

  // Sandbox hosts and their agentTokens are portable configuration. Hosts are
  // referenced by synced agentsList[].sandboxUrl defaults, and another client
  // needs the matching token to authenticate. Keep only durable host metadata;
  // reachability remains device-local.
  if (Array.isArray(next.agents)) {
    next.agents = next.agents
      .filter((agent) => agent && typeof agent === 'object' && typeof agent.url === 'string')
      .map((agent) => ({
        url: agent.url,
        name: typeof agent.name === 'string' ? agent.name : agent.url,
      }));
  }

  if (next.e2b && typeof next.e2b === 'object' && !Array.isArray(next.e2b)) {
    next.e2b = { ...next.e2b };
    delete next.e2b.apiKey;
    if (Object.keys(next.e2b).length === 0) delete next.e2b;
  }

  return next;
}

function preserveLocalOnlyConfig(path, mergedData, localData = {}) {
  if (!isConfigPath(path) || !mergedData || typeof mergedData !== 'object' || Array.isArray(mergedData)) {
    return mergedData;
  }

  const next = stripLocalOnlyConfig(mergedData);
  if (!localData || typeof localData !== 'object' || Array.isArray(localData)) return next;

  for (const key of ['sync', 'selectedAgent', 'dismissedAgents']) {
    if (Object.prototype.hasOwnProperty.call(localData, key)) next[key] = localData[key];
  }

  if (localData.e2b && typeof localData.e2b === 'object' && !Array.isArray(localData.e2b)) {
    const remoteE2b = next.e2b && typeof next.e2b === 'object' && !Array.isArray(next.e2b)
      ? next.e2b
      : {};
    next.e2b = { ...remoteE2b };
    if (Object.prototype.hasOwnProperty.call(localData.e2b, 'apiKey')) {
      next.e2b.apiKey = localData.e2b.apiKey;
    }
  }

  return next;
}

function pruneDeletedRecords(path, data, deletedSessionIds, deletedAgentIds, deletedLlmRecords = {}) {
  let next = data;
  if (path === 'session.json') next = pruneDeletedSessions(next, deletedSessionIds);
  if (isConfigPath(path)) {
    next = pruneDeletedAgents(next, deletedAgentIds);
    // Accept the old Set-shaped internal argument for test/backward
    // compatibility while using independent v2 tombstones going forward.
    const suppliedLlmIds = deletedLlmRecords instanceof Set
      ? deletedLlmRecords
      : deletedLlmRecords.llmIds;
    const suppliedProviderIds = deletedLlmRecords instanceof Set
      ? new Set()
      : deletedLlmRecords.providerIds;
    next = pruneDeletedLlmRecords(
      next,
      mergeSets(suppliedLlmIds, collectDeletedLlmIds(next)),
      mergeSets(suppliedProviderIds, collectDeletedLlmProviderIds(next))
    );
  }
  return next;
}

function nowIso() {
  return new Date().toISOString();
}

function entryRevision(entry = {}) {
  const values = [entry?.revision, entry?.remoteRevision]
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value >= 0);
  return values.length ? Math.max(...values) : 0;
}

function nextEntryRevision(...entries) {
  const current = entries.reduce((max, entry) => Math.max(max, entryRevision(entry)), 0);
  if (current >= Number.MAX_SAFE_INTEGER) {
    throw new Error('The sync entry revision limit has been reached.');
  }
  return current + 1;
}

function randomId() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function randomShardAttemptId() {
  const uuidHex = globalThis.crypto?.randomUUID?.().replaceAll('-', '').toLowerCase() || '';
  if (/^[a-f\d]{32}$/.test(uuidHex)) return uuidHex.slice(0, SHARD_ATTEMPT_ID_HEX_LENGTH);
  const bytes = new Uint8Array(SHARD_ATTEMPT_ID_HEX_LENGTH / 2);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  let fallback = '';
  while (fallback.length < SHARD_ATTEMPT_ID_HEX_LENGTH) {
    fallback += Math.floor(Math.random() * 0x1_0000_0000).toString(16).padStart(8, '0');
  }
  return fallback.slice(0, SHARD_ATTEMPT_ID_HEX_LENGTH);
}

function safeFileIndex(value = {}) {
  const index = Object.create(null);
  for (const [path, entry] of Object.entries(value || {})) {
    Object.defineProperty(index, path, {
      value: entry,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return index;
}

function defaultManifest() {
  return { version: 2, integrityVersion: 3, updatedAt: nowIso(), files: safeFileIndex() };
}

function assertManifestCommitSize(manifest) {
  const fileCount = Object.keys(manifest?.files || {}).length;
  if (fileCount > MAX_MANIFEST_FILES) {
    throw new Error(
      `Sync manifest has ${fileCount} entries and exceeds the ${MAX_MANIFEST_FILES}-entry safety limit.`
    );
  }
  const bytes = new TextEncoder().encode(JSON.stringify(manifest)).byteLength;
  if (bytes > MAX_MANIFEST_OBJECT_BYTES) {
    throw new Error(
      `Sync manifest is ${bytes} bytes and exceeds the ${MAX_MANIFEST_OBJECT_BYTES}-byte safety limit.`
    );
  }
  return bytes;
}

function prospectiveManifestFileCount(manifestFiles, stateFiles, localFiles) {
  const paths = new Set(Object.keys(manifestFiles || {}));
  for (const path of localFiles?.keys?.() || []) {
    if (!findDeletedAncestor(stateFiles, path, true)) paths.add(path);
  }
  for (const [path, entry] of Object.entries(stateFiles || {})) {
    if (entry?.deleted && !findDeletedAncestor(stateFiles, path)) paths.add(path);
  }
  return paths.size;
}

function assertProspectiveManifestPathSize(manifestFiles, stateFiles, localFiles) {
  const files = safeFileIndex();
  for (const path of Object.keys(manifestFiles || {})) files[path] = {};
  for (const path of localFiles?.keys?.() || []) {
    if (!findDeletedAncestor(stateFiles, path, true)) files[path] ||= {};
  }
  for (const [path, entry] of Object.entries(stateFiles || {})) {
    if (entry?.deleted && !findDeletedAncestor(stateFiles, path)) files[path] ||= {};
  }
  // This deliberately serializes only paths and empty entry objects. Every
  // real entry adds metadata, so exceeding the limit here proves the final
  // manifest cannot be committed and lets us fail before uploading payloads.
  const minimumBytes = new TextEncoder().encode(JSON.stringify({ files })).byteLength;
  if (minimumBytes > MAX_MANIFEST_OBJECT_BYTES) {
    throw new Error(
      `Sync manifest paths alone require at least ${minimumBytes} bytes and exceed the `
      + `${MAX_MANIFEST_OBJECT_BYTES}-byte safety limit.`
    );
  }
  return minimumBytes;
}

function assertProspectiveManifestMetadataSize(
  manifest,
  stateFiles,
  localFiles,
  syncConfig,
  clientId = 'local-device',
  forceCommit = false
) {
  const files = safeFileIndex(manifest?.files || {});
  const hashPlaceholder = 'f'.repeat(64);
  const updatedAt = '9999-12-31T23:59:59.999Z';
  const revision = Number.MAX_SAFE_INTEGER;
  let projectedChange = Boolean(forceCommit);
  for (const [path, localEntry] of localFiles || []) {
    if (findDeletedAncestor(stateFiles, path, true)) continue;
    const structured = isStructuredPath(path);
    const existing = files[path];
    const previous = stateFiles?.[path];
    const alreadyCurrent = existing
      && !existing.deleted
      && !existing.restored
      && existing.hashType === 'content'
      && existing.hash === localEntry?.hash
      && previous?.hash === localEntry?.hash
      && Boolean(existing.structured) === structured
      && structuredCandidateEntries(existing).length <= 1
      && (!isConfigPath(path) || existing.redactionVersion === CONFIG_REDACTION_VERSION);
    if (alreadyCurrent) continue;
    projectedChange = true;
    const hash = /^[a-f\d]{64}$/i.test(String(localEntry?.hash || ''))
      ? localEntry.hash
      : hashPlaceholder;
    const common = {
      structured,
      deleted: false,
      hash,
      hashType: 'content',
      size: Number(localEntry?.size) || MAX_REMOTE_PAYLOAD_BYTES,
      updatedAt,
      revision,
      revisionBy: clientId,
    };
    const projected = structured
      ? {
        ...common,
        yjsKey: objectKey(syncConfig, yjsPath(path, hashPlaceholder)),
        payloadSize: MAX_REMOTE_PAYLOAD_BYTES,
        payloadHash: hashPlaceholder,
        baseYjsKey: objectKey(syncConfig, yjsPath(path, hashPlaceholder)),
        baseHash: hashPlaceholder,
        baseSize: MAX_REMOTE_PAYLOAD_BYTES,
        basePayloadSize: MAX_REMOTE_PAYLOAD_BYTES,
        basePayloadHash: hashPlaceholder,
        ...(isConfigPath(path)
          ? { redacted: true, redactionVersion: CONFIG_REDACTION_VERSION }
          : {}),
      }
      : {
        ...common,
        objectKey: objectKey(syncConfig, objectPath(path, hash)),
      };
    files[path] = JSON.stringify(existing || {}).length > JSON.stringify(projected).length
      ? existing
      : projected;
  }
  for (const [path, entry] of Object.entries(stateFiles || {})) {
    if (!entry?.deleted || findDeletedAncestor(stateFiles, path)) continue;
    projectedChange = true;
    const projected = makeDeleteEntry(entry, clientId);
    const existing = files[path];
    files[path] = JSON.stringify(existing || {}).length > JSON.stringify(projected).length
      ? existing
      : projected;
  }
  if (!projectedChange) return;
  // Keep a small envelope for top-level revision/causal metadata and JSON
  // representation differences. This deliberately errs on the safe side only
  // for manifests already within 64 KiB of the hard service/read ceiling.
  assertManifestCommitSize({
    ...manifest,
    version: 2,
    integrityVersion: 3,
    updatedAt,
    revision: 'x'.repeat(128),
    files,
    projectionSafetyMargin: 'x'.repeat(64 * 1024),
  });
}

function assertSyncConfigured(syncConfig) {
  const normalized = normalizeProviderConfig(syncConfig);
  if (!normalized.bucketEndpoint && !String(normalized.bucket || '').trim()) {
    throw new Error('Sync bucket is not configured.');
  }
  if (!String(normalized.accessKeyId || '').trim()) {
    throw new Error('Sync access key ID is not configured.');
  }
  if (!String(normalized.secretAccessKey || '')) {
    throw new Error('Sync secret access key is not configured.');
  }
  // Validate the longest production key, not only the much shorter
  // connection-test probe. S3 counts UTF-8 bytes and caps keys at 1,024.
  objectKey(normalized, `${MANIFEST_SHARD_DIR}/${'x'.repeat(128)}.json`);
  objectKey(normalized, yjsPath('key-validation.json', 'f'.repeat(64)));
  return normalized;
}

async function readJsonPath(path, fallback) {
  let text;
  try {
    text = await readPathText(path);
  } catch (error) {
    if (isMissingLocalPathError(error)) return fallback;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Sync state contains invalid JSON: ${path}`, { cause: error });
  }
}

async function writeJsonPath(path, data) {
  await writePathText(path, JSON.stringify(data), { internal: true });
}

function stateContentSnapshot(state) {
  const snapshot = { ...state };
  delete snapshot.lastSyncAt;
  return JSON.stringify(snapshot, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const ordered = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(ordered, key, {
        value: value[key],
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return ordered;
  });
}

function freshState(syncConfig = getSyncConfig()) {
  return {
    version: 2,
    backendId: syncBackendIdentity(syncConfig),
    credentialScope: syncCredentialScope(syncConfig),
    clientId: randomId(),
    shardGeneration: 0,
    shardCausalSeen: {},
    files: safeFileIndex(),
    manifestShards: {},
    pendingSensitiveDeletes: {},
    legacyStructuredBaseNamespaces: [],
    manifestMode: usesShardedManifest(syncConfig) ? 'sharded' : 'conditional',
    conditionalManifestEstablished: false,
    shardedManifestEstablished: false,
    pendingModeConfirmation: false,
    authorityMarkerVerified: false,
    conditionalWritesVerified: false,
    lastSyncAt: null,
  };
}

function validatePersistedState(state) {
  if (![1, 2].includes(Number(state.version))) {
    throw new Error('Sync state has an unsupported version; it was left untouched.');
  }
  if (!state.files || typeof state.files !== 'object' || Array.isArray(state.files)) {
    throw new Error('Sync state has an invalid files index; it was left untouched.');
  }
  const fileEntries = Object.entries(state.files);
  if (fileEntries.length > MAX_MANIFEST_FILES) {
    throw new Error(`Sync state exceeds the ${MAX_MANIFEST_FILES} file limit; it was left untouched.`);
  }
  for (const [path, entry] of fileEntries) {
    if (!isSafeSyncPath(path) || !entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Sync state has an invalid file entry; it was left untouched.');
    }
  }
  for (const field of ['manifestShards', 'pendingSensitiveDeletes']) {
    if (
      state[field] != null
      && (typeof state[field] !== 'object' || Array.isArray(state[field]))
    ) {
      throw new Error(`Sync state has an invalid ${field} index; it was left untouched.`);
    }
  }
  if (
    state.shardCausalSeen != null
    && (
      typeof state.shardCausalSeen !== 'object'
      || Array.isArray(state.shardCausalSeen)
      || Object.keys(state.shardCausalSeen).length > MAX_MANIFEST_SHARDS
      || Object.entries(state.shardCausalSeen).some(([clientId, generation]) => (
        !/^[A-Za-z0-9-]{1,128}$/.test(clientId)
        || !Number.isSafeInteger(Number(generation))
        || Number(generation) < 0
      ))
    )
  ) {
    throw new Error('Sync state has an invalid shard causal frontier; it was left untouched.');
  }
  for (const field of ['backendId', 'credentialScope', 'clientId', 'manifestMode']) {
    if (state[field] != null && typeof state[field] !== 'string') {
      throw new Error(`Sync state has an invalid ${field}; it was left untouched.`);
    }
  }
  if (
    state.legacyStructuredBaseNamespaces != null
    && (
      !Array.isArray(state.legacyStructuredBaseNamespaces)
      || state.legacyStructuredBaseNamespaces.some((value) => !/^[a-f\d]{32}$/i.test(value))
    )
  ) {
    throw new Error('Sync state has invalid structured-base migration metadata; it was left untouched.');
  }
  return state;
}

async function loadState(syncConfig = getSyncConfig()) {
  const fallback = freshState(syncConfig);
  const state = await readJsonPath(STATE_FILE, fallback);
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('Sync state must contain a JSON object; it was left untouched.');
  }
  if (state !== fallback) validatePersistedState(state);
  const persistedSnapshot = state === fallback ? null : stateContentSnapshot(state);

  const backendId = syncBackendIdentity(syncConfig);
  if (state.backendId && state.backendId !== backendId) return fallback;

  const credentialScope = syncCredentialScope(syncConfig);
  const credentialsChanged = Boolean(
    state.credentialScope
    && state.credentialScope !== credentialScope
  );
  const legacyStructuredBaseNamespaces = new Set(
    Array.isArray(state.legacyStructuredBaseNamespaces)
      ? state.legacyStructuredBaseNamespaces.filter((value) => /^[a-f\d]{32}$/i.test(value))
      : []
  );
  if (credentialsChanged && state.credentialScope) {
    legacyStructuredBaseNamespaces.add(await namespaceDigest(state.credentialScope));
  }
  if (legacyStructuredBaseNamespaces.size > 0) {
    structuredBaseLegacyNamespaces.set(backendId, legacyStructuredBaseNamespaces);
  } else {
    structuredBaseLegacyNamespaces.delete(backendId);
  }
  let files = state.files && typeof state.files === 'object' && !Array.isArray(state.files)
    ? safeFileIndex(state.files)
    : safeFileIndex();
  if (credentialsChanged) {
    const localFiles = safeFileIndex();
    for (const [path, entry] of Object.entries(files)) {
      if (!entry || entry.restored || (entry.deleted && entry.remoteDeleted)) continue;
      if (entry.deleted) {
        localFiles[path] = { ...entry, remoteDeleted: false };
        continue;
      }
      localFiles[path] = {
        hash: entry.hash || null,
        size: Number(entry.size) || 0,
        lastModified: Number(entry.lastModified) || 0,
        ...(entry.cachedHash ? { cachedHash: entry.cachedHash } : {}),
        ...(entry.cachedSize != null ? { cachedSize: Number(entry.cachedSize) || 0 } : {}),
        ...(entry.cachedLastModified != null
          ? { cachedLastModified: Number(entry.cachedLastModified) || 0 }
          : {}),
        ...(entry.cacheInvalidated ? { cacheInvalidated: true } : {}),
        deleted: false,
      };
    }
    files = localFiles;
  }

  const normalizedState = {
    ...state,
    version: 2,
    backendId,
    credentialScope,
    clientId: typeof state.clientId === 'string' && state.clientId ? state.clientId : randomId(),
    shardGeneration: Number.isSafeInteger(Number(state.shardGeneration))
      ? Math.max(0, Number(state.shardGeneration))
      : 0,
    shardCausalSeen: state.shardCausalSeen
      && typeof state.shardCausalSeen === 'object'
      && !Array.isArray(state.shardCausalSeen)
      ? mergeCausalVectors(state.shardCausalSeen)
      : {},
    files,
    manifestShards: !credentialsChanged
      && state.manifestShards && typeof state.manifestShards === 'object'
      && !Array.isArray(state.manifestShards)
      ? state.manifestShards
      : {},
    // Older versions queued immutable payload deletion locally. That GC is
    // intentionally retired because a concurrent shard can re-reference an
    // object after this client reads the manifest.
    pendingObjectDeletes: undefined,
    // Rotation changes authentication, not the destination. Retain durable
    // secret-cleanup intents so a successful scrub followed by a transient
    // delete failure cannot become a permanent orphan when keys are rotated.
    pendingSensitiveDeletes: state.pendingSensitiveDeletes
      && typeof state.pendingSensitiveDeletes === 'object'
      && !Array.isArray(state.pendingSensitiveDeletes)
      ? state.pendingSensitiveDeletes
      : {},
    manifestMode: state.manifestMode === 'sharded' ? 'sharded' : 'conditional',
    ...(credentialsChanged ? { manifestCache: undefined } : {}),
    conditionalWritesVerified: credentialsChanged ? false : Boolean(state.conditionalWritesVerified),
    conditionalManifestEstablished: Boolean(state.conditionalManifestEstablished),
    shardedManifestEstablished: state.shardedManifestEstablished == null
      ? Number(state.shardGeneration) > 0
      : Boolean(state.shardedManifestEstablished),
    pendingModeConfirmation: Boolean(state.pendingModeConfirmation),
    authorityMarkerVerified: Boolean(state.authorityMarkerVerified),
    legacyStructuredBaseNamespaces: [...legacyStructuredBaseNamespaces],
  };
  if (persistedSnapshot != null) persistedStateSnapshots.set(normalizedState, persistedSnapshot);
  return normalizedState;
}

async function saveState(state, syncConfig = getSyncConfig()) {
  state.version = 2;
  state.backendId = syncBackendIdentity(syncConfig);
  state.credentialScope = syncCredentialScope(syncConfig);
  state.clientId ||= randomId();
  state.manifestMode = usesShardedManifest(syncConfig) ? 'sharded' : 'conditional';
  const snapshot = stateContentSnapshot(state);
  if (persistedStateSnapshots.get(state) === snapshot) return false;
  state.lastSyncAt = nowIso();
  await writeJsonPath(STATE_FILE, state);
  persistedStateSnapshots.set(state, snapshot);
  return true;
}

function withStateLock(fn) {
  const run = stateWriteQueue.catch(() => {}).then(fn);
  stateWriteQueue = run.then(() => undefined, () => undefined);
  return run;
}

function rememberDeletedPaths(paths, syncConfig = getSyncConfig()) {
  return withBrowserSyncLock(syncConfig, () => withStateLock(async () => {
      const state = await loadState(syncConfig);
      for (const path of paths || []) {
        const childPaths = Object.keys(state.files || {}).filter((existingPath) => isPathOrChild(existingPath, path));
        const pathsToDelete = childPaths.length > 0 ? childPaths : [path];
        for (const pathToDelete of pathsToDelete) {
          state.files[pathToDelete] = {
            ...(state.files[pathToDelete] || {}),
            ...makeDeleteEntry(state.files[pathToDelete] || {}, state.clientId),
          };
        }
        state.files[path] = {
          ...(state.files[path] || {}),
          ...makeDeleteEntry(state.files[path] || {}, state.clientId),
        };
      }
      await saveState(state, syncConfig);
    }))
    .catch((err) => console.warn('Failed to record local delete for sync:', err));
}

function rememberRestoredPaths(paths) {
  const syncConfig = getSyncConfig();
  return withBrowserSyncLock(syncConfig, () => withStateLock(async () => {
      const state = await loadState(syncConfig);
      let changed = false;
      for (const path of paths || []) {
        changed = clearDeletedPathCandidates(state.files, path) || changed;
        for (const [existingPath, entry] of Object.entries(state.files || {})) {
          if (!isPathOrChild(existingPath, path) || !entry || entry.deleted) continue;
          // OPFS timestamps can have coarse resolution. A mutation notification
          // is stronger evidence than a size/mtime cache hit, so force one hash
          // before acknowledging the new local content.
          if (!entry.cacheInvalidated) {
            entry.cacheInvalidated = true;
            delete entry.cachedHash;
            delete entry.cachedSize;
            delete entry.cachedLastModified;
            changed = true;
          }
        }
      }
      if (changed) await saveState(state, syncConfig);
    }))
    .catch((err) => console.warn('Failed to record local restore for sync:', err));
}

function shouldRestoreLocalOverDeletedAncestor(localEntry, previous) {
  if (!localEntry) return false;
  if (!previous || previous.deleted) return true;
  return Boolean(previous.hash && previous.hash !== localEntry.hash);
}

function restoreLocalChangedPathsOverDeletedAncestors(
  stateFiles = {},
  manifestFiles = {},
  local = new Map(),
  options = {}
) {
  let changed = false;
  for (const [path, localEntry] of local) {
    const previous = stateFiles[path];
    const localDeletion = findDeletedAncestor(stateFiles, path, true);
    const remoteDeletion = findDeletedAncestor(manifestFiles, path, true);
    const hasLocalDeletedAncestor = Boolean(localDeletion);
    const hasRemoteDeletedAncestor = Boolean(remoteDeletion);
    const restoreRemote = hasRemoteDeletedAncestor && shouldRestoreLocalOverDeletedAncestor(localEntry, previous);

    if (!hasLocalDeletedAncestor && !restoreRemote) continue;

    const restoredEntries = [];
    changed = clearDeletedPathCandidates(stateFiles, path, {
      preserveRestoreMarkers: Boolean(options.preserveRestoreMarkers),
      revisionBy: options.revisionBy,
      restoredEntries,
    }) || changed;
    if (restoreRemote) {
      changed = clearDeletedPathCandidates(manifestFiles, path, {
        preserveRestoreMarkers: Boolean(options.preserveRestoreMarkers),
        revisionBy: options.revisionBy,
        restoredEntries,
      }) || changed;
    }
    if (restoredEntries.length > 0) options.restoredVersions?.set(path, restoredEntries);
  }
  return changed;
}

function canReuseLocalHash(entry, previous) {
  const cachedHash = previous?.cachedHash || previous?.hash;
  const cachedSize = previous?.cachedSize ?? previous?.size;
  const cachedLastModified = previous?.cachedLastModified ?? previous?.lastModified;
  return Boolean(
    previous
    && !previous.deleted
    && !previous.cacheInvalidated
    && cachedHash
    && Number(cachedSize) === Number(entry.size)
    && Number(cachedLastModified) === Number(entry.lastModified)
  );
}

async function localFileMap(state = { files: {} }, syncConfig = {}) {
  const entries = await listOpfsFiles({ hash: false, includeBlob: true });
  const oversized = entries.find((entry) => Number(entry.size) > MAX_REMOTE_PAYLOAD_BYTES);
  if (oversized) {
    throw new Error(`Sync file exceeds the 512 MiB safety limit: ${oversized.path}`);
  }
  const hydrated = await mapWithConcurrency(entries, async (entry) => {
    const previous = state.files?.[entry.path];
    return {
      ...entry,
      hash: canReuseLocalHash(entry, previous)
        ? (previous.cachedHash || previous.hash)
        : await hashBlob(entry.blob),
    };
  }, maxConcurrentRequestsForEntries(syncConfig, entries));
  return new Map(hydrated.map((entry) => [entry.path, entry]));
}

async function currentLocalEntry(path) {
  try {
    const file = await readPathBlob(path);
    return {
      path,
      size: file.size,
      lastModified: file.lastModified,
      hash: await hashBlob(file),
      blob: file,
    };
  } catch (error) {
    if (isMissingLocalPathError(error) || isLocalPathTypeMismatchError(error)) return null;
    throw error;
  }
}

async function hashBytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function truncateUtf8(value, maxBytes) {
  let result = '';
  let used = 0;
  for (const character of String(value || '')) {
    const bytes = new TextEncoder().encode(character).byteLength;
    if (used + bytes > maxBytes) break;
    result += character;
    used += bytes;
  }
  return result;
}

function safeConflictBasename(value) {
  let result = '';
  for (const character of truncateUtf8(value, 96)) {
    const code = character.codePointAt(0);
    result += code <= 0x1f || code === 0x7f || character === '/' || character === '\\'
      ? '_'
      : character;
  }
  return result || 'file';
}

async function rawConflictPath(path, localEntry, remoteEntry) {
  const signature = new TextEncoder().encode([
    path,
    localEntry?.hash || '',
    remoteEntry?.hash || '',
    remoteEntryFingerprint(remoteEntry),
  ].join('\u0000'));
  const digest = await hashBytes(signature);
  const basename = safeConflictBasename(path.split('/').at(-1) || 'file');
  return `files/Sync Conflicts/${digest.slice(0, 20)}-${basename}`;
}

function structuredPayloadReadLimit(payloadSize) {
  if (payloadSize == null) return MAX_REMOTE_PAYLOAD_BYTES;
  const declaredSize = Number(payloadSize);
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) return MAX_REMOTE_PAYLOAD_BYTES;
  return Math.min(MAX_REMOTE_PAYLOAD_BYTES, declaredSize);
}

async function readStructuredBase(path, syncConfig) {
  const canonicalPath = await structuredBasePath(path, syncConfig);
  for (const basePath of await structuredBaseCandidatePaths(path, syncConfig)) {
    let bytes;
    try {
      bytes = await readPathBytes(basePath);
    } catch (error) {
      if (isMissingLocalPathError(error)) continue;
      throw error;
    }
    try {
      const data = readStructuredUpdate(bytes);
      if (basePath !== canonicalPath) {
        await writePathBytes(canonicalPath, bytes, { internal: true });
        await deletePath(basePath, { internal: true });
      }
      return data;
    } catch (error) {
      throw new Error(`The structured sync base for ${path} is corrupt; it was left untouched.`, {
        cause: error,
      });
    }
  }
  return undefined;
}

async function writeStructuredBase(path, data, syncConfig) {
  await writePathBytes(
    await structuredBasePath(path, syncConfig),
    createStructuredUpdate(data),
    { internal: true }
  );
}

async function deleteStructuredBase(path, syncConfig) {
  for (const basePath of await structuredBaseCandidatePaths(path, syncConfig)) {
    await deletePath(basePath, { internal: true });
  }
}

function makeDeleteEntry(previous = {}, revisionBy = null) {
  const previousRevision = entryRevision(previous);
  const revision = previous.deleted && previousRevision > 0
    ? previousRevision
    : nextEntryRevision(previous);
  return {
    deleted: true,
    deletedAt: previous.deletedAt || nowIso(),
    updatedAt: nowIso(),
    hash: previous.hash || null,
    revision,
    revisionBy: previous.deleted && previousRevision > 0
      ? (previous.revisionBy || revisionBy)
      : revisionBy,
    remoteDeleted: false,
  };
}

function isAllowedManifestObjectKey(syncConfig, key, type) {
  if (key == null) return true;
  if (typeof key !== 'string' || !key) return false;
  const root = `${objectKey(syncConfig, type)}/`;
  return key.startsWith(root) && !key.includes('/../') && !key.endsWith('/..');
}

function validateRevision(value, description) {
  if (value == null) return;
  if (!Number.isSafeInteger(Number(value)) || Number(value) < 0) {
    throw new Error(`Remote sync manifest has an invalid ${description}.`);
  }
}

function validatePayloadSize(value, description) {
  if (value == null) return;
  if (
    !Number.isSafeInteger(Number(value))
    || Number(value) < 0
    || Number(value) > MAX_REMOTE_PAYLOAD_BYTES
  ) {
    throw new Error(`Remote sync manifest has an invalid ${description}.`);
  }
}

function validateStructuredCandidate(candidate, syncConfig, path, integrityVersion = 3) {
  const strictContentIntegrity = Number(integrityVersion) >= 2;
  const strictPayloadIntegrity = Number(integrityVersion) >= 3;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error(`Remote sync manifest has an invalid structured candidate for ${path}.`);
  }
  if (candidate.hashType != null && candidate.hashType !== 'content') {
    throw new Error(`Remote sync manifest has an unsupported candidate hash type for ${path}.`);
  }
  if (
    (strictContentIntegrity || candidate.hashType === 'content')
    && !/^[a-f\d]{64}$/i.test(String(candidate.hash || ''))
  ) {
    throw new Error(`Remote sync manifest has an invalid candidate hash for ${path}.`);
  }
  if (strictContentIntegrity && candidate.hashType !== 'content') {
    throw new Error(`Remote sync manifest has an unsupported candidate hash type for ${path}.`);
  }
  if (candidate.payloadHash != null && !/^[a-f\d]{64}$/i.test(String(candidate.payloadHash))) {
    throw new Error(`Remote sync manifest has an invalid candidate payload hash for ${path}.`);
  }
  if (strictPayloadIntegrity && !candidate.payloadHash) {
    throw new Error(`Remote sync manifest has no encoded candidate integrity hash for ${path}.`);
  }
  if (strictPayloadIntegrity && candidate.payloadSize == null) {
    throw new Error(`Remote sync manifest has no encoded candidate size for ${path}.`);
  }
  if (strictPayloadIntegrity && candidate.size == null) {
    throw new Error(`Remote sync manifest has no candidate content size for ${path}.`);
  }
  if (!isAllowedManifestObjectKey(syncConfig, candidate.yjsKey, 'yjs')) {
    throw new Error(`Remote sync manifest references structured data outside the configured prefix: ${path}`);
  }
  if (!candidate.yjsKey) {
    throw new Error(`Remote sync manifest has a structured candidate without a payload for ${path}.`);
  }
  if (
    candidate.hashType === 'content'
    && !matchesContentAddressedKey(
      syncConfig,
      'yjs',
      path,
      candidate.payloadHash || candidate.hash,
      candidate.yjsKey
    )
  ) {
    throw new Error(`Remote sync manifest has a candidate key that does not match ${path}.`);
  }
  if (!isAllowedManifestObjectKey(syncConfig, candidate.baseYjsKey, 'yjs')) {
    throw new Error(`Remote sync manifest references a structured base outside the configured prefix: ${path}`);
  }
  if (!candidate.baseYjsKey && [
    candidate.baseHash,
    candidate.baseSize,
    candidate.basePayloadHash,
    candidate.basePayloadSize,
  ].some((value) => value != null)) {
    throw new Error(`Remote sync manifest has orphaned candidate base metadata for ${path}.`);
  }
  if (
    candidate.size != null
    && (
      !Number.isSafeInteger(Number(candidate.size))
      || Number(candidate.size) < 0
      || Number(candidate.size) > MAX_REMOTE_PAYLOAD_BYTES
    )
  ) {
    throw new Error(`Remote sync manifest has an invalid candidate size for ${path}.`);
  }
  validatePayloadSize(candidate.payloadSize, `candidate payload size for ${path}`);
  if (candidate.baseYjsKey) {
    if (!/^[a-f\d]{64}$/i.test(String(candidate.baseHash || ''))) {
      throw new Error(`Remote sync manifest has an invalid candidate base hash for ${path}.`);
    }
    if (
      candidate.basePayloadHash != null
      && !/^[a-f\d]{64}$/i.test(String(candidate.basePayloadHash))
    ) {
      throw new Error(`Remote sync manifest has an invalid candidate base payload hash for ${path}.`);
    }
    if (strictPayloadIntegrity && !candidate.basePayloadHash) {
      throw new Error(`Remote sync manifest has no candidate base payload integrity hash for ${path}.`);
    }
    if (strictPayloadIntegrity && candidate.basePayloadSize == null) {
      throw new Error(`Remote sync manifest has no candidate base encoded size for ${path}.`);
    }
    if (strictPayloadIntegrity && candidate.baseSize == null) {
      throw new Error(`Remote sync manifest has no candidate base content size for ${path}.`);
    }
    if (!matchesContentAddressedKey(
      syncConfig,
      'yjs',
      path,
      candidate.basePayloadHash || candidate.baseHash,
      candidate.baseYjsKey
    )) {
      throw new Error(`Remote sync manifest has a candidate base key that does not match ${path}.`);
    }
    if (
      candidate.baseSize != null
      && (
        !Number.isSafeInteger(Number(candidate.baseSize))
        || Number(candidate.baseSize) < 0
        || Number(candidate.baseSize) > MAX_REMOTE_PAYLOAD_BYTES
      )
    ) {
      throw new Error(`Remote sync manifest has an invalid candidate base size for ${path}.`);
    }
    validatePayloadSize(candidate.basePayloadSize, `candidate base payload size for ${path}`);
  }
  validateRevision(candidate.revision, `candidate revision for ${path}`);
  if (
    candidate.redactionVersion != null
    && (!Number.isSafeInteger(Number(candidate.redactionVersion)) || Number(candidate.redactionVersion) < 0)
  ) {
    throw new Error(`Remote sync manifest has an invalid candidate redaction version for ${path}.`);
  }
  if (candidate.revisionBy != null && !/^[A-Za-z0-9-]{1,128}$/.test(candidate.revisionBy)) {
    throw new Error(`Remote sync manifest has an invalid candidate writer for ${path}.`);
  }
}

function normalizeShardMeta(rawMeta) {
  if (rawMeta == null) return null;
  if (!rawMeta || typeof rawMeta !== 'object' || Array.isArray(rawMeta)) {
    throw new Error('Remote sync manifest has invalid shard metadata.');
  }
  const { clientId, generation, seen, attemptId } = rawMeta;
  if (!/^[A-Za-z0-9-]{1,128}$/.test(clientId || '')) {
    throw new Error('Remote sync manifest has an invalid shard client ID.');
  }
  if (!Number.isSafeInteger(Number(generation)) || Number(generation) < 1) {
    throw new Error('Remote sync manifest has an invalid shard generation.');
  }
  if (
    attemptId != null
    && !new RegExp(`^[a-f\\d]{${SHARD_ATTEMPT_ID_HEX_LENGTH}}$`).test(attemptId)
  ) {
    throw new Error('Remote sync manifest has an invalid shard attempt ID.');
  }
  if (!seen || typeof seen !== 'object' || Array.isArray(seen)) {
    throw new Error('Remote sync manifest has an invalid shard causal vector.');
  }
  const entries = Object.entries(seen);
  if (entries.length > MAX_MANIFEST_SHARDS) {
    throw new Error(`Remote sync shard causal vector exceeds the ${MAX_MANIFEST_SHARDS} device limit.`);
  }
  const normalizedSeen = Object.create(null);
  for (const [id, value] of entries) {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) {
      throw new Error('Remote sync manifest has an invalid causal-vector client ID.');
    }
    if (!Number.isSafeInteger(Number(value)) || Number(value) < 0) {
      throw new Error('Remote sync manifest has an invalid causal-vector generation.');
    }
    normalizedSeen[id] = Number(value);
  }
  if ((normalizedSeen[clientId] || 0) !== Number(generation)) {
    throw new Error('Remote sync shard causal vector does not match its own generation.');
  }
  return {
    clientId,
    generation: Number(generation),
    seen: normalizedSeen,
    ...(attemptId != null ? { attemptId } : {}),
  };
}

function validateRemoteManifest(rawManifest, syncConfig) {
  if (!rawManifest || typeof rawManifest !== 'object' || Array.isArray(rawManifest)) {
    throw new Error('Remote sync manifest is invalid.');
  }
  if (rawManifest.version != null && ![1, 2].includes(Number(rawManifest.version))) {
    throw new Error(`Unsupported remote sync manifest version: ${String(rawManifest.version)}`);
  }
  if (
    rawManifest.integrityVersion != null
    && ![1, 2, 3].includes(Number(rawManifest.integrityVersion))
  ) {
    throw new Error(
      `Unsupported remote sync integrity version: ${String(rawManifest.integrityVersion)}`
    );
  }
  const integrityVersion = Number(rawManifest.integrityVersion) || 1;
  const strictContentIntegrity = integrityVersion >= 2;
  const strictPayloadIntegrity = integrityVersion >= 3;
  if (rawManifest.files != null && (typeof rawManifest.files !== 'object' || Array.isArray(rawManifest.files))) {
    throw new Error('Remote sync manifest has an invalid files index.');
  }

  const rawFiles = Object.entries(rawManifest.files || {});
  if (rawFiles.length > MAX_MANIFEST_FILES) {
    throw new Error(`Remote sync manifest exceeds the ${MAX_MANIFEST_FILES} file limit.`);
  }
  const files = safeFileIndex();
  for (const [path, rawEntry] of rawFiles) {
    assertSafeSyncPath(path);
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      throw new Error(`Remote sync manifest has an invalid entry for ${path}.`);
    }
    if (rawEntry.deleted != null && typeof rawEntry.deleted !== 'boolean') {
      throw new Error(`Remote sync manifest has an invalid deletion flag for ${path}.`);
    }
    if (rawEntry.structured != null && typeof rawEntry.structured !== 'boolean') {
      throw new Error(`Remote sync manifest has an invalid structured flag for ${path}.`);
    }
    if (
      isConfigPath(path)
      && !rawEntry.deleted
      && !rawEntry.restored
      && !rawEntry.structured
    ) {
      throw new Error(`Remote config must use the redacted structured sync format: ${path}.`);
    }
    if (rawEntry.restored != null && typeof rawEntry.restored !== 'boolean') {
      throw new Error(`Remote sync manifest has an invalid restoration marker for ${path}.`);
    }
    if (rawEntry.restored && (
      rawEntry.deleted
      || rawEntry.structured
      || rawEntry.hash != null
      || rawEntry.objectKey != null
      || rawEntry.yjsKey != null
      || rawEntry.baseYjsKey != null
      || rawEntry.structuredCandidates != null
    )) {
      throw new Error(`Remote sync manifest has an invalid restoration marker payload for ${path}.`);
    }
    validateRevision(rawEntry.revision, `revision for ${path}`);
    if (rawEntry.revisionBy != null && !/^[A-Za-z0-9-]{1,128}$/.test(rawEntry.revisionBy)) {
      throw new Error(`Remote sync manifest has an invalid revision writer for ${path}.`);
    }
    if (rawEntry.hash != null && !/^[a-f\d]{64}$/i.test(String(rawEntry.hash))) {
      throw new Error(`Remote sync manifest has an invalid content hash for ${path}.`);
    }
    if (rawEntry.hashType != null && rawEntry.hashType !== 'content') {
      throw new Error(`Remote sync manifest has an unsupported hash type for ${path}.`);
    }
    if (rawEntry.payloadHash != null && !/^[a-f\d]{64}$/i.test(String(rawEntry.payloadHash))) {
      throw new Error(`Remote sync manifest has an invalid encoded payload hash for ${path}.`);
    }
    if (
      rawEntry.size != null
      && (
        !Number.isSafeInteger(Number(rawEntry.size))
        || Number(rawEntry.size) < 0
        || Number(rawEntry.size) > MAX_REMOTE_PAYLOAD_BYTES
      )
    ) {
      throw new Error(`Remote sync manifest has an invalid size for ${path}.`);
    }
    validatePayloadSize(rawEntry.payloadSize, `payload size for ${path}`);
    if (strictPayloadIntegrity && !rawEntry.deleted && !rawEntry.restored && rawEntry.size == null) {
      throw new Error(`Remote sync manifest has no content size for ${path}.`);
    }
    if (!isAllowedManifestObjectKey(syncConfig, rawEntry.objectKey, 'objects')) {
      throw new Error(`Remote sync manifest references an object outside the configured prefix: ${path}`);
    }
    if (!isAllowedManifestObjectKey(syncConfig, rawEntry.yjsKey, 'yjs')) {
      throw new Error(`Remote sync manifest references structured data outside the configured prefix: ${path}`);
    }
    if (!isAllowedManifestObjectKey(syncConfig, rawEntry.baseYjsKey, 'yjs')) {
      throw new Error(`Remote sync manifest references a structured base outside the configured prefix: ${path}`);
    }
    if (!rawEntry.baseYjsKey && [
      rawEntry.baseHash,
      rawEntry.baseSize,
      rawEntry.basePayloadHash,
      rawEntry.basePayloadSize,
    ].some((value) => value != null)) {
      throw new Error(`Remote sync manifest has orphaned structured base metadata for ${path}.`);
    }
    if (rawEntry.baseYjsKey) {
      if (!/^[a-f\d]{64}$/i.test(String(rawEntry.baseHash || ''))) {
        throw new Error(`Remote sync manifest has an invalid structured base hash for ${path}.`);
      }
      if (
        rawEntry.basePayloadHash != null
        && !/^[a-f\d]{64}$/i.test(String(rawEntry.basePayloadHash))
      ) {
        throw new Error(`Remote sync manifest has an invalid structured base payload hash for ${path}.`);
      }
      if (strictPayloadIntegrity && !rawEntry.basePayloadHash) {
        throw new Error(`Remote sync manifest has no structured base payload integrity hash for ${path}.`);
      }
      if (strictPayloadIntegrity && rawEntry.basePayloadSize == null) {
        throw new Error(`Remote sync manifest has no structured base encoded size for ${path}.`);
      }
      if (strictPayloadIntegrity && rawEntry.baseSize == null) {
        throw new Error(`Remote sync manifest has no structured base content size for ${path}.`);
      }
      if (!matchesContentAddressedKey(
        syncConfig,
        'yjs',
        path,
        rawEntry.basePayloadHash || rawEntry.baseHash,
        rawEntry.baseYjsKey
      )) {
        throw new Error(`Remote sync manifest has a structured base key that does not match ${path}.`);
      }
      if (
        rawEntry.baseSize != null
        && (
          !Number.isSafeInteger(Number(rawEntry.baseSize))
          || Number(rawEntry.baseSize) < 0
          || Number(rawEntry.baseSize) > MAX_REMOTE_PAYLOAD_BYTES
        )
      ) {
        throw new Error(`Remote sync manifest has an invalid structured base size for ${path}.`);
      }
      validatePayloadSize(rawEntry.basePayloadSize, `structured base payload size for ${path}`);
    }
    if (rawEntry.structuredCandidates != null) {
      if (!Array.isArray(rawEntry.structuredCandidates)
        || rawEntry.structuredCandidates.length > MAX_STRUCTURED_CANDIDATES) {
        throw new Error(`Remote sync manifest has invalid structured candidates for ${path}.`);
      }
      for (const candidate of rawEntry.structuredCandidates) {
        validateStructuredCandidate(candidate, syncConfig, path, integrityVersion);
      }
    }
    if (strictContentIntegrity && !rawEntry.deleted && !rawEntry.restored) {
      if (rawEntry.hashType !== 'content' || !rawEntry.hash) {
        throw new Error(`Remote sync manifest has unsupported integrity metadata for ${path}.`);
      }
    }
    if (rawEntry.hashType === 'content' && !rawEntry.deleted && !rawEntry.restored) {
      if (rawEntry.structured) {
        if (
          (strictPayloadIntegrity && !rawEntry.payloadHash)
          || (strictPayloadIntegrity && rawEntry.payloadSize == null)
          || !matchesContentAddressedKey(
            syncConfig,
            'yjs',
            path,
            rawEntry.payloadHash || rawEntry.hash,
            rawEntry.yjsKey
          )
          || rawEntry.objectKey
        ) {
          throw new Error(`Remote sync manifest has a structured payload key that does not match ${path}.`);
        }
      } else if (
        !matchesContentAddressedKey(
          syncConfig,
          'objects',
          path,
          rawEntry.hash,
          rawEntry.objectKey
        )
        || rawEntry.yjsKey
      ) {
        throw new Error(`Remote sync manifest has a payload key that does not match ${path}.`);
      }
    }
    Object.defineProperty(files, path, {
      value: { ...rawEntry, deleted: Boolean(rawEntry.deleted) },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return {
    ...rawManifest,
    version: Number(rawManifest.version) || 1,
    shardMeta: normalizeShardMeta(rawManifest.shardMeta),
    files,
  };
}

function cloneManifest(manifest) {
  return JSON.parse(JSON.stringify(manifest));
}

function cacheRemoteManifest(state, manifest, etag) {
  if (!state) return;
  state.manifestCache = {
    etag: etag || null,
    manifest: cloneManifest(manifest),
  };
}

function isBoundedManifestSize(value) {
  const size = Number(value);
  return value != null
    && Number.isSafeInteger(size)
    && size >= 0
    && size <= MAX_REMOTE_PAYLOAD_BYTES;
}

function manifestIntegrityVersion(files = {}) {
  const contentStrict = Object.values(files || {}).every((entry) => (
    entry?.deleted
    || entry?.restored
    || (
      entry?.hashType === 'content'
      && /^[a-f\d]{64}$/i.test(String(entry.hash || ''))
      && (!entry.structuredCandidates || entry.structuredCandidates.every(
        (candidate) => candidate?.hashType === 'content' && candidate?.hash
      ))
    )
  ));
  if (!contentStrict) return 1;
  const payloadStrict = Object.values(files || {}).every((entry) => (
    entry?.deleted
    || entry?.restored
    || (
      isBoundedManifestSize(entry?.size)
      && (
        !entry?.structured
        || (
          /^[a-f\d]{64}$/i.test(String(entry.payloadHash || ''))
          && isBoundedManifestSize(entry.payloadSize)
          && (!entry.baseYjsKey || (
            /^[a-f\d]{64}$/i.test(String(entry.basePayloadHash || ''))
            && isBoundedManifestSize(entry.baseSize)
            && isBoundedManifestSize(entry.basePayloadSize)
          ))
          && (!entry.structuredCandidates || entry.structuredCandidates.every((candidate) => (
            /^[a-f\d]{64}$/i.test(String(candidate?.payloadHash || ''))
            && isBoundedManifestSize(candidate?.size)
            && isBoundedManifestSize(candidate?.payloadSize)
            && (!candidate?.baseYjsKey || (
              /^[a-f\d]{64}$/i.test(String(candidate?.basePayloadHash || ''))
              && isBoundedManifestSize(candidate?.baseSize)
              && isBoundedManifestSize(candidate?.basePayloadSize)
            ))
          )))
        )
      )
    )
  ));
  return payloadStrict ? 3 : 2;
}

function structuredCandidateEntries(entry = {}) {
  if (entry.deleted || !entry.structured) return [];
  const candidates = [{
    hash: entry.hash || null,
    hashType: entry.hashType || null,
    size: entry.size == null ? null : Number(entry.size),
    payloadSize: entry.payloadSize == null ? null : Number(entry.payloadSize),
    payloadHash: entry.payloadHash || null,
    updatedAt: entry.updatedAt || null,
    revision: entryRevision(entry),
    revisionBy: entry.revisionBy || null,
    yjsKey: entry.yjsKey || null,
    baseYjsKey: entry.baseYjsKey || null,
    baseHash: entry.baseHash || null,
    baseSize: entry.baseSize == null ? null : Number(entry.baseSize),
    basePayloadSize: entry.basePayloadSize == null ? null : Number(entry.basePayloadSize),
    basePayloadHash: entry.basePayloadHash || null,
    redactionVersion: entry.redactionVersion ?? null,
  }, ...(entry.structuredCandidates || [])];
  const unique = new Map();
  for (const candidate of candidates) {
    if (!candidate?.yjsKey) continue;
    const key = `${candidate.yjsKey}\u0000${candidate.hash || ''}`;
    if (!unique.has(key)) unique.set(key, { ...candidate });
  }
  return [...unique.values()].sort((left, right) => (
    `${left.yjsKey}\u0000${left.hash || ''}`.localeCompare(`${right.yjsKey}\u0000${right.hash || ''}`)
  ));
}

function entryMayContainUnredactedConfig(entry = {}) {
  return Boolean(
    entry
    && !entry.deleted
    && (
      entry.redactionVersion !== CONFIG_REDACTION_VERSION
      || structuredCandidateEntries(entry).some(
        (candidate) => candidate.redactionVersion !== CONFIG_REDACTION_VERSION
      )
    )
  );
}

function collectSensitiveEntryPayloadKeys(target, syncConfig, path, entry = {}) {
  if (!entryMayContainUnredactedConfig(entry)) return;
  if (entry.objectKey) target.add(entry.objectKey);
  for (const candidate of structuredCandidateEntries(entry)) {
    if (candidate.yjsKey) target.add(candidate.yjsKey);
    if (candidate.baseYjsKey) target.add(candidate.baseYjsKey);
  }
  // Very old manifests may omit the explicit payload key and rely on the
  // path-derived legacy location.
  if (entry.structured && structuredCandidateEntries(entry).length === 0) {
    target.add(objectKey(syncConfig, yjsPath(path)));
  } else if (!entry.structured && !entry.objectKey) {
    target.add(objectKey(syncConfig, objectPath(path)));
  }
}

async function cleanupSensitivePayloads(backend, syncConfig, state, manifest) {
  const pending = state?.pendingSensitiveDeletes;
  if (!pending || typeof pending !== 'object') return 0;
  for (const key of Object.keys(pending)) {
    const allowed = isAllowedManifestObjectKey(syncConfig, key, 'objects')
      || isAllowedManifestObjectKey(syncConfig, key, 'yjs');
    if (!allowed) delete pending[key];
  }
  if (usesShardedManifest(syncConfig)) {
    // LIST only reveals currently visible shards. An offline writer or a
    // delayed immutable shard publication can still legitimately reference a
    // scrubbed payload, so physical deletion is unsafe without a coordinated
    // global retention protocol. Preserve the durable cleanup journal for a
    // future safe collector instead of breaking those snapshots.
    return 0;
  }
  const referenced = new Set();
  for (const entry of Object.values(manifest.files || {})) {
    if (!entry || entry.deleted || entry.restored) continue;
    for (const candidate of structuredCandidateEntries(entry)) {
      if (candidate.yjsKey) referenced.add(candidate.yjsKey);
      if (candidate.baseYjsKey) referenced.add(candidate.baseYjsKey);
    }
    if (entry.objectKey) referenced.add(entry.objectKey);
  }

  let cleaned = 0;
  for (const key of Object.keys(pending)) {
    // Keep the durable intent while an authoritative manifest still refers to
    // the payload. A later successful scrub commit makes it eligible without
    // relying on rediscovering an orphaned secret key.
    if (referenced.has(key)) continue;
    try {
      await backend.delete(key);
      delete pending[key];
      cleaned += 1;
    } catch {
      // Secret-bearing legacy objects are retried on every push-capable sync.
    }
  }
  return cleaned;
}

async function loadLegacyRemoteManifest(backend, syncConfig) {
  const fallback = defaultManifest();
  const key = objectKey(syncConfig, LEGACY_MANIFEST_FILE);
  if (typeof backend.getJsonWithMetadata !== 'function') {
    const manifest = await backend.getJson(key, null);
    return {
      manifest: validateRemoteManifest(manifest || fallback, syncConfig),
      etag: null,
      exists: Boolean(manifest),
    };
  }
  const result = await backend.getJsonWithMetadata(key, fallback, {
    maxBytes: MAX_MANIFEST_OBJECT_BYTES,
  });
  return {
    manifest: validateRemoteManifest(result.data || fallback, syncConfig),
    etag: result.etag || null,
    exists: result.exists !== false,
  };
}

function authorityMarkerKey(syncConfig, mode, committed = false) {
  return objectKey(
    syncConfig,
    `${AUTHORITY_MARKER_DIR}/${mode}${committed ? '.committed' : ''}.json`
  );
}

async function readAuthorityMarkerObject(backend, key) {
  const result = typeof backend.getJsonWithMetadata === 'function'
    ? await backend.getJsonWithMetadata(key, null, { maxBytes: 4096 })
    : { data: await backend.getJson(key, null), exists: null };
  if (result.exists === false || result.data == null) return null;
  const marker = result.data;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    throw new Error('Remote sync authority marker is invalid; it was left untouched.');
  }
  return marker;
}

async function loadAuthorityMarker(backend, syncConfig) {
  const markerKeys = [
    ['conditional', false],
    ['conditional', true],
    ['sharded', false],
    ['sharded', true],
  ];
  const [conditional, conditionalCommitted, sharded, shardedCommitted, legacy] = await Promise.all([
    ...markerKeys.map(([mode, committed]) => (
      readAuthorityMarkerObject(backend, authorityMarkerKey(syncConfig, mode, committed))
    )),
    readAuthorityMarkerObject(
      backend,
      objectKey(syncConfig, LEGACY_AUTHORITY_MARKER_FILE)
    ),
  ]);
  for (const [marker, mode, committed] of [
    [conditional, 'conditional', false],
    [conditionalCommitted, 'conditional', true],
    [sharded, 'sharded', false],
    [shardedCommitted, 'sharded', true],
  ]) {
    if (marker && (
      marker.version !== 2
      || marker.mode !== mode
      || Boolean(marker.committed) !== committed
    )) {
      throw new Error('Remote sync authority marker is invalid; it was left untouched.');
    }
  }
  if (legacy && (
    legacy.version !== 1
    || !['conditional', 'sharded', 'conflict'].includes(legacy.mode)
  )) {
    throw new Error('Remote sync authority marker is invalid; it was left untouched.');
  }
  const summary = {
    conditional: Boolean(conditional || conditionalCommitted || legacy?.mode === 'conditional'),
    conditionalCommitted: Boolean(conditionalCommitted || legacy?.mode === 'conditional'),
    sharded: Boolean(sharded || shardedCommitted || legacy?.mode === 'sharded'),
    shardedCommitted: Boolean(shardedCommitted || legacy?.mode === 'sharded'),
    conflict: legacy?.mode === 'conflict',
    legacy: Boolean(legacy),
  };
  return summary.conditional || summary.sharded || summary.conflict ? summary : null;
}

function authorityMarkerCommitted(marker, mode) {
  return Boolean(marker?.[`${mode}Committed`]);
}

function authorityMarkerError(marker, desiredMode, missing = false) {
  if (!marker) return null;
  if (marker.conflict || (marker.conditional && marker.sharded)) {
    return new Error(
      'This sync destination recorded conflicting conditional and sharded authorities. '
      + 'Choose a new prefix after recovering any needed bucket versions.'
    );
  }
  const oppositeMode = desiredMode === 'conditional' ? 'sharded' : 'conditional';
  if (marker[oppositeMode]) {
    return new Error(
      `This destination already uses ${oppositeMode} manifests. Keep that mode, or choose a new prefix.`
    );
  }
  if (missing && authorityMarkerCommitted(marker, desiredMode)) {
    const authorityName = desiredMode === 'sharded'
      ? 'sharded manifests are'
      : 'conditional manifest is';
    return new Error(
      `The authoritative ${authorityName} missing. Restore it from bucket version history, `
      + 'or choose a new sync prefix; legacy data was not re-imported.'
    );
  }
  return null;
}

async function writeAuthorityMarker(backend, syncConfig, mode, committed = false) {
  return backend.putJson(authorityMarkerKey(syncConfig, mode, committed), {
    version: 2,
    mode,
    committed,
  });
}

async function recordAuthorityConflict(backend, syncConfig) {
  const outcomes = await Promise.allSettled([
    writeAuthorityMarker(backend, syncConfig, 'conditional'),
    writeAuthorityMarker(backend, syncConfig, 'sharded'),
  ]);
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      console.warn('Failed to persist a sync authority conflict marker:', outcome.reason);
    }
  }
}

async function persistAuthorityConflict(backend, syncConfig, state) {
  await recordAuthorityConflict(backend, syncConfig);
  state.pendingModeConfirmation = false;
  state.authorityMarkerVerified = false;
  await saveState(state, syncConfig);
}

async function assertAuthorityMarkerCompatible(backend, syncConfig, mode, options = {}) {
  const marker = await loadAuthorityMarker(backend, syncConfig);
  const error = authorityMarkerError(marker, mode, Boolean(options.missing));
  if (error) throw error;
  return marker;
}

async function loadSingleRemoteManifest(backend, syncConfig, state = null) {
  const fallback = defaultManifest();
  if (typeof backend.getJsonWithMetadata !== 'function') {
    const manifest = await backend.getJson(objectKey(syncConfig, MANIFEST_FILE), null);
    if (!manifest) return { manifest: fallback, etag: null, exists: false };
    const validated = validateRemoteManifest(manifest, syncConfig);
    cacheRemoteManifest(state, validated, null);
    if (state) state.conditionalManifestEstablished = true;
    return { manifest: validated, etag: null, exists: true };
  }
  const cachedManifest = state?.manifestCache?.manifest;
  const cachedEtag = state?.manifestCache?.etag || null;
  const result = await backend.getJsonWithMetadata(
    objectKey(syncConfig, MANIFEST_FILE),
    cachedManifest || fallback,
    {
      maxBytes: 16 * 1024 * 1024,
      ...(cachedManifest && cachedEtag ? { ifNoneMatch: cachedEtag } : {}),
    }
  );
  if (result.exists === false) {
    if (state?.conditionalManifestEstablished) {
      throw new Error(
        'The authoritative conditional manifest is missing. Restore manifest.v3.json from bucket '
        + 'version history, or choose a new sync prefix; legacy data was not re-imported.'
      );
    }
    if (state) delete state.manifestCache;
    return { manifest: fallback, etag: null, exists: false };
  }
  const manifestData = result.notModified && cachedManifest
    ? cachedManifest
    : (result.data || fallback);
  const validated = validateRemoteManifest(manifestData, syncConfig);
  const etag = result.exists === false
    ? null
    : (result.etag || (result.notModified ? cachedEtag : null));
  cacheRemoteManifest(state, validated, etag);
  if (state) state.conditionalManifestEstablished = true;
  return {
    manifest: validated,
    etag,
    exists: result.exists !== false,
    notModified: Boolean(result.notModified),
  };
}

function usesShardedManifest(syncConfig = {}) {
  const preset = normalizeProviderPreset(syncConfig.providerPreset);
  return String(syncConfig.manifestMode || '').trim().toLowerCase() === 'sharded'
    || preset === 'aliyun-oss';
}

function manifestEntryTime(entry = {}) {
  const values = [entry.updatedAt, entry.deletedAt]
    .map((value) => Date.parse(value || 0))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : 0;
}

function compareEntryVersions(left = {}, right = {}, leftFallback = '', rightFallback = '') {
  const revisionDelta = entryRevision(left) - entryRevision(right);
  if (revisionDelta !== 0) return revisionDelta;
  if (entryRevision(left) === 0) {
    const timeDelta = manifestEntryTime(left) - manifestEntryTime(right);
    if (timeDelta !== 0) return timeDelta;
  }
  const leftWriter = left.revisionBy || leftFallback;
  const rightWriter = right.revisionBy || rightFallback;
  return leftWriter < rightWriter ? -1 : leftWriter > rightWriter ? 1 : 0;
}

function mergeCausalVectors(...vectors) {
  const merged = Object.create(null);
  for (const vector of vectors) {
    for (const [clientId, generation] of Object.entries(vector || {})) {
      merged[clientId] = Math.max(merged[clientId] || 0, Number(generation) || 0);
    }
  }
  return merged;
}

function shardSourceDominates(left, right) {
  const leftMeta = left?.manifest?.shardMeta;
  const rightMeta = right?.manifest?.shardMeta;
  if (!leftMeta || !rightMeta) return false;
  const leftSeesRight = Number(leftMeta.seen?.[rightMeta.clientId] || 0) >= Number(rightMeta.generation);
  const rightSeesLeft = Number(rightMeta.seen?.[leftMeta.clientId] || 0) >= Number(leftMeta.generation);
  return leftSeesRight && !rightSeesLeft;
}

function maximalShardSources(sources) {
  return sources.filter((source) => !sources.some((other) => (
    other.id !== source.id && shardSourceDominates(other, source)
  )));
}

function mergeStructuredCandidateLists(...entries) {
  const flattened = entries.flatMap((entry) => structuredCandidateEntries(entry));
  const highestRevisionByWriter = new Map();
  for (const candidate of flattened) {
    if (!candidate.revisionBy) continue;
    highestRevisionByWriter.set(
      candidate.revisionBy,
      Math.max(
        highestRevisionByWriter.get(candidate.revisionBy) || 0,
        entryRevision(candidate)
      )
    );
  }
  const candidates = new Map();
  for (const candidate of flattened) {
    // Superseded snapshots from the same writer are inherited history. A
    // lower revision from a different writer can still be a legitimate
    // causally-concurrent head and must participate in the merge.
    if (
      candidate.revisionBy
      && entryRevision(candidate) < highestRevisionByWriter.get(candidate.revisionBy)
    ) continue;
    const key = `${candidate.yjsKey}\u0000${candidate.hash || ''}`;
    if (!candidates.has(key)) candidates.set(key, candidate);
  }
  const merged = [...candidates.values()].sort((left, right) => (
    `${left.yjsKey}\u0000${left.hash || ''}`.localeCompare(`${right.yjsKey}\u0000${right.hash || ''}`)
  ));
  if (merged.length > MAX_STRUCTURED_CANDIDATES) {
    throw new Error(`Concurrent structured updates exceed the ${MAX_STRUCTURED_CANDIDATES} candidate limit.`);
  }
  return merged;
}

function mergeRemoteManifests(sources, syncConfig) {
  const files = safeFileIndex();
  const owners = new Map();
  let fileCount = 0;
  let updatedAt = null;
  for (const { id, manifest } of [...sources].sort((left, right) => left.id.localeCompare(right.id))) {
    const validated = validateRemoteManifest(manifest, syncConfig);
    if (!updatedAt || Date.parse(validated.updatedAt || 0) > Date.parse(updatedAt || 0)) {
      updatedAt = validated.updatedAt || updatedAt;
    }
    for (const [path, entry] of Object.entries(validated.files)) {
      const previous = files[path];
      const previousOwner = owners.get(path) || '';
      if (!previous && fileCount >= MAX_MANIFEST_FILES) {
        throw new Error(`Merged remote sync manifest exceeds the ${MAX_MANIFEST_FILES} file limit.`);
      }
      const shouldReplace = !previous
        || compareEntryVersions(entry, previous, id, previousOwner) > 0;
      const winner = shouldReplace ? { ...entry } : { ...previous };
      const winnerOwner = shouldReplace ? id : previousOwner;
      if (winner.structured && !winner.deleted) {
        const candidates = mergeStructuredCandidateLists(previous, entry);
        if (candidates.length > 1) winner.structuredCandidates = candidates;
        else delete winner.structuredCandidates;
      } else {
        delete winner.structuredCandidates;
      }
      files[path] = winner;
      if (!previous) fileCount += 1;
      owners.set(path, winnerOwner);
    }
  }
  // OPFS cannot contain both a file and one of its descendants. Concurrent
  // sharded writers can nevertheless publish those two shapes. Select a
  // deterministic compatible set by entry version, then path/source identity;
  // the next causal snapshot permanently dominates the incompatible heads.
  const liveCandidates = Object.entries(files)
    .filter(([, entry]) => entry && !entry.deleted && !entry.restored)
    .map(([path, entry]) => ({ path, entry, owner: owners.get(path) || '' }))
    .sort((left, right) => {
      const versionOrder = compareEntryVersions(
        right.entry,
        left.entry,
        `${right.owner}\u0000${right.path}`,
        `${left.owner}\u0000${left.path}`
      );
      if (versionOrder !== 0) return versionOrder;
      return `${right.owner}\u0000${right.path}`.localeCompare(`${left.owner}\u0000${left.path}`);
    });
  const acceptedPaths = [];
  let resolvedPathConflicts = 0;
  for (const candidate of liveCandidates) {
    const conflicts = acceptedPaths.some((accepted) => (
      isPathOrChild(candidate.path, accepted) || isPathOrChild(accepted, candidate.path)
    ));
    if (conflicts) {
      delete files[candidate.path];
      owners.delete(candidate.path);
      resolvedPathConflicts += 1;
    } else {
      acceptedPaths.push(candidate.path);
    }
  }
  const mergedManifest = {
    version: 2,
    integrityVersion: manifestIntegrityVersion(files),
    updatedAt: updatedAt || nowIso(),
    files,
  };
  Object.defineProperty(mergedManifest, 'resolvedPathConflicts', {
    value: resolvedPathConflicts,
    enumerable: false,
  });
  return mergedManifest;
}

function parseManifestShardObject(key, shardPrefix) {
  if (typeof key !== 'string' || !key.startsWith(shardPrefix)) return null;
  const match = /^([A-Za-z0-9-]{1,128})(?:\.([1-9]\d{0,15})(?:\.([a-f\d]{16}))?)?\.json$/
    .exec(key.slice(shardPrefix.length));
  if (!match) return null;
  const generation = match[2] == null ? null : Number(match[2]);
  if (generation != null && !Number.isSafeInteger(generation)) return null;
  return {
    clientId: match[1],
    generation,
    attemptId: match[3] || null,
    immutable: generation != null,
  };
}

function manifestShardIdentityMatches(manifest, shardIdentity) {
  const meta = manifest?.shardMeta;
  if (!meta) return true;
  return meta.clientId === shardIdentity?.clientId
    && (shardIdentity.generation == null || meta.generation === shardIdentity.generation)
    && (meta.attemptId || null) === (shardIdentity.attemptId || null);
}

function isManifestShardObject(key, shardPrefix) {
  return Boolean(parseManifestShardObject(key, shardPrefix));
}

async function listManifestShardObjects(backend, syncConfig, permissionMessage) {
  if (typeof backend.list !== 'function') {
    throw new Error(permissionMessage);
  }
  const shardPrefix = `${objectKey(syncConfig, MANIFEST_SHARD_DIR)}/`;
  const listed = await backend.list(shardPrefix, {
    maxObjects: MAX_LISTED_MANIFEST_SHARDS + 1,
  });
  if (listed.length > MAX_LISTED_MANIFEST_SHARDS) {
    throw new Error(`Remote sync exceeds the ${MAX_LISTED_MANIFEST_SHARDS} physical manifest-shard limit.`);
  }
  return {
    shardPrefix,
    shardObjects: listed.filter(({ key }) => isManifestShardObject(key, shardPrefix)),
  };
}

async function assertNoConditionalAuthority(backend, syncConfig) {
  const key = objectKey(syncConfig, MANIFEST_FILE);
  let exists = false;
  if (typeof backend.getJsonWithMetadata === 'function') {
    const result = await backend.getJsonWithMetadata(key, null, {
      maxBytes: MAX_MANIFEST_OBJECT_BYTES,
    });
    exists = result.exists !== false;
  } else if (typeof backend.getJson === 'function') {
    exists = Boolean(await backend.getJson(key, null));
  }
  if (exists) {
    throw new Error(
      'This destination already uses conditional manifests. Keep conditional mode, or choose a new '
      + 'prefix before switching to sharded mode.'
    );
  }
}

async function loadShardedRemoteManifest(backend, syncConfig, state) {
  const { shardPrefix, shardObjects } = await listManifestShardObjects(
    backend,
    syncConfig,
    'This sync provider requires object-list permission for concurrency-safe manifests.'
  );
  const aggregateBytes = shardObjects.reduce((total, object) => (
    total + (object.size != null && Number.isSafeInteger(Number(object.size))
      ? Number(object.size)
      : MAX_MANIFEST_OBJECT_BYTES)
  ), 0);
  if (aggregateBytes > MAX_AGGREGATE_MANIFEST_BYTES) {
    throw new Error('Remote manifest shards exceed the 64 MiB aggregate safety limit.');
  }
  const listedKeys = new Set(shardObjects.map(({ key }) => key));
  for (const key of Object.keys(state.manifestShards || {})) {
    if (!listedKeys.has(key)) delete state.manifestShards[key];
  }

  let downloadedShardBytes = 0;
  const shardSources = await mapWithConcurrency(shardObjects, async ({ key, etag }) => {
    const cached = state.manifestShards?.[key];
    if (cached?.manifest && etag && cached.etag === etag) {
      const manifest = validateRemoteManifest(cached.manifest, syncConfig);
      const shardIdentity = parseManifestShardObject(key, shardPrefix);
      if (!manifestShardIdentityMatches(manifest, shardIdentity)) {
        throw new Error(`Remote manifest shard identity does not match its object key: ${key}`);
      }
      return { id: key, etag, manifest };
    }
    const result = await backend.getJsonWithMetadata(key, cached?.manifest || null, {
      maxBytes: 16 * 1024 * 1024,
      ...(cached?.etag ? { ifNoneMatch: cached.etag } : {}),
    });
    if (result.exists === false) {
      delete state.manifestShards[key];
      return null;
    }
    if (!result.notModified) {
      const actualBytes = result.contentLength != null
        && Number.isSafeInteger(Number(result.contentLength))
        ? Number(result.contentLength)
        : new TextEncoder().encode(JSON.stringify(result.data || {})).byteLength;
      downloadedShardBytes += actualBytes;
      if (downloadedShardBytes > MAX_AGGREGATE_MANIFEST_BYTES) {
        throw new Error('Downloaded manifest shards exceed the 64 MiB aggregate safety limit.');
      }
    }
    const manifest = validateRemoteManifest(
      result.notModified && cached?.manifest ? cached.manifest : result.data,
      syncConfig
    );
    const shardIdentity = parseManifestShardObject(key, shardPrefix);
    if (!manifestShardIdentityMatches(manifest, shardIdentity)) {
      throw new Error(`Remote manifest shard identity does not match its object key: ${key}`);
    }
    const authoritativeEtag = result.notModified
      ? (result.etag || cached?.etag || etag || null)
      : (result.etag || null);
    state.manifestShards[key] = {
      etag: authoritativeEtag,
      manifest: cloneManifest(manifest),
    };
    return { id: key, etag: authoritativeEtag, manifest };
  }, maxConcurrentRequests(syncConfig));

  const availableShards = shardSources.filter(Boolean);
  const versionedShards = availableShards.filter((source) => source.manifest.shardMeta);
  if (versionedShards.length === 0 && state.shardedManifestEstablished) {
    throw new Error(
      'The authoritative sharded manifests are missing. Restore the manifests/ objects from bucket '
      + 'version history, or choose a new sync prefix; legacy data was not re-imported.'
    );
  }
  if (versionedShards.length === 0) {
    await assertAuthorityMarkerCompatible(backend, syncConfig, 'sharded', { missing: true });
  } else if (!state.authorityMarkerVerified) {
    const marker = await assertAuthorityMarkerCompatible(backend, syncConfig, 'sharded');
    state.authorityMarkerVerified = authorityMarkerCommitted(marker, 'sharded');
    if (!state.authorityMarkerVerified) await assertNoConditionalAuthority(backend, syncConfig);
  }
  // A fixed conditional manifest and sharded manifests are mutually exclusive
  // authorities. Only probe the opposite namespace during first-use/migration;
  // established sharded syncs retain their LIST-only warm path.
  if (versionedShards.length === 0) {
    await assertNoConditionalAuthority(backend, syncConfig);
  } else {
    state.shardedManifestEstablished = true;
    // A client that created this authority performs one follow-up check. This
    // detects the otherwise non-atomic race where two empty-prefix clients
    // choose different manifest modes at the same time, without imposing a
    // permanent GET on the sharded warm path.
    if (state.pendingModeConfirmation) {
      try {
        await assertNoConditionalAuthority(backend, syncConfig);
      } catch (error) {
        await recordAuthorityConflict(backend, syncConfig);
        throw error;
      }
      state.pendingModeConfirmation = false;
    }
  }
  // Versioned shards are full causal snapshots. Once one exists, the legacy
  // manifest and pre-causal shards are compatibility mirrors rather than
  // authorities; merging them forever would resurrect stale state.
  const rememberedVector = state.shardCausalSeen || {};
  const visibleVector = mergeCausalVectors(...versionedShards.flatMap(({ manifest: shard }) => [
    shard.shardMeta.seen,
    { [shard.shardMeta.clientId]: shard.shardMeta.generation },
  ]));
  const visibleSetCoversRememberedFrontier = Object.entries(rememberedVector).every(
    ([clientId, generation]) => Number(visibleVector[clientId] || 0) >= Number(generation)
  );
  if (
    versionedShards.length > 0
    && Object.keys(rememberedVector).length > 0
    && !visibleSetCoversRememberedFrontier
  ) {
    throw new Error(
      'The visible manifest shards are older than this client\'s observed causal frontier. '
      + 'Restore the newer manifests/ objects from bucket version history, or choose a new prefix.'
    );
  }
  const authoritativeShards = versionedShards.length > 0
    ? versionedShards
    : availableShards;
  const maximalSources = versionedShards.length > 0
    ? maximalShardSources(authoritativeShards)
    : authoritativeShards;
  const legacyRemote = versionedShards.length === 0
    ? await loadLegacyRemoteManifest(backend, syncConfig)
    : { manifest: defaultManifest(), exists: false, skipped: true };
  const sources = versionedShards.length > 0
    ? maximalSources
    : [
      ...maximalSources,
      ...(legacyRemote.exists || maximalSources.length === 0
        ? [{ id: objectKey(syncConfig, LEGACY_MANIFEST_FILE), manifest: legacyRemote.manifest }]
        : []),
    ];
  const manifest = mergeRemoteManifests(sources, syncConfig);
  const maximalVersionedShards = maximalSources.filter((source) => source.manifest.shardMeta);
  // Physical shard cleanup is not a causal event. Carry every observed dot
  // forward even after its object disappears so a delayed old PUT remains
  // dominated by the next full snapshot from this client.
  const observedVector = mergeCausalVectors(
    state.shardCausalSeen,
    ...maximalVersionedShards.flatMap(({ manifest: shard }) => [
      shard.shardMeta.seen,
      { [shard.shardMeta.clientId]: shard.shardMeta.generation },
    ])
  );
  if (Object.keys(observedVector).length > MAX_MANIFEST_SHARDS) {
    throw new Error(`Remote sync exceeds the ${MAX_MANIFEST_SHARDS} device limit.`);
  }
  state.shardCausalSeen = observedVector;
  const clientId = /^[A-Za-z0-9-]{1,128}$/.test(state.clientId || '')
    ? state.clientId
    : randomId();
  state.clientId = clientId;
  const maximalKeys = new Set(maximalSources.map(({ id }) => id));
  return {
    mode: 'sharded',
    manifest,
    exists: legacyRemote.exists || availableShards.length > 0,
    shardPrefix,
    shardKey: null,
    legacyRemote,
    observedVector,
    loadedShards: availableShards.map(({ id, etag }) => ({ key: id, etag: etag || null })),
    dominatedShards: versionedShards.length > 0
      ? availableShards
        .filter(({ id }) => !maximalKeys.has(id))
        .map(({ id, etag }) => ({ key: id, etag: etag || null }))
      : [],
    hasCausalAuthority: versionedShards.length > 0,
    needsConsolidation: (
      availableShards.length > 0
      && (versionedShards.length === 0 || maximalSources.length > 1)
    ) || (availableShards.length === 0 && legacyRemote.exists)
      || manifest.resolvedPathConflicts > 0,
  };
}

async function assertConditionalAuthorityAvailable(backend, syncConfig) {
  const { shardObjects } = await listManifestShardObjects(
    backend,
    syncConfig,
    'Conditional sync mode requires object-list permission while establishing manifest authority.'
  );
  if (shardObjects.length > 0) {
    throw new Error(
      'This destination already uses sharded manifests. Keep sharded mode, or choose a new prefix '
      + 'before switching to conditional mode.'
    );
  }
}

async function loadRemoteManifest(backend, syncConfig, state = null) {
  if (usesShardedManifest(syncConfig)) {
    return loadShardedRemoteManifest(backend, syncConfig, state || freshState(syncConfig));
  }
  if (
    state?.manifestMode === 'sharded'
    || Object.keys(state?.manifestShards || {}).length > 0
  ) {
    throw new Error(
      'This destination already uses sharded manifests. Keep sharded mode, or choose a new prefix '
      + 'before switching to conditional mode.'
    );
  }
  const current = await loadSingleRemoteManifest(backend, syncConfig, state);
  // manifest.v3.json is permanent conditional authority. Established clients
  // need only its conditional GET; LIST is reserved for first-use/migration.
  if (current.exists) {
    if (state && !state.authorityMarkerVerified) {
      const marker = await assertAuthorityMarkerCompatible(
        backend,
        syncConfig,
        'conditional'
      );
      state.authorityMarkerVerified = authorityMarkerCommitted(marker, 'conditional');
      if (!state.authorityMarkerVerified) {
        await assertConditionalAuthorityAvailable(backend, syncConfig);
      }
    }
    // See the sharded counterpart above. Only the authority-creating client
    // pays this one follow-up LIST; established conditional sync remains one
    // conditional GET per warm run.
    if (state?.pendingModeConfirmation) {
      try {
        await assertConditionalAuthorityAvailable(backend, syncConfig);
      } catch (error) {
        await recordAuthorityConflict(backend, syncConfig);
        throw error;
      }
      state.pendingModeConfirmation = false;
    }
    return current;
  }
  await assertAuthorityMarkerCompatible(backend, syncConfig, 'conditional', { missing: true });
  await assertConditionalAuthorityAvailable(backend, syncConfig);
  const legacy = await loadLegacyRemoteManifest(backend, syncConfig);
  return {
    manifest: legacy.manifest,
    etag: null,
    exists: false,
    importedLegacy: legacy.exists,
    // Publish even an empty manifest so the chosen authority becomes durable
    // and subsequent no-op syncs keep the one-GET warm path.
    needsConsolidation: true,
  };
}

async function reserveShardGeneration(syncConfig, state, remote) {
  const clientId = state?.clientId;
  const persisted = await loadState(syncConfig);
  const generation = Math.max(
    Number(persisted.shardGeneration) || 0,
    Number(state?.shardGeneration) || 0,
    Number(remote.observedVector?.[clientId]) || 0
  );
  if (!Number.isSafeInteger(generation) || generation >= Number.MAX_SAFE_INTEGER) {
    throw new Error('The sync manifest shard generation limit has been reached.');
  }
  const nextGeneration = generation + 1;
  // Reserve the dot before the network request. An ambiguous timeout may have
  // committed remotely, so reusing this generation could create two divergent
  // snapshots with the same causal identity. Gaps are safe and monotonic.
  persisted.clientId = clientId;
  persisted.shardGeneration = nextGeneration;
  persisted.shardCausalSeen = mergeCausalVectors(
    persisted.shardCausalSeen,
    state.shardCausalSeen,
    remote.observedVector
  );
  await saveState(persisted, syncConfig);
  state.shardGeneration = nextGeneration;
  return nextGeneration;
}

async function saveRemoteManifest(backend, syncConfig, manifest, remote = {}, state = null) {
  manifest.version = 2;
  manifest.integrityVersion = manifestIntegrityVersion(manifest.files);
  manifest.updatedAt = nowIso();
  manifest.revision = randomId();
  if (remote.mode === 'sharded') {
    const creatingAuthority = !remote.hasCausalAuthority;
    if (creatingAuthority) {
      await assertAuthorityMarkerCompatible(backend, syncConfig, 'sharded');
      await writeAuthorityMarker(backend, syncConfig, 'sharded');
      await assertAuthorityMarkerCompatible(backend, syncConfig, 'sharded');
    }
    const clientId = state?.clientId;
    if (!/^[A-Za-z0-9-]{1,128}$/.test(clientId || '')) {
      throw new Error('The local sync shard client ID is invalid.');
    }
    const nextGeneration = await reserveShardGeneration(syncConfig, state, remote);
    const attemptId = randomShardAttemptId();
    const shardKey = `${remote.shardPrefix}${clientId}.${nextGeneration}.${attemptId}.json`;
    const causalBase = remote.observedVector;
    const seen = mergeCausalVectors(causalBase, { [clientId]: nextGeneration });
    if (Object.keys(seen).length > MAX_MANIFEST_SHARDS) {
      throw new Error(`Remote sync exceeds the ${MAX_MANIFEST_SHARDS} device limit.`);
    }
    manifest.shardMeta = { clientId, generation: nextGeneration, attemptId, seen };
    assertManifestCommitSize(manifest);
    const result = await backend.putJson(shardKey, manifest);
    if (creatingAuthority) await writeAuthorityMarker(backend, syncConfig, 'sharded', true);
    if (state) {
      state.shardGeneration = nextGeneration;
      state.shardCausalSeen = seen;
      state.shardedManifestEstablished = true;
      if (creatingAuthority) state.authorityMarkerVerified = true;
      if (creatingAuthority) state.pendingModeConfirmation = true;
      state.manifestShards[shardKey] = {
        etag: result?.etag || null,
        manifest: cloneManifest(manifest),
      };
    }
    remote.shardKey = shardKey;
    remote.dominatedShards = (remote.loadedShards || []).filter(({ key }) => (
      key !== remote.shardKey
    ));
    // Do not rewrite the legacy single manifest. Older clients mutate the Yjs
    // object they read, which is unsafe when that object is content-addressed.
    // Existing legacy data is imported only while no causal shard exists.
    remote.observedVector = seen;
    remote.needsConsolidation = false;
    remote.exists = true;
    return result;
  }
  const options = remote.etag
    ? { ifMatch: remote.etag }
    : (remote.exists ? {} : { ifNoneMatch: '*' });
  const key = objectKey(syncConfig, MANIFEST_FILE);
  if (remote.exists && !remote.etag) {
    throw new Error(
      'The sync manifest ETag is not exposed. Add ETag to bucket CORS ExposeHeaders, '
      + 'or use manifestMode "sharded" for a provider without conditional writes.'
    );
  }

  try {
    const creatingAuthority = !remote.exists;
    if (creatingAuthority) {
      await assertAuthorityMarkerCompatible(backend, syncConfig, 'conditional');
      await writeAuthorityMarker(backend, syncConfig, 'conditional');
      await assertAuthorityMarkerCompatible(backend, syncConfig, 'conditional');
    }
    assertManifestCommitSize(manifest);
    const result = await backend.putJson(key, manifest, options);
    if (creatingAuthority) await writeAuthorityMarker(backend, syncConfig, 'conditional', true);
    remote.etag = result?.etag || null;
    remote.exists = true;
    if (state) {
      state.conditionalManifestEstablished = true;
      if (creatingAuthority) state.authorityMarkerVerified = true;
      if (creatingAuthority) state.pendingModeConfirmation = true;
    }
    return result;
  } catch (err) {
    if (!isConditionalRequestUnsupported(err)) throw err;
    throw new Error(
      'This backend does not support conditional manifest writes. Configure manifestMode "sharded" '
      + 'to enable concurrency-safe sync.',
      { cause: err }
    );
  }
}

async function verifyConditionalManifestWrites(backend, syncConfig) {
  const probeId = randomId();
  const key = objectKey(syncConfig, `.probe/conditional-${probeId}`);
  const firstPayload = new TextEncoder().encode('vertex-agent-conditional-probe-1');
  const secondPayload = new TextEncoder().encode('vertex-agent-conditional-probe-2');
  let created = false;
  try {
    const createdResult = await backend.putBytes(
      key,
      firstPayload,
      'application/octet-stream',
      { ifNoneMatch: '*' }
    );
    created = true;
    const metadata = typeof backend.getBytesWithMetadata === 'function'
      ? await backend.getBytesWithMetadata(key, { maxBytes: firstPayload.byteLength })
      : null;
    const etag = createdResult?.etag || metadata?.etag || null;
    if (!etag) {
      throw new Error('Conditional sync mode requires ETag to be exposed by bucket CORS.');
    }
    let rejectedDuplicate = false;
    try {
      await backend.putBytes(
        key,
        secondPayload,
        'application/octet-stream',
        { ifNoneMatch: '*' }
      );
    } catch (err) {
      if (!isConditionalWriteConflictError(err)) throw err;
      rejectedDuplicate = true;
    }
    if (!rejectedDuplicate) {
      throw new Error('This backend ignored the conditional create header required for safe sync.');
    }
    let rejectedStaleUpdate = false;
    try {
      await backend.putBytes(
        key,
        secondPayload,
        'application/octet-stream',
        { ifMatch: `"vertex-agent-stale-${probeId}"` }
      );
    } catch (err) {
      if (!isConditionalWriteConflictError(err)) throw err;
      rejectedStaleUpdate = true;
    }
    if (!rejectedStaleUpdate) {
      throw new Error('This backend ignored the conditional update header required for safe sync.');
    }
    await backend.putBytes(
      key,
      secondPayload,
      'application/octet-stream',
      { ifMatch: etag }
    );
  } catch (err) {
    if (!isConditionalRequestUnsupported(err)) throw err;
    throw new Error(
      'This backend does not support conditional manifest writes. Configure sharded manifest mode.',
      { cause: err }
    );
  } finally {
    if (created) {
      try { await backend.delete(key); } catch { /* retry is unnecessary for a random probe */ }
    }
  }
}

async function conditionalDeleteCapability(backend, syncConfig) {
  const scope = syncCredentialScope(syncConfig);
  if (conditionalDeleteCapabilities.has(scope)) {
    return conditionalDeleteCapabilities.get(scope);
  }
  const probeId = randomId();
  const key = objectKey(syncConfig, `.probe/conditional-delete-${probeId}`);
  const payload = new TextEncoder().encode('vertex-agent-conditional-delete-probe');
  let exists = false;
  try {
    const putResult = await backend.putBytes(key, payload, 'application/octet-stream');
    exists = true;
    const metadata = putResult?.etag
      ? null
      : (typeof backend.getBytesWithMetadata === 'function'
        ? await backend.getBytesWithMetadata(key, { maxBytes: payload.byteLength })
        : null);
    const etag = putResult?.etag || metadata?.etag || null;
    if (!etag) {
      conditionalDeleteCapabilities.set(scope, false);
      return false;
    }

    try {
      await backend.delete(key, { ifMatch: `"vertex-agent-stale-${probeId}"` });
      exists = false;
      // The backend ignored If-Match. Never delete mutable shard keys here.
      conditionalDeleteCapabilities.set(scope, false);
      return false;
    } catch (err) {
      if (isConditionalRequestUnsupported(err)) {
        conditionalDeleteCapabilities.set(scope, false);
        return false;
      }
      if (!isConditionalWriteConflictError(err)) return null;
    }

    await backend.delete(key, { ifMatch: etag });
    exists = false;
    conditionalDeleteCapabilities.set(scope, true);
    return true;
  } catch (err) {
    if (isConditionalRequestUnsupported(err)) {
      conditionalDeleteCapabilities.set(scope, false);
      return false;
    }
    return null;
  } finally {
    if (exists) {
      try { await backend.delete(key); } catch { /* random probe cleanup is best effort */ }
    }
  }
}

async function cleanupDominatedManifestShards(backend, syncConfig, state, remote) {
  const shardPrefix = `${objectKey(syncConfig, MANIFEST_SHARD_DIR)}/`;
  const candidates = [...new Map((remote?.dominatedShards || [])
    .filter(({ key }) => (
      key !== remote.shardKey
      && typeof key === 'string'
      && isManifestShardObject(key, shardPrefix)
    ))
    .map((candidate) => [candidate.key, candidate])).values()];
  if (candidates.length === 0) return 0;
  const immutableCandidates = candidates.filter(({ key }) => (
    parseManifestShardObject(key, shardPrefix)?.immutable
  ));
  const mutableCandidates = candidates.filter(({ key, etag }) => (
    !parseManifestShardObject(key, shardPrefix)?.immutable
    && typeof etag === 'string'
    && etag
  ));
  const deleteCandidate = async ({ key, etag }, conditional) => {
    try {
      await backend.delete(key, conditional ? { ifMatch: etag } : {});
      delete state.manifestShards?.[key];
      return 1;
    } catch (err) {
      if (conditional && isConditionalRequestUnsupported(err)) {
        conditionalDeleteCapabilities.set(syncCredentialScope(syncConfig), false);
      }
      // Immutable generations can be retried safely. A conditional conflict
      // means a legacy mutable shard advanced after LIST. Other failures are
      // retried after the next authoritative listing.
      return 0;
    }
  };
  const immutableResults = await mapWithConcurrency(
    immutableCandidates,
    (candidate) => deleteCandidate(candidate, false),
    maxConcurrentRequests(syncConfig)
  );
  let mutableResults = [];
  if (
    mutableCandidates.length > 0
    && await conditionalDeleteCapability(backend, syncConfig) === true
  ) {
    mutableResults = await mapWithConcurrency(
      mutableCandidates,
      (candidate) => deleteCandidate(candidate, true),
      maxConcurrentRequests(syncConfig)
    );
  }
  return [...immutableResults, ...mutableResults].reduce((total, value) => total + value, 0);
}

function duplicateRemotePayloadKeys(manifest, syncConfig) {
  const references = new Map();
  const add = (key, size, cacheable) => {
    if (!cacheable || typeof key !== 'string') return;
    const bytes = Number(size);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_PAYLOAD_DEDUPE_CACHE_BYTES) return;
    const existing = references.get(key) || { count: 0, size: bytes };
    existing.count += 1;
    existing.size = Math.max(existing.size, bytes);
    references.set(key, existing);
  };
  for (const [path, entry] of Object.entries(manifest?.files || {})) {
    if (!entry || entry.deleted || entry.restored) continue;
    if (!entry.structured) {
      const key = entry.objectKey || objectKey(syncConfig, objectPath(path));
      add(
        key,
        entry.size,
        matchesContentAddressedKey(syncConfig, 'objects', path, entry.hash, key)
      );
      continue;
    }
    for (const candidate of structuredCandidateEntries(entry)) {
      add(
        candidate.yjsKey,
        candidate.payloadSize,
        matchesContentAddressedKey(
          syncConfig,
          'yjs',
          path,
          candidate.payloadHash || candidate.hash,
          candidate.yjsKey
        )
      );
      if (candidate.baseYjsKey) {
        add(
          candidate.baseYjsKey,
          candidate.basePayloadSize,
          matchesContentAddressedKey(
            syncConfig,
            'yjs',
            path,
            candidate.basePayloadHash || candidate.baseHash,
            candidate.baseYjsKey
          )
        );
      }
    }
  }
  let retainedBytes = 0;
  const keys = new Set();
  for (const [key, { size }] of [...references]
    .filter(([, value]) => value.count > 1)
    .sort((left, right) => left[1].size - right[1].size)) {
    if (retainedBytes + size > MAX_PAYLOAD_DEDUPE_CACHE_BYTES) continue;
    retainedBytes += size;
    keys.add(key);
  }
  return keys;
}

function referencedRemotePayloadKeys(manifest) {
  const keys = new Set();
  for (const entry of Object.values(manifest?.files || {})) {
    if (!entry || entry.deleted || entry.restored) continue;
    if (entry.objectKey) keys.add(entry.objectKey);
    for (const candidate of structuredCandidateEntries(entry)) {
      if (candidate.yjsKey) keys.add(candidate.yjsKey);
      if (candidate.baseYjsKey) keys.add(candidate.baseYjsKey);
    }
  }
  return keys;
}

async function readRemotePayload(backend, key, maxBytes, cache = null, cacheableKeys = null) {
  if (!cache) return backend.getBytes(key, { maxBytes });
  const retain = cacheableKeys?.has(key);
  let pending = cache.get(key);
  if (!pending) {
    pending = backend.getBytes(key, { maxBytes });
    cache.set(key, pending);
  }
  try {
    return await pending;
  } finally {
    if (!retain && cache.get(key) === pending) cache.delete(key);
  }
}

async function readRemoteStructuredData(
  backend,
  syncConfig,
  path,
  entry,
  payloadReadCache = null,
  cacheablePayloadKeys = null
) {
  const candidates = structuredCandidateEntries(entry);
  if (candidates.length === 0) return null;
  const declaredAggregateSize = candidates.reduce((total, candidate) => (
    total + (candidate.payloadHash && Number.isSafeInteger(Number(candidate.payloadSize))
      ? Number(candidate.payloadSize)
      : 0)
  ), 0);
  if (declaredAggregateSize > MAX_REMOTE_PAYLOAD_BYTES) {
    throw new Error(`Remote structured candidates exceed the 512 MiB aggregate limit: ${path}`);
  }
  let downloadedBytes = 0;
  const snapshots = await mapWithConcurrency(candidates, async (candidate) => {
    const remainingBytes = MAX_REMOTE_PAYLOAD_BYTES - downloadedBytes;
    const readLimit = Math.min(
      structuredPayloadReadLimit(candidate.payloadHash ? candidate.payloadSize : null),
      remainingBytes
    );
    const update = await readRemotePayload(
      backend,
      candidate.yjsKey,
      readLimit,
      payloadReadCache,
      cacheablePayloadKeys
    );
    if (!update) throw new Error(`Remote structured payload is missing: ${path}`);
    if (Number(update.byteLength) > readLimit) {
      throw new Error(`Remote structured payload exceeds its download limit: ${path}`);
    }
    if (
      candidate.payloadHash
      && candidate.payloadSize != null
      && Number(update.byteLength) !== Number(candidate.payloadSize)
    ) {
      throw new Error(`Remote structured payload size does not match its manifest: ${path}`);
    }
    downloadedBytes += Number(update.byteLength) || 0;
    if (downloadedBytes > MAX_REMOTE_PAYLOAD_BYTES) {
      throw new Error(`Remote structured payloads exceed the 512 MiB aggregate limit: ${path}`);
    }
    if (candidate.payloadHash && await hashBytes(update) !== candidate.payloadHash) {
      throw new Error(`Remote structured encoded payload failed integrity validation: ${path}`);
    }
    const data = readStructuredUpdate(update);
    if (candidate.hashType === 'content') {
      const content = formatStructuredContent(path, data);
      const contentBytes = new TextEncoder().encode(content);
      if (candidate.size != null && contentBytes.byteLength !== Number(candidate.size)) {
        throw new Error(`Remote structured content size does not match its manifest: ${path}`);
      }
      const actualHash = await hashBytes(contentBytes);
      if (actualHash !== candidate.hash) {
        throw new Error(`Remote structured object failed integrity validation: ${path}`);
      }
    }
    return { candidate, update, data };
  // Structured candidate reads happen inside the file-level transfer pool.
  // Keeping each file's candidates sequential prevents nested pools from
  // multiplying the configured request/memory bound (for example 8 x 8).
  }, 1);

  if (snapshots.length === 1) {
    return { data: snapshots[0].data, candidateCount: 1 };
  }

  const bases = new Map();
  for (const { candidate } of snapshots) {
    if (!candidate.baseYjsKey) continue;
    const signature = [
      candidate.baseYjsKey,
      candidate.baseHash || '',
      candidate.basePayloadHash || '',
      candidate.basePayloadSize ?? '',
      candidate.baseSize ?? '',
    ].join('\u0000');
    if (bases.has(signature)) continue;
    const remainingBytes = MAX_REMOTE_PAYLOAD_BYTES - downloadedBytes;
    if (remainingBytes <= 0) {
      throw new Error(`Remote structured payloads exceed the 512 MiB aggregate limit: ${path}`);
    }
    const baseReadLimit = Math.min(
      structuredPayloadReadLimit(
        candidate.basePayloadHash ? candidate.basePayloadSize : null
      ),
      remainingBytes
    );
    const baseUpdate = await readRemotePayload(
      backend,
      candidate.baseYjsKey,
      baseReadLimit,
      payloadReadCache,
      cacheablePayloadKeys
    );
    if (!baseUpdate) throw new Error(`Remote structured merge base is missing: ${path}`);
    if (Number(baseUpdate.byteLength) > baseReadLimit) {
      throw new Error(`Remote structured merge base exceeds its download limit: ${path}`);
    }
    if (
      candidate.basePayloadHash
      && candidate.basePayloadSize != null
      && Number(baseUpdate.byteLength) !== Number(candidate.basePayloadSize)
    ) {
      throw new Error(`Remote structured merge base size does not match its manifest: ${path}`);
    }
    downloadedBytes += Number(baseUpdate.byteLength) || 0;
    if (downloadedBytes > MAX_REMOTE_PAYLOAD_BYTES) {
      throw new Error(`Remote structured payloads exceed the 512 MiB aggregate limit: ${path}`);
    }
    if (
      candidate.basePayloadHash
      && await hashBytes(baseUpdate) !== candidate.basePayloadHash
    ) {
      throw new Error(`Remote structured encoded merge base failed integrity validation: ${path}`);
    }
    const baseData = readStructuredUpdate(baseUpdate);
    const baseContent = formatStructuredContent(path, baseData);
    const baseContentBytes = new TextEncoder().encode(baseContent);
    if (
      candidate.baseSize != null
      && baseContentBytes.byteLength !== Number(candidate.baseSize)
    ) {
      throw new Error(`Remote structured merge base size does not match its manifest: ${path}`);
    }
    if (await hashBytes(baseContentBytes) !== candidate.baseHash) {
      throw new Error(`Remote structured merge base failed integrity validation: ${path}`);
    }
    bases.set(signature, baseData);
  }

  // Begin with every full head so unchanged values inherited by one branch are
  // not mistaken for deletions on another branch. Then replay each head's
  // delta against its own immediate base. This preserves cross-branch fields
  // while making explicit deletions survive even when candidates stalled on
  // different logical revisions/bases.
  let data = mergeStructuredUpdates(snapshots.map(({ update }) => update)).data;
  for (const { candidate, data: candidateData } of snapshots) {
    if (!candidate.baseYjsKey) continue;
    const signature = [
      candidate.baseYjsKey,
      candidate.baseHash || '',
      candidate.basePayloadHash || '',
      candidate.basePayloadSize ?? '',
      candidate.baseSize ?? '',
    ].join('\u0000');
    data = mergeStructuredThreeWay(bases.get(signature), data, candidateData);
  }
  return { data, candidateCount: snapshots.length };
}

function localStateFields(entry) {
  return {
    hash: entry?.hash || null,
    size: Number(entry?.size) || 0,
    lastModified: Number(entry?.lastModified) || 0,
    ...localCacheFields(entry),
  };
}

function localCacheFields(entry) {
  return {
    cachedHash: entry?.hash || null,
    cachedSize: Number(entry?.size) || 0,
    cachedLastModified: Number(entry?.lastModified) || 0,
    cacheInvalidated: false,
  };
}

function stateAfterAppliedRemote(localEntry, baselineHash) {
  if (baselineHash && baselineHash !== localEntry?.hash) {
    return {
      hash: baselineHash,
      size: -1,
      lastModified: -1,
      ...localCacheFields(localEntry),
    };
  }
  return localStateFields(localEntry);
}

async function localSnapshotStillCurrent(path, localEntry, options = {}) {
  if (!localEntry) {
    try {
      await readPathBlob(path);
      return false;
    } catch (error) {
      if (isMissingLocalPathError(error)) return true;
      throw error;
    }
  }
  try {
    const current = await readPathBlob(path);
    if (
      !options.verifyHash
      && current.size === localEntry.size
      && Number(current.lastModified) === Number(localEntry.lastModified)
    ) return true;
    return await hashBlob(current) === localEntry.hash;
  } catch (error) {
    if (isMissingLocalPathError(error)) return false;
    throw error;
  }
}

async function applyRemoteFile(
  backend,
  syncConfig,
  path,
  entry,
  localEntry,
  deletedSessionIds = new Set(),
  deletedAgentIds = new Set(),
  options = {}
) {
  if (entry.structured) {
    const remoteSnapshot = await readRemoteStructuredData(
      backend,
      syncConfig,
      path,
      entry,
      options.payloadReadCache,
      options.cacheablePayloadKeys
    );
    if (!remoteSnapshot) return null;
    if (!(await localSnapshotStillCurrent(path, localEntry))) return { conflict: true };

    const localRawData = localEntry ? parseStructuredContent(path, await localEntry.blob.text()) : undefined;
    const remoteRawData = remoteSnapshot.data;
    const deletedLlmRecords = collectDeletedRecordIds(path, localRawData, remoteRawData);
    const remoteData = pruneDeletedRecords(
      path,
      remoteRawData,
      deletedSessionIds,
      deletedAgentIds,
      deletedLlmRecords
    );
    const remoteSyncData = isConfigPath(path) ? stripLocalOnlyConfig(remoteData) : remoteData;
    const remoteContent = formatStructuredContent(path, remoteSyncData);
    const remoteHash = await hashBytes(new TextEncoder().encode(remoteContent));
    let finalSyncData = remoteSyncData;
    let merged = remoteSnapshot.candidateCount > 1;
    if (localEntry && options.mergeLocal) {
      const localData = pruneDeletedRecords(
        path,
        localRawData,
        deletedSessionIds,
        deletedAgentIds,
        deletedLlmRecords
      );
      const localSyncData = isConfigPath(path) ? stripLocalOnlyConfig(localData) : localData;
      const baseData = await readStructuredBase(path, syncConfig);
      finalSyncData = baseData === undefined
        ? mergeStructuredUpdates([createStructuredUpdate(remoteSyncData), createStructuredUpdate(localSyncData)]).data
        : mergeStructuredThreeWay(baseData, localSyncData, remoteSyncData, {
          localUpdatedAt: localEntry.lastModified,
          remoteUpdatedAt: Date.parse(entry.updatedAt || 0),
        });
      merged = true;
    }

    const finalData = preserveLocalOnlyConfig(path, finalSyncData, localRawData);
    const content = formatStructuredContent(path, finalData);
    const baselineData = preserveLocalOnlyConfig(path, remoteSyncData, localRawData);
    const baselineContent = formatStructuredContent(path, baselineData);
    if (!(await localSnapshotStillCurrent(path, localEntry, { verifyHash: true }))) {
      return { conflict: true };
    }
    await writePathText(path, content, { internal: true });
    await writeStructuredBase(path, remoteSyncData, syncConfig);
    return {
      merged,
      remoteHash,
      baselineLocalHash: await hashBytes(new TextEncoder().encode(baselineContent)),
      syncData: finalSyncData,
      content,
    };
  }

  const readLimit = entry.size != null && Number.isSafeInteger(Number(entry.size))
    ? Number(entry.size)
    : MAX_REMOTE_PAYLOAD_BYTES;
  const remoteObjectKey = entry.objectKey || objectKey(syncConfig, objectPath(path));
  const bytes = await readRemotePayload(
    backend,
    remoteObjectKey,
    readLimit,
    options.payloadReadCache,
    options.cacheablePayloadKeys
  );
  if (!bytes) throw new Error(`Remote object payload is missing: ${path}`);
  if (Number(bytes.byteLength) > readLimit) {
    throw new Error(`Remote object payload exceeds its download limit: ${path}`);
  }
  if (entry.size != null && Number(bytes.byteLength) !== Number(entry.size)) {
    throw new Error(`Remote object payload size does not match its manifest: ${path}`);
  }
  if (entry.hash && await hashBytes(bytes) !== entry.hash) {
    throw new Error(`Remote object failed integrity validation: ${path}`);
  }
  if (!(await localSnapshotStillCurrent(path, localEntry, { verifyHash: true }))) return { conflict: true };
  await writePathBytes(path, bytes, { internal: true });
  return { merged: false, remoteHash: entry.hash || await hashBytes(bytes) };
}

function remoteEntryChanged(entry, previous) {
  if (!previous) return true;
  const fingerprint = remoteEntryFingerprint(entry);
  if (previous.remoteFingerprint) return fingerprint !== previous.remoteFingerprint;
  if (entry.hash && previous.remoteHash) return entry.hash !== previous.remoteHash;
  return entry.updatedAt !== previous.remoteUpdatedAt;
}

function remoteEntryFingerprint(entry = {}) {
  return JSON.stringify({
    deleted: Boolean(entry.deleted),
    restored: Boolean(entry.restored),
    structured: Boolean(entry.structured),
    hash: entry.hash || null,
    objectKey: entry.objectKey || null,
    yjsKey: entry.yjsKey || null,
    payloadSize: entry.payloadSize == null ? null : Number(entry.payloadSize),
    payloadHash: entry.payloadHash || null,
    baseYjsKey: entry.baseYjsKey || null,
    baseHash: entry.baseHash || null,
    baseSize: Number(entry.baseSize) || 0,
    basePayloadSize: entry.basePayloadSize == null ? null : Number(entry.basePayloadSize),
    basePayloadHash: entry.basePayloadHash || null,
    revision: entryRevision(entry),
    revisionBy: entry.revisionBy || null,
    candidates: structuredCandidateEntries(entry).map((candidate) => ({
      hash: candidate.hash || null,
      yjsKey: candidate.yjsKey,
      payloadSize: candidate.payloadSize == null ? null : Number(candidate.payloadSize),
      payloadHash: candidate.payloadHash || null,
      baseYjsKey: candidate.baseYjsKey || null,
      baseHash: candidate.baseHash || null,
      baseSize: Number(candidate.baseSize) || 0,
      basePayloadSize: candidate.basePayloadSize == null
        ? null
        : Number(candidate.basePayloadSize),
      basePayloadHash: candidate.basePayloadHash || null,
      redactionVersion: candidate.redactionVersion ?? null,
      revision: entryRevision(candidate),
      revisionBy: candidate.revisionBy || null,
    })),
  });
}

function findDeletedAncestor(files = {}, path, includeSelf = false) {
  const candidates = restoredPathCandidates(path);
  const limit = includeSelf ? candidates.length : candidates.length - 1;
  let found = null;
  for (let index = 0; index < limit; index += 1) {
    const candidate = candidates[index];
    if (files[candidate]?.deleted) found = { path: candidate, entry: files[candidate] };
  }
  return found;
}

function localChangedSinceState(localEntry, previous) {
  if (!localEntry) return false;
  if (!previous || previous.deleted || !previous.hash) return true;
  return previous.hash !== localEntry.hash;
}

async function reconcileLocalPathNamespaces(manifestFiles, local, state, syncConfig) {
  const remoteLivePaths = new Set(
    Object.entries(manifestFiles || {})
      .filter(([, entry]) => entry && !entry.deleted && !entry.restored)
      .map(([path]) => path)
  );
  const conflicts = new Map();
  const addConflict = (root, localPath, remotePath) => {
    if (!conflicts.has(root)) {
      conflicts.set(root, { localPaths: new Set(), remotePaths: new Set() });
    }
    conflicts.get(root).localPaths.add(localPath);
    conflicts.get(root).remotePaths.add(remotePath);
  };

  // A local file can be an ancestor of one or more remote files.
  for (const remotePath of remoteLivePaths) {
    for (const ancestor of restoredPathCandidates(remotePath).slice(0, -1)) {
      if (local.has(ancestor)) addConflict(ancestor, ancestor, remotePath);
    }
  }
  // Or a remote file can replace a local directory tree.
  for (const localPath of local.keys()) {
    const remoteAncestor = restoredPathCandidates(localPath)
      .slice(0, -1)
      .find((candidate) => remoteLivePaths.has(candidate));
    if (remoteAncestor) addConflict(remoteAncestor, localPath, remoteAncestor);
  }

  for (const { localPaths } of conflicts.values()) {
    for (const path of localPaths) {
      const localEntry = local.get(path);
      if (!(await localSnapshotStillCurrent(path, localEntry, { verifyHash: true }))) {
        throw new Error(`Local path changed while resolving a sync namespace conflict: ${path}`);
      }
    }
  }

  let removed = 0;
  let remoteRemoved = 0;
  for (const [root, { localPaths, remotePaths }] of conflicts) {
    const localShapeChanged = [...localPaths].some((path) => (
      localChangedSinceState(local.get(path), state.files?.[path])
    ));
    if (localShapeChanged) {
      // A new/edited local shape is unsynchronized user data. Preserve it and
      // remove the incompatible remote live entries from this in-memory
      // manifest; syncNow/pushSync will publish the replacement atomically.
      for (const remotePath of remotePaths) {
        if (manifestFiles[remotePath]) {
          delete manifestFiles[remotePath];
          delete state.files[remotePath];
          remoteRemoved += 1;
        }
      }
      continue;
    }

    const sortedLocalPaths = [...localPaths].sort((left, right) => right.length - left.length);
    for (const path of sortedLocalPaths) {
      if (!(await deletePathNonRecursive(path, { internal: true }))) {
        throw new Error(`Local path changed while resolving a sync namespace conflict: ${path}`);
      }
    }
    if (!localPaths.has(root) && !(await deleteEmptyPathTree(root, { internal: true }))) {
      throw new Error(`Local path changed while resolving a sync namespace conflict: ${root}`);
    }
    for (const path of sortedLocalPaths) {
      await deleteStructuredBase(path, syncConfig);
      local.delete(path);
      delete state.files[path];
      removed += 1;
    }
  }
  return { removed, remoteRemoved };
}

function preferLocalPathNamespaces(manifestFiles, stateFiles, local) {
  const remoteLivePaths = new Set(
    Object.entries(manifestFiles || {})
      .filter(([, entry]) => entry && !entry.deleted && !entry.restored)
      .map(([path]) => path)
  );
  const remotePathsToRemove = new Set();

  for (const localPath of local.keys()) {
    for (const ancestor of restoredPathCandidates(localPath).slice(0, -1)) {
      if (remoteLivePaths.has(ancestor)) remotePathsToRemove.add(ancestor);
      if (stateFiles[ancestor] && !stateFiles[ancestor].deleted) delete stateFiles[ancestor];
    }
  }
  for (const remotePath of remoteLivePaths) {
    const localAncestor = restoredPathCandidates(remotePath)
      .slice(0, -1)
      .find((candidate) => local.has(candidate));
    if (localAncestor) remotePathsToRemove.add(remotePath);
  }
  for (const [statePath, entry] of Object.entries(stateFiles || {})) {
    if (!entry || entry.deleted) continue;
    const localAncestor = restoredPathCandidates(statePath)
      .slice(0, -1)
      .find((candidate) => local.has(candidate));
    if (localAncestor) delete stateFiles[statePath];
  }
  for (const path of remotePathsToRemove) {
    delete manifestFiles[path];
    delete stateFiles[path];
  }
  return remotePathsToRemove.size;
}

async function pullInternal(syncConfig, runtime = {}) {
  const backend = runtime.backend || syncBackendFactory(syncConfig);
  const state = runtime.state || await loadState(syncConfig);
  const remote = runtime.remote || await loadRemoteManifest(backend, syncConfig, state);
  const manifest = remote.manifest;
  const local = runtime.local || await localFileMap(state, syncConfig);
  const payloadReadCache = runtime.payloadReadCache || new Map();
  runtime.payloadReadCache = payloadReadCache;
  const rawConflictPaths = runtime.rawConflictPaths || new Set();
  runtime.rawConflictPaths = rawConflictPaths;
  const cacheablePayloadKeys = duplicateRemotePayloadKeys(manifest, syncConfig);
  const restorePaths = new Set(
    Object.entries(manifest.files || {})
      .filter(([, entry]) => entry?.restored)
      .map(([path]) => path)
  );
  for (const [path, entry] of Object.entries(state.files || {})) {
    if (remote.hasCausalAuthority && entry?.restored && !restorePaths.has(path)) {
      delete state.files[path];
      continue;
    }
    if (!entry?.deleted || !entry.remoteDeleted || findDeletedAncestor(manifest.files, path, true)) {
      continue;
    }
    const hasRestoreAncestor = restoredPathCandidates(path).some((candidate) => (
      restorePaths.has(candidate)
    ));
    if (remote.hasCausalAuthority || hasRestoreAncestor) {
      delete state.files[path];
    }
  }
  for (const [path, entry] of Object.entries(manifest.files || {})) {
    if (!entry?.restored) continue;
    const existing = state.files[path];
    if (!(existing?.deleted && !existing.remoteDeleted && compareEntryVersions(entry, existing) <= 0)) {
      state.files[path] = {
        restored: true,
        deleted: false,
        revision: entryRevision(entry),
        revisionBy: entry.revisionBy || null,
        remoteRevision: entryRevision(entry),
        remoteFingerprint: remoteEntryFingerprint(entry),
      };
    }
  }
  const deletedSessionIds = mergeSets(collectDeletedSessionIds(manifest.files), collectDeletedSessionIds(state.files));
  const deletedAgentIds = mergeSets(collectDeletedAgentIds(manifest.files), collectDeletedAgentIds(state.files));
  const locallyDeletedPaths = collectDeletedPaths(state.files);
  const stats = { downloaded: 0, merged: 0, deleted: 0, skipped: 0, conflicts: 0 };
  const transferTasks = [];
  const handledRemoteDeletions = new Set();
  const protectedRemoteDeletionPaths = new Set();

  // Repair deterministic file-vs-directory winners before opening remote
  // payloads. Unchanged local losers are safe to remove; a changed local shape
  // is preserved and becomes the replacement published by the push phase.
  const namespaceRepair = await reconcileLocalPathNamespaces(
    manifest.files,
    local,
    state,
    syncConfig
  );
  stats.deleted += namespaceRepair.removed;
  stats.conflicts += namespaceRepair.remoteRemoved;
  if (namespaceRepair.remoteRemoved > 0) remote.needsConsolidation = true;

  // A directory tombstone may be the only remote entry for its descendants.
  // Apply it against the local file index before iterating manifest entries.
  for (const [path, scannedEntry] of [...local]) {
    let localEntry = scannedEntry;
    const deletion = findDeletedAncestor(manifest.files, path, true);
    if (!deletion) continue;
    const previous = state.files[path];
    const localWins = localChangedSinceState(localEntry, previous)
      && !isSessionMessagesPath(path);
    if (localWins) {
      if (!(await localSnapshotStillCurrent(path, localEntry, { verifyHash: true }))) {
        localEntry = await currentLocalEntry(path);
        if (localEntry) local.set(path, localEntry);
      }
      stats.conflicts += 1;
      handledRemoteDeletions.add(path);
      protectedRemoteDeletionPaths.add(deletion.path);
      continue;
    }
    if (!(await localSnapshotStillCurrent(path, localEntry, { verifyHash: true }))) {
      localEntry = await currentLocalEntry(path);
      if (localEntry) local.set(path, localEntry);
      stats.conflicts += 1;
      handledRemoteDeletions.add(path);
      protectedRemoteDeletionPaths.add(deletion.path);
      continue;
    }
    if (!(await deletePathNonRecursive(path, { internal: true }))) {
      const current = await currentLocalEntry(path);
      if (current) local.set(path, current);
      stats.conflicts += 1;
      handledRemoteDeletions.add(path);
      protectedRemoteDeletionPaths.add(deletion.path);
      continue;
    }
    await deleteStructuredBase(path, syncConfig);
    local.delete(path);
    locallyDeletedPaths.add(path);
    state.files[path] = {
      ...(previous || {}),
      deleted: true,
      deletedAt: deletion.entry.deletedAt || nowIso(),
      remoteDeleted: true,
      remoteUpdatedAt: deletion.entry.updatedAt || previous?.remoteUpdatedAt || null,
      remoteHash: deletion.entry.hash || previous?.remoteHash || null,
      remoteRevision: entryRevision(deletion.entry),
      revision: entryRevision(deletion.entry),
      revisionBy: deletion.entry.revisionBy || null,
      remoteFingerprint: remoteEntryFingerprint(deletion.entry),
    };
    stats.deleted += 1;
  }

  for (const [path, entry] of Object.entries(manifest.files || {})) {
    if (entry.restored) {
      stats.skipped += 1;
      continue;
    }
    if (handledRemoteDeletions.has(path)) continue;
    if (entry.deleted && protectedRemoteDeletionPaths.has(path)) {
      stats.skipped += 1;
      continue;
    }
    let localEntry = local.get(path);
    const previous = state.files[path];

    const localDeletion = locallyDeletedPaths.has(path)
      ? { path, entry: state.files[path] }
      : findDeletedAncestor(state.files, path);
    if (localDeletion) {
      const remoteWins = !entry.deleted
        && !isSessionMessagesPath(path)
        && compareEntryVersions(entry, localDeletion.entry) > 0;
      if (remoteWins) {
        clearDeletedPathCandidates(state.files, path);
        locallyDeletedPaths.delete(path);
        stats.conflicts += 1;
      } else {
      if (!localEntry) localEntry = await currentLocalEntry(path);
      if (localEntry) {
        if (!(await localSnapshotStillCurrent(path, localEntry, { verifyHash: true }))) {
          const current = await currentLocalEntry(path);
          if (current) local.set(path, current);
          clearDeletedPathCandidates(state.files, path);
          locallyDeletedPaths.delete(path);
          stats.conflicts += 1;
          continue;
        }
        if (!(await deletePathNonRecursive(path, { internal: true }))) {
          const current = await currentLocalEntry(path);
          if (current) local.set(path, current);
          clearDeletedPathCandidates(state.files, path);
          locallyDeletedPaths.delete(path);
          stats.conflicts += 1;
          continue;
        }
        await deleteStructuredBase(path, syncConfig);
        local.delete(path);
        stats.deleted += 1;
      } else {
        stats.skipped += 1;
      }
      state.files[path] = {
        ...(previous || {}),
        ...(localDeletion.entry || {}),
        deleted: true,
        deletedAt: localDeletion.entry?.deletedAt || previous?.deletedAt || nowIso(),
        remoteDeleted: Boolean(localDeletion.entry?.remoteDeleted),
        remoteUpdatedAt: entry.updatedAt || previous?.remoteUpdatedAt || null,
        remoteHash: entry.hash || previous?.remoteHash || null,
        remoteRevision: entryRevision(entry),
        remoteFingerprint: remoteEntryFingerprint(entry),
      };
      continue;
      }
    }

    const remoteDeletion = entry.deleted ? { path, entry } : findDeletedAncestor(manifest.files, path);
    if (remoteDeletion) {
      if (!localEntry) localEntry = await currentLocalEntry(path);
      const localWins = localChangedSinceState(localEntry, previous)
        && !isSessionMessagesPath(path);
      if (localWins) {
        stats.conflicts += 1;
        protectedRemoteDeletionPaths.add(remoteDeletion.path);
      } else {
        if (localEntry && !(await localSnapshotStillCurrent(path, localEntry, { verifyHash: true }))) {
          const current = await currentLocalEntry(path);
          if (current) local.set(path, current);
          stats.conflicts += 1;
          protectedRemoteDeletionPaths.add(remoteDeletion.path);
          continue;
        }
        if (localEntry) {
          if (!(await deletePathNonRecursive(path, { internal: true }))) {
            const current = await currentLocalEntry(path);
            if (current) local.set(path, current);
            stats.conflicts += 1;
            protectedRemoteDeletionPaths.add(remoteDeletion.path);
            continue;
          }
          await deleteStructuredBase(path, syncConfig);
          local.delete(path);
          stats.deleted += 1;
        } else {
          // Descendants were handled individually in the prepass. Avoid a
          // recursive directory removal here: a new child may have been
          // created after the OPFS snapshot and must survive for the next run.
          stats.skipped += 1;
        }
        state.files[path] = {
          ...(previous || {}),
          deleted: true,
          deletedAt: remoteDeletion.entry.deletedAt || nowIso(),
          remoteDeleted: true,
          remoteUpdatedAt: remoteDeletion.entry.updatedAt || previous?.remoteUpdatedAt || null,
          remoteHash: remoteDeletion.entry.hash || previous?.remoteHash || null,
          remoteRevision: entryRevision(remoteDeletion.entry),
          revision: entryRevision(remoteDeletion.entry),
          revisionBy: remoteDeletion.entry.revisionBy || null,
          remoteFingerprint: remoteEntryFingerprint(remoteDeletion.entry),
        };
      }
      continue;
    }

    if (!localEntry) localEntry = await currentLocalEntry(path);
    const localDirty = localChangedSinceState(localEntry, previous);
    const remoteNewer = !localEntry || remoteEntryChanged(entry, previous);

    if (
      localEntry
      && entry.hash
      && entry.hash === localEntry.hash
      && !isConfigPath(path)
      && structuredCandidateEntries(entry).length <= 1
    ) {
      state.files[path] = {
        ...localStateFields(localEntry),
        remoteHash: entry.hash,
        remoteUpdatedAt: entry.updatedAt || null,
        remoteRevision: entryRevision(entry),
        remoteFingerprint: remoteEntryFingerprint(entry),
        yjsKey: entry.yjsKey || null,
        objectKey: entry.objectKey || null,
        deleted: false,
        remoteDeleted: false,
      };
      if (entry.structured && await readStructuredBase(path, syncConfig) === undefined) {
        const localData = parseStructuredContent(path, await localEntry.blob.text());
        await writeStructuredBase(
          path,
          isConfigPath(path) ? stripLocalOnlyConfig(localData) : localData,
          syncConfig
        );
      }
      stats.skipped += 1;
      continue;
    }

    if (!remoteNewer) {
      if (localEntry) {
        state.files[path] = {
          ...(previous || {}),
          ...(localDirty ? localCacheFields(localEntry) : localStateFields(localEntry)),
        };
      }
      stats.skipped += 1;
      continue;
    }

    if (!entry.structured && localDirty) {
      if (!(await localSnapshotStillCurrent(path, localEntry, { verifyHash: true }))) {
        stats.conflicts += 1;
        rawConflictPaths.add(path);
        continue;
      }
      const conflictPath = await rawConflictPath(path, localEntry, entry);
      const existingConflict = local.get(conflictPath) || await currentLocalEntry(conflictPath);
      if (existingConflict && existingConflict.hash !== localEntry.hash) {
        throw new Error(`Sync conflict backup path is unexpectedly occupied: ${conflictPath}`);
      }
      if (!existingConflict) {
        await writePathBlob(conflictPath, localEntry.blob, { internal: true });
      }
      const conflictEntry = existingConflict || await currentLocalEntry(conflictPath);
      if (!conflictEntry) throw new Error(`Failed to preserve local sync conflict: ${path}`);
      local.set(conflictPath, conflictEntry);
      stats.conflicts += 1;
      rawConflictPaths.add(path);
    }

    const transfer = async () => {
      const result = await applyRemoteFile(
        backend,
        syncConfig,
        path,
        entry,
        localEntry,
        deletedSessionIds,
        deletedAgentIds,
        {
          mergeLocal: Boolean(entry.structured && localDirty),
          payloadReadCache,
          cacheablePayloadKeys,
        }
      );
      if (!result || result.conflict) return { path, entry, result };

      const file = await readPathBlob(path);
      return {
        path,
        entry,
        result,
        localEntry: {
          path,
          size: file.size,
          lastModified: file.lastModified,
          hash: await hashBlob(file),
          blob: file,
        },
      };
    };
    transfer.size = remoteTransferSize(entry);
    transferTasks.push(transfer);
  }

  const transferResults = await mapWithConcurrency(
    transferTasks,
    (transfer) => transfer(),
    maxConcurrentRequestsForEntries(syncConfig, transferTasks)
  );
  for (const { path, entry, result, localEntry } of transferResults) {
    const previous = state.files[path];
    if (!result) {
      stats.skipped += 1;
      continue;
    }
    if (result.conflict) {
      stats.conflicts += 1;
      continue;
    }
    rawConflictPaths.delete(path);
    state.files[path] = {
      ...stateAfterAppliedRemote(
        localEntry,
        result.baselineLocalHash || result.remoteHash || entry.hash || previous?.hash || null
      ),
      remoteHash: result.remoteHash || entry.hash || null,
      remoteUpdatedAt: entry.updatedAt,
      remoteRevision: entryRevision(entry),
      remoteFingerprint: remoteEntryFingerprint(entry),
      yjsKey: entry.yjsKey || null,
      objectKey: entry.objectKey || null,
      deleted: false,
      remoteDeleted: false,
    };
    local.set(path, localEntry);
    if (result.merged) stats.merged += 1;
    else stats.downloaded += 1;
  }

  runtime.backend = backend;
  runtime.remote = remote;
  runtime.state = state;
  runtime.local = local;
  if (!runtime.deferStateSave) await saveState(state, syncConfig);
  return stats;
}

async function pushInternal(syncConfig, runtime = {}) {
  const backend = runtime.backend || syncBackendFactory(syncConfig);
  const state = runtime.state || await loadState(syncConfig);
  const remote = runtime.remote || await loadRemoteManifest(backend, syncConfig, state);
  const manifest = remote.manifest;
  const local = runtime.local || await localFileMap(state, syncConfig);
  if (
    !state.authorityMarkerVerified
    && (remote.mode === 'sharded' ? remote.hasCausalAuthority : remote.exists)
  ) {
    const mode = remote.mode === 'sharded' ? 'sharded' : 'conditional';
    const marker = await assertAuthorityMarkerCompatible(backend, syncConfig, mode);
    if (!marker?.[mode]) {
      await writeAuthorityMarker(backend, syncConfig, mode);
      await assertAuthorityMarkerCompatible(backend, syncConfig, mode);
    }
    if (!authorityMarkerCommitted(marker, mode)) {
      await writeAuthorityMarker(backend, syncConfig, mode, true);
    }
    state.authorityMarkerVerified = true;
  }
  const payloadReadCache = runtime.payloadReadCache || new Map();
  runtime.payloadReadCache = payloadReadCache;
  const cacheablePayloadKeys = duplicateRemotePayloadKeys(manifest, syncConfig);
  const payloadUploads = runtime.payloadUploads || new Map();
  const uploadedPayloadKeys = runtime.uploadedPayloadKeys || new Set();
  const knownRemotePayloadKeys = runtime.knownRemotePayloadKeys
    || referencedRemotePayloadKeys(manifest);
  runtime.payloadUploads = payloadUploads;
  runtime.uploadedPayloadKeys = uploadedPayloadKeys;
  runtime.knownRemotePayloadKeys = knownRemotePayloadKeys;
  const uploadPayloadOnce = async (key, body) => {
    if (knownRemotePayloadKeys.has(key)) return false;
    let pending = payloadUploads.get(key);
    if (!pending) {
      pending = backend.putBytes(key, body, 'application/octet-stream');
      payloadUploads.set(key, pending);
      try {
        await pending;
        uploadedPayloadKeys.add(key);
        knownRemotePayloadKeys.add(key);
      } catch (err) {
        payloadUploads.delete(key);
        throw err;
      }
      return true;
    }
    await pending;
    return false;
  };
  // Keep a commit-safe state image for the secret-deletion journal. The live
  // state below is optimistically updated while payloads are prepared; writing
  // that optimistic baseline before the manifest CAS could lose local changes
  // when a retry reloads after a conflict.
  const needsSensitiveDeleteJournal = Object.entries(manifest.files || {}).some(([path, entry]) => (
    isConfigPath(path)
    && entryMayContainUnredactedConfig(entry)
  ));
  let stateBeforePush = null;
  const prospectiveFileCount = prospectiveManifestFileCount(
    manifest.files,
    state.files,
    local
  );
  if (prospectiveFileCount > MAX_MANIFEST_FILES) {
    throw new Error(
      `Sync would create ${prospectiveFileCount} manifest entries, exceeding the `
      + `${MAX_MANIFEST_FILES}-entry safety limit.`
    );
  }
  assertProspectiveManifestPathSize(manifest.files, state.files, local);
  // Fail before uploading content-addressed payloads when a shared manifest
  // cannot be committed safely. Otherwise every retry can leave an orphan.
  if (remote.mode !== 'sharded' && remote.exists && !remote.etag) {
    throw new Error(
      'The sync manifest ETag is not exposed. Add ETag to bucket CORS ExposeHeaders, '
      + 'or use manifestMode "sharded" for a provider without conditional writes.'
    );
  }
  if (remote.mode !== 'sharded' && !state.conditionalWritesVerified) {
    await verifyConditionalManifestWrites(backend, syncConfig);
    state.conditionalWritesVerified = true;
  }
  const stats = { uploaded: 0, merged: 0, deleted: 0, skipped: 0, conflicts: 0 };
  const obsoleteSensitiveKeys = new Set();
  const pendingStructuredBases = new Map();
  let manifestDirty = Boolean(remote.needsConsolidation);
  const restoredVersions = new Map();

  const localNamespaceReplacements = preferLocalPathNamespaces(
    manifest.files,
    state.files,
    local
  );
  if (localNamespaceReplacements > 0) {
    manifestDirty = true;
    stats.conflicts += localNamespaceReplacements;
  }

  if (restoreLocalChangedPathsOverDeletedAncestors(state.files, manifest.files, local, {
    preserveRestoreMarkers: remote.mode === 'sharded',
    revisionBy: state.clientId,
    restoredVersions,
  })) {
    manifestDirty = true;
  }
  stateBeforePush = needsSensitiveDeleteJournal ? structuredClone(state) : null;

  // Convert missing, previously synchronized files into local tombstones.
  for (const [path, previous] of Object.entries(state.files || {})) {
    if (previous.deleted || previous.restored || local.has(path)) continue;
    state.files[path] = { ...previous, ...makeDeleteEntry(previous, state.clientId) };
  }

  // A parent tombstone covers all descendants. Publishing only the minimal
  // roots avoids the previous state-files x manifest-files quadratic loop and
  // prevents the manifest from accumulating redundant child tombstones.
  const publishLocalTombstones = () => {
    const localTombstones = Object.entries(state.files || {})
      .filter(([, entry]) => entry?.deleted)
      .sort(([left], [right]) => left.length - right.length);
    for (const [path, previous] of localTombstones) {
      const exactRemote = manifest.files[path];
      if (findDeletedAncestor(manifest.files, path)) continue;
      if (exactRemote?.deleted && compareEntryVersions(previous, exactRemote) <= 0) continue;
      if (
        exactRemote
        && !exactRemote.deleted
        && !previous.remoteDeleted
        && compareEntryVersions(previous, exactRemote) <= 0
      ) continue;
      const deletionBase = exactRemote && !exactRemote.deleted && previous.remoteDeleted
        ? {
          ...previous,
          deleted: false,
          revision: Math.max(entryRevision(previous), entryRevision(exactRemote)),
          remoteRevision: Math.max(entryRevision(previous), entryRevision(exactRemote)),
        }
        : previous;
      const deleteEntry = makeDeleteEntry(deletionBase, state.clientId);
      if (isConfigPath(path) && exactRemote) {
        collectSensitiveEntryPayloadKeys(
          obsoleteSensitiveKeys,
          syncConfig,
          path,
          exactRemote
        );
      }
      manifest.files[path] = deleteEntry;
      state.files[path] = { ...previous, ...deleteEntry };
      manifestDirty = true;
      stats.deleted += 1;
    }
  };
  publishLocalTombstones();
  assertProspectiveManifestMetadataSize(
    manifest,
    state.files,
    local,
    syncConfig,
    state.clientId,
    Boolean(remote.needsConsolidation)
  );

  const deletedSessionIds = collectDeletedSessionIds(state.files);
  const deletedAgentIds = collectDeletedAgentIds(state.files);

  const localEntries = [...local];
  await mapWithConcurrency(localEntries, async ([path, entry]) => {
    if (Number(entry.size) > MAX_REMOTE_PAYLOAD_BYTES) {
      throw new Error(`Sync file exceeds the 512 MiB safety limit: ${path}`);
    }
    if (runtime.rawConflictPaths?.has(path)) {
      stats.conflicts += 1;
      return;
    }
    let previous = state.files[path];
    let remoteEntry = manifest.files[path];
    const localDeletion = previous?.deleted
      ? { path, entry: previous }
      : findDeletedAncestor(state.files, path);
    if (localDeletion) {
      if (!(await localSnapshotStillCurrent(path, entry, { verifyHash: true }))) {
        stats.conflicts += 1;
        return;
      }
      if (!(await deletePathNonRecursive(path, { internal: true }))) {
        throw new Error(`Local path changed while applying a sync deletion: ${path}`);
      }
      await deleteStructuredBase(path, syncConfig);
      const deleteEntry = makeDeleteEntry(previous || remoteEntry || entry, state.clientId);
      if (!remoteEntry?.deleted && !findDeletedAncestor(manifest.files, path)) {
        if (isConfigPath(path) && remoteEntry) {
          collectSensitiveEntryPayloadKeys(
            obsoleteSensitiveKeys,
            syncConfig,
            path,
            remoteEntry
          );
        }
        manifest.files[path] = deleteEntry;
        manifestDirty = true;
      }
      state.files[path] = { ...(previous || {}), ...deleteEntry };
      stats.deleted += 1;
      return;
    }

    const remoteDeletion = remoteEntry?.deleted
      ? { path, entry: remoteEntry }
      : findDeletedAncestor(manifest.files, path);
    if (remoteDeletion) {
      const localWins = localChangedSinceState(entry, previous)
        && !isSessionMessagesPath(path);
      if (!localWins) {
        if (!(await localSnapshotStillCurrent(path, entry, { verifyHash: true }))) {
          stats.conflicts += 1;
          return;
        }
        if (!(await deletePathNonRecursive(path, { internal: true }))) {
          throw new Error(`Local path changed while applying a remote sync deletion: ${path}`);
        }
        await deleteStructuredBase(path, syncConfig);
        state.files[path] = {
          ...(previous || {}),
          deleted: true,
          deletedAt: remoteDeletion.entry.deletedAt || nowIso(),
          remoteDeleted: true,
          remoteUpdatedAt: remoteDeletion.entry.updatedAt || previous?.remoteUpdatedAt || null,
          remoteHash: remoteDeletion.entry.hash || previous?.remoteHash || null,
          remoteRevision: entryRevision(remoteDeletion.entry),
          revision: entryRevision(remoteDeletion.entry),
          revisionBy: remoteDeletion.entry.revisionBy || null,
          remoteFingerprint: remoteEntryFingerprint(remoteDeletion.entry),
        };
        stats.deleted += 1;
        return;
      }
      if (!(await localSnapshotStillCurrent(path, entry, { verifyHash: true }))) {
        stats.conflicts += 1;
        return;
      }
      const restoredEntries = restoredVersions.get(path) || [];
      restoredEntries.push(previous, remoteDeletion.entry);
      restoredVersions.set(path, restoredEntries.filter(Boolean));
      if (clearDeletedPathCandidates(manifest.files, path, {
        preserveRestoreMarkers: remote.mode === 'sharded',
        revisionBy: state.clientId,
        restoredEntries,
      })) manifestDirty = true;
      clearDeletedPathCandidates(state.files, path, {
        preserveRestoreMarkers: remote.mode === 'sharded',
        revisionBy: state.clientId,
        restoredEntries,
      });
      previous = state.files[path];
      remoteEntry = manifest.files[path];
    }

    const agentId = agentIdFromWorkspacePath(path);
    if (deletedAgentIds.has(agentId) && isAgentWorkspacePath(path)) {
      if (!(await localSnapshotStillCurrent(path, entry, { verifyHash: true }))) {
        stats.conflicts += 1;
        return;
      }
      if (!(await deletePathNonRecursive(path, { internal: true }))) {
        throw new Error(`Local path changed while pruning a deleted agent: ${path}`);
      }
      await deleteStructuredBase(path, syncConfig);
      const deleteEntry = makeDeleteEntry(previous || remoteEntry || entry, state.clientId);
      if (!remoteEntry?.deleted && !findDeletedAncestor(manifest.files, path)) {
        manifest.files[path] = deleteEntry;
        manifestDirty = true;
      }
      state.files[path] = { ...(previous || {}), ...deleteEntry };
      stats.deleted += 1;
      return;
    }

    const shouldPruneIndex = (path === 'session.json' && deletedSessionIds.size > 0)
      || (isConfigPath(path) && deletedAgentIds.size > 0);
    const needsSecretScrub = isConfigPath(path)
      && (
        remoteEntry?.redactionVersion !== CONFIG_REDACTION_VERSION
        || structuredCandidateEntries(remoteEntry).some(
          (candidate) => candidate.redactionVersion !== CONFIG_REDACTION_VERSION
        )
      );
    const remoteIntegrityCurrent = remoteEntry?.hashType === 'content'
      && /^[a-f\d]{64}$/i.test(String(remoteEntry.hash || ''))
      && (remoteEntry.structured
        ? (
          /^[a-f\d]{64}$/i.test(String(remoteEntry.payloadHash || ''))
          && matchesContentAddressedKey(
            syncConfig,
            'yjs',
            path,
            remoteEntry.payloadHash,
            remoteEntry.yjsKey
          )
        )
        : matchesContentAddressedKey(
          syncConfig,
          'objects',
          path,
          remoteEntry.hash,
          remoteEntry.objectKey
        ));
    if (
      !shouldPruneIndex
      && !needsSecretScrub
      && remoteIntegrityCurrent
      && previous?.hash === entry.hash
      && remoteEntry
      && !remoteEntry.deleted
      && structuredCandidateEntries(remoteEntry).length <= 1
    ) {
      state.files[path] = { ...previous, ...localStateFields(entry) };
      stats.skipped += 1;
      return;
    }

    const structured = isStructuredPath(path);
    let contentHash = entry.hash;
    let contentSize = entry.size;
    let objectKeyValue = null;
    let yjsKeyValue = null;
    let payloadSizeValue = null;
    let payloadHashValue = null;
    let baseYjsKeyValue = null;
    let baseHashValue = null;
    let baseSizeValue = null;
    let basePayloadSizeValue = null;
    let basePayloadHashValue = null;
    let finalLocalEntry = entry;
    let syncData;
    let remoteContentCurrent = false;

    if (structured) {
      const localText = await entry.blob.text();
      const localRawData = parseStructuredContent(path, localText);
      let localData = pruneDeletedRecords(path, localRawData, deletedSessionIds, deletedAgentIds);
      syncData = isConfigPath(path) ? stripLocalOnlyConfig(localData) : localData;

      const shouldReadRemote = remoteEntry
        && !remoteEntry.deleted
        && (needsSecretScrub || remoteEntryChanged(remoteEntry, previous));
      if (shouldReadRemote) {
        const remoteSnapshot = await readRemoteStructuredData(
          backend,
          syncConfig,
          path,
          remoteEntry,
          payloadReadCache,
          cacheablePayloadKeys
        );
        if (remoteSnapshot) {
          const remoteRawData = remoteSnapshot.data;
          const deletedLlmRecords = collectDeletedRecordIds(path, localRawData, remoteRawData);
          localData = pruneDeletedRecords(
            path,
            localRawData,
            deletedSessionIds,
            deletedAgentIds,
            deletedLlmRecords
          );
          const localSyncData = isConfigPath(path) ? stripLocalOnlyConfig(localData) : localData;
          const remoteData = pruneDeletedRecords(
            path,
            remoteRawData,
            deletedSessionIds,
            deletedAgentIds,
            deletedLlmRecords
          );
          const remoteSyncData = isConfigPath(path) ? stripLocalOnlyConfig(remoteData) : remoteData;
          const baseData = await readStructuredBase(path, syncConfig);
          syncData = baseData === undefined
            ? mergeStructuredUpdates([createStructuredUpdate(remoteSyncData), createStructuredUpdate(localSyncData)]).data
            : mergeStructuredThreeWay(baseData, localSyncData, remoteSyncData, {
              localUpdatedAt: entry.lastModified,
              remoteUpdatedAt: Date.parse(remoteEntry.updatedAt || 0),
            });
          stats.merged += 1;
        }
      }

      const finalData = preserveLocalOnlyConfig(path, syncData, localRawData);
      const finalContent = formatStructuredContent(path, finalData);
      const syncContent = formatStructuredContent(path, syncData);
      const syncBytes = new TextEncoder().encode(syncContent);
      contentHash = await hashBytes(syncBytes);
      contentSize = syncBytes.byteLength;
      if (contentSize > MAX_REMOTE_PAYLOAD_BYTES) {
        throw new Error(`Structured sync file exceeds the 512 MiB safety limit: ${path}`);
      }
      const remotePayloadReusable = remoteEntry?.hashType === 'content'
        && remoteEntry.hash === contentHash
        && /^[a-f\d]{64}$/i.test(String(remoteEntry.payloadHash || ''))
        && Number.isSafeInteger(Number(remoteEntry.payloadSize))
        && matchesContentAddressedKey(
          syncConfig,
          'yjs',
          path,
          remoteEntry.payloadHash,
          remoteEntry.yjsKey
        );
      let structuredUpdate = null;
      if (remotePayloadReusable) {
        payloadSizeValue = Number(remoteEntry.payloadSize);
        payloadHashValue = remoteEntry.payloadHash;
        yjsKeyValue = remoteEntry.yjsKey;
      } else {
        structuredUpdate = createStructuredUpdate(syncData);
        if (structuredUpdate.byteLength > MAX_REMOTE_PAYLOAD_BYTES) {
          throw new Error(`Encoded structured sync file exceeds the 512 MiB safety limit: ${path}`);
        }
        payloadSizeValue = structuredUpdate.byteLength;
        payloadHashValue = await hashBytes(structuredUpdate);
        yjsKeyValue = objectKey(syncConfig, yjsPath(path, payloadHashValue));
      }

      if (!(await localSnapshotStillCurrent(path, entry, { verifyHash: true }))) {
        stats.conflicts += 1;
        return;
      }
      if (localText !== finalContent) {
        await writePathText(path, finalContent, { internal: true });
        const file = await readPathBlob(path);
        finalLocalEntry = {
          path,
          size: file.size,
          lastModified: file.lastModified,
          hash: await hashBlob(file),
          blob: file,
        };
      }

      const remoteCandidates = structuredCandidateEntries(remoteEntry);
      const remotePayloadCurrent = remotePayloadReusable;
      remoteContentCurrent = remotePayloadCurrent
        && remoteCandidates.length <= 1
        && !restoredVersions.has(path);
      const reusableBaseCandidate = !needsSecretScrub
        && remoteCandidates.length === 1
        && remoteCandidates[0].hashType === 'content'
        && matchesContentAddressedKey(
          syncConfig,
          'yjs',
          path,
          remoteCandidates[0].payloadHash || remoteCandidates[0].hash,
          remoteCandidates[0].yjsKey
        )
        ? remoteCandidates[0]
        : null;
      const preserveRemoteBase = remoteContentCurrent && !needsSecretScrub;
      baseYjsKeyValue = preserveRemoteBase
        ? (remoteEntry?.baseYjsKey || null)
        : (reusableBaseCandidate?.yjsKey || null);
      baseHashValue = preserveRemoteBase
        ? (remoteEntry?.baseHash || null)
        : (reusableBaseCandidate?.hash || null);
      baseSizeValue = preserveRemoteBase
        ? (remoteEntry?.baseSize ?? null)
        : (reusableBaseCandidate?.size ?? null);
      basePayloadSizeValue = preserveRemoteBase
        ? (remoteEntry?.basePayloadSize ?? null)
        : (reusableBaseCandidate?.payloadSize ?? null);
      basePayloadHashValue = preserveRemoteBase
        ? (remoteEntry?.basePayloadHash ?? null)
        : (reusableBaseCandidate?.payloadHash ?? null);
      if (!remotePayloadCurrent) {
        if (!(await uploadPayloadOnce(yjsKeyValue, structuredUpdate))) stats.skipped += 1;
      } else {
        stats.skipped += 1;
      }
      pendingStructuredBases.set(path, syncData);

      if (needsSecretScrub && remoteEntry) {
        const oldObjectKey = remoteEntry?.objectKey || objectKey(syncConfig, objectPath(path));
        const oldYjsKey = remoteEntry?.yjsKey || objectKey(syncConfig, yjsPath(path));
        if (oldObjectKey !== objectKeyValue) obsoleteSensitiveKeys.add(oldObjectKey);
        if (oldYjsKey !== yjsKeyValue) obsoleteSensitiveKeys.add(oldYjsKey);
        if (remoteEntry.baseYjsKey && remoteEntry.baseYjsKey !== yjsKeyValue) {
          obsoleteSensitiveKeys.add(remoteEntry.baseYjsKey);
        }
        for (const candidate of structuredCandidateEntries(remoteEntry)) {
          if (candidate.yjsKey !== yjsKeyValue) obsoleteSensitiveKeys.add(candidate.yjsKey);
          if (candidate.baseYjsKey && candidate.baseYjsKey !== yjsKeyValue) {
            obsoleteSensitiveKeys.add(candidate.baseYjsKey);
          }
        }
      }
    } else {
      const reusableObjectKey = remoteEntry?.hash === contentHash
        && matchesContentAddressedKey(
          syncConfig,
          'objects',
          path,
          contentHash,
          remoteEntry.objectKey
        )
        ? remoteEntry.objectKey
        : null;
      objectKeyValue = reusableObjectKey || objectKey(syncConfig, objectPath(path, contentHash));
      if (!(await localSnapshotStillCurrent(path, entry, { verifyHash: true }))) {
        stats.conflicts += 1;
        return;
      }
      remoteContentCurrent = remoteEntry?.hash === contentHash && remoteEntry?.objectKey === objectKeyValue;
      const remotePayloadCurrent = remoteContentCurrent;
      remoteContentCurrent = remotePayloadCurrent && !restoredVersions.has(path);
      if (!remotePayloadCurrent) {
        if (!(await uploadPayloadOnce(objectKeyValue, entry.blob))) stats.skipped += 1;
      } else {
        stats.skipped += 1;
      }
    }

    const updatedAt = remoteContentCurrent && remoteEntry?.updatedAt
      ? remoteEntry.updatedAt
      : new Date(finalLocalEntry.lastModified || Date.now()).toISOString();
    const revision = remoteContentCurrent
      ? entryRevision(remoteEntry)
      : nextEntryRevision(remoteEntry, previous, ...(restoredVersions.get(path) || []));
    const nextManifestEntry = {
      structured,
      deleted: false,
      hash: contentHash,
      hashType: 'content',
      size: contentSize,
      updatedAt,
      revision,
      revisionBy: remoteContentCurrent ? (remoteEntry?.revisionBy || state.clientId) : state.clientId,
      ...(structured ? {
        yjsKey: yjsKeyValue,
        payloadSize: Number(payloadSizeValue),
        payloadHash: payloadHashValue,
        ...(baseYjsKeyValue ? {
          baseYjsKey: baseYjsKeyValue,
          baseHash: baseHashValue,
          baseSize: Number(baseSizeValue) || 0,
          ...(basePayloadSizeValue != null
            ? { basePayloadSize: Number(basePayloadSizeValue) }
            : {}),
          ...(basePayloadHashValue ? { basePayloadHash: basePayloadHashValue } : {}),
        } : {}),
      } : { objectKey: objectKeyValue }),
      ...(isConfigPath(path) ? {
        redacted: true,
        redactionVersion: CONFIG_REDACTION_VERSION,
      } : {}),
    };
    if (JSON.stringify(remoteEntry || null) !== JSON.stringify(nextManifestEntry)) {
      manifest.files[path] = nextManifestEntry;
      manifestDirty = true;
    }
    state.files[path] = {
      ...localStateFields(finalLocalEntry),
      remoteHash: contentHash,
      remoteUpdatedAt: updatedAt,
      remoteRevision: revision,
      remoteFingerprint: remoteEntryFingerprint(nextManifestEntry),
      ...(structured ? { yjsKey: yjsKeyValue, objectKey: null } : { objectKey: objectKeyValue, yjsKey: null }),
      deleted: false,
      remoteDeleted: false,
    };
  }, maxConcurrentRequestsForEntries(
    syncConfig,
    localEntries.map(([path, entry]) => ({ size: localTransferSize(path, entry) }))
  ));

  // A restored child can clear a remote parent tombstone while sibling local
  // tombstones still depend on it. Re-publish those now-uncovered siblings.
  publishLocalTombstones();

  if (obsoleteSensitiveKeys.size > 0) {
    state.pendingSensitiveDeletes ||= {};
    stateBeforePush.pendingSensitiveDeletes ||= {};
    for (const key of obsoleteSensitiveKeys) {
      const queuedAt = nowIso();
      state.pendingSensitiveDeletes[key] = queuedAt;
      stateBeforePush.pendingSensitiveDeletes[key] = queuedAt;
    }
    // Stage cleanup intent before the remote commit. If the tab closes after
    // the manifest PUT, the old content-addressed secret keys remain
    // discoverable and will be retried by the next push.
    await saveState(stateBeforePush, syncConfig);
  }
  if (manifestDirty) {
    await saveRemoteManifest(backend, syncConfig, manifest, remote, state);
    if (remote.mode !== 'sharded') cacheRemoteManifest(state, manifest, remote.etag);
    if (state.pendingModeConfirmation) {
      // The authority commit is now durable, so persist the follow-up fence
      // before probing the opposite namespace. This catches publications that
      // raced our first write immediately and still checks once more on the
      // next run for a writer that landed just after this probe.
      await saveState(state, syncConfig);
      try {
        if (remote.mode === 'sharded') {
          await assertNoConditionalAuthority(backend, syncConfig);
        } else {
          await assertConditionalAuthorityAvailable(backend, syncConfig);
        }
      } catch (error) {
        await persistAuthorityConflict(backend, syncConfig, state);
        throw error;
      }
    }
  }
  acknowledgeManifestTombstones(state.files, manifest.files);
  stats.cleaned = await cleanupDominatedManifestShards(
    backend,
    syncConfig,
    state,
    remote
  );
  stats.cleaned += await cleanupSensitivePayloads(backend, syncConfig, state, manifest);
  await Promise.all(
    [...pendingStructuredBases].map(([path, data]) => writeStructuredBase(path, data, syncConfig))
  );
  runtime.backend = backend;
  runtime.remote = remote;
  runtime.state = state;
  runtime.local = local;
  stats.uploaded = uploadedPayloadKeys.size;
  if (!runtime.deferStateSave) await saveState(state, syncConfig);
  return stats;
}

function getSyncConfig() {
  return config.get('sync') || {};
}

function setSyncBackendFactoryForTests(factory) {
  const previous = syncBackendFactory;
  conditionalDeleteCapabilities.clear();
  syncBackendFactory = factory;
  return () => {
    conditionalDeleteCapabilities.clear();
    syncBackendFactory = previous;
  };
}

function schedulePendingAutoSyncRun() {
  if (
    !pendingAutoSync
    || activeRun
    || autoRunInProgress
    || autoSyncSuspendDepth > 0
  ) return;
  queueMicrotask(() => {
    if (
      !pendingAutoSync
      || activeRun
      || autoRunInProgress
      || autoSyncSuspendDepth > 0
    ) return;
    pendingAutoSync = false;
    runAutoSync(autoRefreshCallback)
      .catch((err) => console.warn('Queued auto sync failed:', err));
  });
}

async function runExclusive(fn) {
  // Manual pull/push/sync requests must run their requested operation; they
  // must not accidentally receive the result of an unrelated in-flight auto
  // sync. Multiple waiters re-check after every completion to remain serial.
  while (activeRun) {
    try { await activeRun; } catch { /* the queued request still gets its turn */ }
  }
  const operation = Promise.resolve().then(fn);
  const tracked = operation.finally(() => {
    if (activeRun !== tracked) return;
    activeRun = null;
    notifySyncStatus();
    schedulePendingAutoSyncRun();
  });
  activeRun = tracked;
  notifySyncStatus();
  return tracked;
}

export async function waitForSyncIdle() {
  // A completed run may enqueue one coalesced automatic follow-up in its
  // finally handler, so yield once and re-check until the queue is drained.
  do {
    const current = activeRun;
    if (current) {
      try { await current; } catch { /* waiting is independent of run success */ }
    }
    const autoCompletion = activeAutoCompletion;
    if (autoCompletion) await autoCompletion;
    await Promise.resolve();
  } while (
    activeRun
    || autoRunInProgress
    || (pendingAutoSync && autoSyncSuspendDepth === 0)
  );
}

async function runAutoSync(onStorageRestored) {
  if (autoSyncSuspendDepth > 0) {
    pendingAutoSync = true;
    notifySyncStatus();
    return null;
  }
  if (autoRunInProgress) {
    pendingAutoSync = true;
    notifySyncStatus();
    return null;
  }
  autoRunInProgress = true;
  let finishAutoRun;
  const completion = new Promise((resolve) => { finishAutoRun = resolve; });
  activeAutoCompletion = completion;
  let releaseBeforeSync;
  notifySyncStatus();
  try {
    releaseBeforeSync = await autoBeforeSyncCallback?.();
    // A flush can emit its own OPFS mutation. The sync starting now already
    // includes that write, so discard the redundant follow-up debounce.
    if (debounceId) clearTimeout(debounceId);
    debounceId = null;
    const syncConfig = getSyncConfig();
    if (!syncConfig.enabled) return null;
    if (activeRun) {
      pendingAutoSync = true;
      return null;
    }
    const result = await syncNow(syncConfig);
    if (syncResultChangedLocal(result)) await onStorageRestored?.();
    return result;
  } finally {
    try { releaseBeforeSync?.(); } catch (err) {
      console.warn('Auto-sync storage barrier release failed:', err);
    }
    autoRunInProgress = false;
    finishAutoRun();
    if (activeAutoCompletion === completion) activeAutoCompletion = null;
    notifySyncStatus();
    schedulePendingAutoSyncRun();
  }
}

function isManifestCommitConflict(err) {
  return err?.name === 'SyncManifestConflictError'
    || isConditionalWriteConflictError(err)
    || isPreconditionFailed(err);
}

async function withManifestRetries(operation) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_MANIFEST_COMMIT_ATTEMPTS; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (err) {
      if (!isManifestCommitConflict(err) || attempt === MAX_MANIFEST_COMMIT_ATTEMPTS) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

async function withBrowserSyncLock(syncConfig, operation) {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) {
    if (typeof globalThis.window !== 'undefined' && usesShardedManifest(syncConfig)) {
      throw new Error(
        'Sharded sync requires the browser Web Locks API to prevent concurrent tabs from '
        + 'overwriting one device shard. Update the browser or use conditional mode with a new prefix.'
      );
    }
    return operation();
  }
  return locks.request(
    `vertex-agent-sync:${syncBackendIdentity(syncConfig)}`,
    { mode: 'exclusive' },
    operation
  );
}

export async function testSyncConnection(syncConfig = getSyncConfig()) {
  syncConfig = assertSyncConfigured(syncConfig);
  if (
    typeof globalThis.window !== 'undefined'
    && usesShardedManifest(syncConfig)
    && !globalThis.navigator?.locks?.request
  ) {
    throw new Error('Sharded sync requires the browser Web Locks API for safe multi-tab use.');
  }
  const backend = syncBackendFactory(syncConfig);
  const probeId = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  await backend.test(objectKey(syncConfig, `.probe/${probeId}`));
  if (usesShardedManifest(syncConfig)) {
    const { shardObjects } = await listManifestShardObjects(
      backend,
      syncConfig,
      'This sync provider requires object-list permission.'
    );
    await assertAuthorityMarkerCompatible(backend, syncConfig, 'sharded', {
      missing: shardObjects.length === 0,
    });
    await assertNoConditionalAuthority(backend, syncConfig);
  } else {
    const current = await loadSingleRemoteManifest(backend, syncConfig);
    await assertAuthorityMarkerCompatible(backend, syncConfig, 'conditional', {
      missing: !current.exists,
    });
    await assertConditionalAuthorityAvailable(backend, syncConfig);
    await verifyConditionalManifestWrites(backend, syncConfig);
    await withBrowserSyncLock(syncConfig, () => withStateLock(async () => {
      const state = await loadState(syncConfig);
      state.conditionalWritesVerified = true;
      await saveState(state, syncConfig);
    }));
  }
  return true;
}

export async function pullSync(syncConfig = getSyncConfig()) {
  syncConfig = assertSyncConfigured(syncConfig);
  return runExclusive(() => withBrowserSyncLock(
    syncConfig,
    () => withStateLock(() => pullInternal(syncConfig))
  ));
}

export async function pushSync(syncConfig = getSyncConfig()) {
  syncConfig = assertSyncConfigured(syncConfig);
  return runExclusive(() => withBrowserSyncLock(
    syncConfig,
    () => withStateLock(() => {
      const payloadUploads = new Map();
      const uploadedPayloadKeys = new Set();
      const payloadReadCache = new Map();
      return withManifestRetries(async () => {
        const runtime = {
          deferStateSave: true,
          payloadUploads,
          uploadedPayloadKeys,
          payloadReadCache,
        };
        const result = await pushInternal(syncConfig, runtime);
        await saveState(runtime.state, syncConfig);
        return result;
      });
    })
  ));
}

export async function syncNow(syncConfig = getSyncConfig()) {
  syncConfig = assertSyncConfigured(syncConfig);
  return runExclusive(() => withBrowserSyncLock(
    syncConfig,
    () => withStateLock(() => {
      const payloadUploads = new Map();
      const uploadedPayloadKeys = new Set();
      const payloadReadCache = new Map();
      return withManifestRetries(async () => {
        const runtime = {
          deferStateSave: true,
          payloadUploads,
          uploadedPayloadKeys,
          payloadReadCache,
        };
        const pulled = await pullInternal(syncConfig, runtime);
        // Pull establishes the local baseline for the exact remote revision we
        // just observed. Persist it before attempting the manifest CAS: if a
        // competing writer wins, the retry must not reinterpret downloaded
        // raw files as fresh local edits and push them over that newer remote.
        await saveState(runtime.state, syncConfig);
        const pushed = await pushInternal(syncConfig, runtime);
        await saveState(runtime.state, syncConfig);
        return { pulled, pushed };
      });
    })
  ));
}

function scheduleAutoSync(onStorageRestored, event) {
  const stateWrite = event?.type === 'delete'
    ? rememberDeletedPaths(event.paths)
    : (event?.type === 'write' || event?.type === 'mkdir')
      ? rememberRestoredPaths(event.paths)
      : Promise.resolve();
  clearTimeout(debounceId);
  debounceId = setTimeout(async () => {
    await stateWrite;
    runAutoSync(onStorageRestored)
      .catch((err) => console.warn('Auto sync failed:', err));
  }, AUTO_DEBOUNCE_MS);
}

export function cancelPendingAutoSync() {
  if (debounceId) clearTimeout(debounceId);
  debounceId = null;
  if (pendingAutoSync) {
    pendingAutoSync = false;
    notifySyncStatus();
  }
}

export function suspendAutoSync() {
  autoSyncSuspendDepth += 1;
  cancelPendingAutoSync();
  let resumed = false;
  return () => {
    if (resumed) return;
    resumed = true;
    autoSyncSuspendDepth = Math.max(0, autoSyncSuspendDepth - 1);
    schedulePendingAutoSyncRun();
  };
}

export function configureAutoSync(onStorageRestored, options = {}) {
  if (unsubscribeHook) unsubscribeHook();
  if (intervalId) clearInterval(intervalId);
  if (debounceId) clearTimeout(debounceId);
  debounceId = null;
  autoRefreshCallback = onStorageRestored || null;
  autoBeforeSyncCallback = typeof options.beforeSync === 'function'
    ? options.beforeSync
    : null;

  const syncConfig = getSyncConfig();
  if (!syncConfig.enabled) {
    autoRefreshCallback = null;
    autoBeforeSyncCallback = null;
    return () => {};
  }

  unsubscribeHook = registerOpfsSyncHook((event) => scheduleAutoSync(onStorageRestored, event));

  if (options.runStartup === false) {
    scheduleAutoSync(onStorageRestored, { type: 'write', paths: ['config.yaml'] });
  }

  if (syncConfig.autoOnStart && options.runStartup !== false) {
    runAutoSync(onStorageRestored)
      .catch((err) => console.warn('Startup sync failed:', err));
  }

  const minutes = Number(syncConfig.autoIntervalMinutes);
  if (Number.isFinite(minutes) && minutes > 0) {
    intervalId = setInterval(() => {
      runAutoSync(onStorageRestored)
        .catch((err) => console.warn('Periodic sync failed:', err));
    }, Math.max(1, minutes) * 60 * 1000);
  }

  return () => {
    if (unsubscribeHook) unsubscribeHook();
    if (intervalId) clearInterval(intervalId);
    if (debounceId) clearTimeout(debounceId);
    unsubscribeHook = null;
    intervalId = null;
    debounceId = null;
    autoRefreshCallback = null;
    autoBeforeSyncCallback = null;
  };
}

export const __syncInternals = {
  assertManifestCommitSize,
  assertProspectiveManifestMetadataSize,
  assertProspectiveManifestPathSize,
  canReuseLocalHash,
  compareEntryVersions,
  collectDeletedPaths,
  collectDeletedSessionIds,
  findDeletedAncestor,
  hasDeletedAncestor,
  isSafeSyncPath,
  mapWithConcurrency,
  maxConcurrentRequests,
  maxConcurrentRequestsForEntries,
  makeDeleteEntry,
  manifestIntegrityVersion,
  mergeRemoteManifests,
  mergeSets,
  objectPath,
  preserveLocalOnlyConfig,
  pruneDeletedRecords,
  rememberDeletedPaths,
  remoteEntryChanged,
  restoredPathCandidates,
  restoreLocalChangedPathsOverDeletedAncestors,
  stripLocalOnlyConfig,
  stateAfterAppliedRemote,
  structuredBasePath,
  setSyncBackendFactoryForTests,
  syncBackendIdentity,
  validateRemoteManifest,
  yjsPath,
};
