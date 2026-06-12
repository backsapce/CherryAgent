import config from '../config/config.js';
import {
  deletePath,
  hashBlob,
  listOpfsFiles,
  readPathBlob,
  readPathBytes,
  readPathText,
  registerOpfsSyncHook,
  writePathBytes,
  writePathText,
} from '../vfs/opfs.js';
import { createS3Backend, objectKey } from './s3Backend.js';
import {
  formatStructuredContent,
  isStructuredPath,
  mergeStructuredContent,
  mergeStructuredUpdates,
  parseStructuredContent,
  readStructuredUpdate,
  createStructuredUpdate,
} from './yjsMerge.js';

const MANIFEST_FILE = 'manifest.json';
const STATE_FILE = '.sync/state.json';
const AUTO_DEBOUNCE_MS = 3000;

let unsubscribeHook = null;
let intervalId = null;
let debounceId = null;
let activeRun = null;
let pendingAutoSync = false;
let autoRefreshCallback = null;
let deleteStateWrite = Promise.resolve();

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

function encodePath(path) {
  return btoa(unescape(encodeURIComponent(path))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function objectPath(path) {
  return `objects/${encodePath(path)}`;
}

function yjsPath(path) {
  return `yjs/${encodePath(path)}.bin`;
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

function hasDeletedAncestor(files = {}, path) {
  for (const [deletedPath, entry] of Object.entries(files || {})) {
    if (!entry?.deleted || deletedPath === path) continue;
    if (isPathOrChild(path, deletedPath)) return true;
  }
  return false;
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

function collectDeletedLlmProfileIds(data) {
  const ids = data?.llm?.deletedProfileIds;
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

function pruneDeletedLlmProfiles(data, deletedLlmProfileIds) {
  if (deletedLlmProfileIds.size === 0) return data;
  if (!data || typeof data !== 'object' || !data.llm || typeof data.llm !== 'object') return data;

  const profiles = data.llm.profiles && typeof data.llm.profiles === 'object'
    ? { ...data.llm.profiles }
    : data.llm.profiles;
  if (profiles && typeof profiles === 'object' && !Array.isArray(profiles)) {
    for (const id of deletedLlmProfileIds) {
      delete profiles[id];
    }
  }

  const remainingIds = profiles && typeof profiles === 'object' && !Array.isArray(profiles)
    ? Object.keys(profiles)
    : [];
  const activeProfileId = deletedLlmProfileIds.has(String(data.llm.activeProfileId))
    ? (remainingIds[0] || null)
    : data.llm.activeProfileId;

  return {
    ...data,
    llm: {
      ...data.llm,
      activeProfileId,
      profiles,
      deletedProfileIds: [...deletedLlmProfileIds],
    },
  };
}

function collectDeletedRecordIds(path, ...records) {
  if (!(path === 'config.yaml' || path === 'config.yml' || path === 'config.json')) return new Set();
  return mergeSets(...records.map((record) => collectDeletedLlmProfileIds(record)));
}

function isConfigPath(path) {
  return path === 'config.yaml' || path === 'config.yml' || path === 'config.json';
}

function stripLocalOnlyConfig(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const next = { ...data };
  delete next.agentTokens;
  return next;
}

function preserveLocalOnlyConfig(path, mergedData, localData = {}) {
  if (!isConfigPath(path) || !mergedData || typeof mergedData !== 'object' || Array.isArray(mergedData)) {
    return mergedData;
  }

  const next = stripLocalOnlyConfig(mergedData);
  if (
    localData
    && typeof localData === 'object'
    && !Array.isArray(localData)
    && localData.agentTokens != null
  ) {
    next.agentTokens = localData.agentTokens;
  }
  return next;
}

function pruneDeletedRecords(path, data, deletedSessionIds, deletedAgentIds, deletedLlmProfileIds = new Set()) {
  let next = data;
  if (path === 'session.json') next = pruneDeletedSessions(next, deletedSessionIds);
  if (isConfigPath(path)) {
    next = pruneDeletedAgents(next, deletedAgentIds);
    next = pruneDeletedLlmProfiles(next, mergeSets(deletedLlmProfileIds, collectDeletedLlmProfileIds(next)));
  }
  return next;
}

function nowIso() {
  return new Date().toISOString();
}

function defaultManifest() {
  return { version: 1, updatedAt: nowIso(), files: {} };
}

function isSyncConfigured(syncConfig) {
  return Boolean(syncConfig?.bucket && syncConfig?.accessKeyId && syncConfig?.secretAccessKey);
}

async function readJsonPath(path, fallback) {
  try {
    return JSON.parse(await readPathText(path));
  } catch {
    return fallback;
  }
}

async function writeJsonPath(path, data) {
  await writePathText(path, JSON.stringify(data, null, 2), { internal: true });
}

async function loadState() {
  return readJsonPath(STATE_FILE, { version: 1, files: {}, lastSyncAt: null });
}

async function saveState(state) {
  state.lastSyncAt = nowIso();
  await writeJsonPath(STATE_FILE, state);
}

function rememberDeletedPaths(paths) {
  const deletedAt = nowIso();
  deleteStateWrite = deleteStateWrite
    .catch(() => {})
    .then(async () => {
      const state = await loadState();
      for (const path of paths || []) {
        const childPaths = Object.keys(state.files || {}).filter((existingPath) => isPathOrChild(existingPath, path));
        const pathsToDelete = childPaths.length > 0 ? childPaths : [path];
        for (const pathToDelete of pathsToDelete) {
          state.files[pathToDelete] = {
            ...(state.files[pathToDelete] || {}),
            deleted: true,
            deletedAt,
          };
        }
        state.files[path] = {
          ...(state.files[path] || {}),
          deleted: true,
          deletedAt,
        };
      }
      await saveState(state);
    })
    .catch((err) => console.warn('Failed to record local delete for sync:', err));
  return deleteStateWrite;
}

async function localFileMap() {
  const entries = await listOpfsFiles({ hash: true });
  return new Map(entries.map((entry) => [entry.path, entry]));
}

async function currentLocalEntry(path) {
  try {
    const file = await readPathBlob(path);
    return {
      path,
      size: file.size,
      lastModified: file.lastModified,
      hash: await hashBlob(file),
    };
  } catch {
    return null;
  }
}

function makeDeleteEntry(previous = {}) {
  return {
    deleted: true,
    deletedAt: previous.deletedAt || nowIso(),
    updatedAt: nowIso(),
    hash: previous.hash || null,
  };
}

async function loadRemoteManifest(backend, syncConfig) {
  return await backend.getJson(objectKey(syncConfig, MANIFEST_FILE), defaultManifest()) || defaultManifest();
}

async function saveRemoteManifest(backend, syncConfig, manifest) {
  manifest.version = 1;
  manifest.updatedAt = nowIso();
  await backend.putJson(objectKey(syncConfig, MANIFEST_FILE), manifest);
}

async function readRemoteStructuredUpdate(backend, syncConfig, path, entry) {
  const key = entry?.yjsKey || objectKey(syncConfig, yjsPath(path));
  return backend.getBytes(key);
}

function dataFromStructuredUpdate(path, update, deletedSessionIds = new Set(), deletedAgentIds = new Set()) {
  const data = readStructuredUpdate(update);
  return pruneDeletedRecords(path, data, deletedSessionIds, deletedAgentIds);
}

async function writeStructuredFileFromUpdate(path, update, deletedSessionIds = new Set(), deletedAgentIds = new Set()) {
  const data = dataFromStructuredUpdate(path, update, deletedSessionIds, deletedAgentIds);
  await writePathText(path, formatStructuredContent(path, data), { internal: true });
}

async function applyRemoteFile(backend, syncConfig, path, entry, localEntry, deletedSessionIds = new Set(), deletedAgentIds = new Set()) {
  if (entry.structured) {
    const remoteUpdate = await readRemoteStructuredUpdate(backend, syncConfig, path, entry);
    if (!remoteUpdate) return null;
    if (localEntry) {
      let localText = await readPathText(path);
      if (path === 'session.json' || isConfigPath(path)) {
        const localRawData = parseStructuredContent(path, localText);
        const remoteRawData = readStructuredUpdate(remoteUpdate);
        const deletedLlmProfileIds = collectDeletedRecordIds(path, localRawData, remoteRawData);
        const localData = pruneDeletedRecords(path, localRawData, deletedSessionIds, deletedAgentIds, deletedLlmProfileIds);
        localText = formatStructuredContent(path, localData);
        const remoteData = pruneDeletedRecords(path, remoteRawData, deletedSessionIds, deletedAgentIds, deletedLlmProfileIds);
        const merged = mergeStructuredContent(path, localText, createStructuredUpdate(remoteData));
        const finalData = preserveLocalOnlyConfig(path, merged.data, localData);
        const syncData = isConfigPath(path) ? stripLocalOnlyConfig(finalData) : finalData;
        const update = createStructuredUpdate(syncData);
        await writePathText(path, formatStructuredContent(path, finalData), { internal: true });
        await backend.putBytes(entry.yjsKey || objectKey(syncConfig, yjsPath(path)), update, 'application/octet-stream');
        return { merged: true, update };
      }
      const remoteData = dataFromStructuredUpdate(path, remoteUpdate, deletedSessionIds, deletedAgentIds);
      const merged = mergeStructuredContent(path, localText, createStructuredUpdate(remoteData));
      await writePathText(path, merged.content, { internal: true });
      await backend.putBytes(entry.yjsKey || objectKey(syncConfig, yjsPath(path)), merged.update, 'application/octet-stream');
      return { merged: true, update: merged.update };
    }
    const data = preserveLocalOnlyConfig(path, dataFromStructuredUpdate(path, remoteUpdate, deletedSessionIds, deletedAgentIds));
    const update = createStructuredUpdate(isConfigPath(path) ? stripLocalOnlyConfig(data) : data);
    await writeStructuredFileFromUpdate(path, update);
    return { merged: false, update };
  }

  const bytes = await backend.getBytes(entry.objectKey || objectKey(syncConfig, objectPath(path)));
  if (!bytes) return null;
  await writePathBytes(path, bytes, { internal: true });
  return { merged: false };
}

async function pullInternal(syncConfig) {
  const backend = createS3Backend(syncConfig);
  const manifest = await loadRemoteManifest(backend, syncConfig);
  const state = await loadState();
  const local = await localFileMap();
  const deletedSessionIds = mergeSets(collectDeletedSessionIds(manifest.files), collectDeletedSessionIds(state.files));
  const deletedAgentIds = mergeSets(collectDeletedAgentIds(manifest.files), collectDeletedAgentIds(state.files));
  const locallyDeletedPaths = collectDeletedPaths(state.files);
  const stats = { downloaded: 0, merged: 0, deleted: 0, skipped: 0 };

  for (const [path, entry] of Object.entries(manifest.files || {})) {
    let localEntry = local.get(path);

    if (locallyDeletedPaths.has(path) || hasDeletedAncestor(state.files, path)) {
      if (!localEntry) localEntry = await currentLocalEntry(path);
      if (localEntry) {
        await deletePath(path, { internal: true });
        stats.deleted += 1;
      } else {
        stats.skipped += 1;
      }
      state.files[path] = {
        ...(state.files[path] || {}),
        deleted: true,
        deletedAt: state.files[path]?.deletedAt || nowIso(),
        remoteUpdatedAt: entry.updatedAt || state.files[path]?.remoteUpdatedAt || null,
      };
      continue;
    }

    if (entry.deleted) {
      if (!localEntry) localEntry = await currentLocalEntry(path);
      const previous = state.files[path];
      if (
        entry.hash == null ||
        (localEntry && (previous?.hash === localEntry.hash || isSessionMessagesPath(path)))
      ) {
        await deletePath(path, { internal: true });
        stats.deleted += 1;
      } else {
        stats.skipped += 1;
      }
      state.files[path] = { ...(state.files[path] || {}), deleted: true, deletedAt: entry.deletedAt };
      continue;
    }

    if (hasDeletedAncestor(manifest.files, path)) {
      await deletePath(path, { internal: true });
      state.files[path] = {
        ...(state.files[path] || {}),
        deleted: true,
        deletedAt: nowIso(),
        remoteUpdatedAt: entry.updatedAt || state.files[path]?.remoteUpdatedAt || null,
      };
      stats.deleted += 1;
      continue;
    }

    if (!localEntry) localEntry = await currentLocalEntry(path);
    const previous = state.files[path];
    const localDirty = localEntry && previous?.hash && previous.hash !== localEntry.hash;
    const remoteNewer = !localEntry || !previous || entry.updatedAt !== previous.remoteUpdatedAt;

    if (!remoteNewer) {
      stats.skipped += 1;
      continue;
    }

    if (!entry.structured && localDirty && localEntry.lastModified > Date.parse(entry.updatedAt || 0)) {
      stats.skipped += 1;
      continue;
    }

    const result = await applyRemoteFile(backend, syncConfig, path, entry, localEntry, deletedSessionIds, deletedAgentIds);
    if (!result) {
      stats.skipped += 1;
      continue;
    }
    const file = await readPathBlob(path);
    state.files[path] = {
      hash: await hashBlob(file),
      remoteUpdatedAt: entry.updatedAt,
      yjsKey: entry.yjsKey || null,
      objectKey: entry.objectKey || null,
      deleted: false,
    };
    if (result.merged) stats.merged += 1;
    else stats.downloaded += 1;
  }

  await saveState(state);
  return stats;
}

async function pushInternal(syncConfig) {
  await deleteStateWrite.catch(() => {});
  const backend = createS3Backend(syncConfig);
  const manifest = await loadRemoteManifest(backend, syncConfig);
  const state = await loadState();
  const local = await localFileMap();
  const stats = { uploaded: 0, merged: 0, deleted: 0, skipped: 0 };

  for (const [path, previous] of Object.entries(state.files || {})) {
    if (previous.deleted) {
      for (const [remotePath, remoteEntry] of Object.entries(manifest.files || {})) {
        if (!remoteEntry?.deleted && isPathOrChild(remotePath, path)) {
          const entry = makeDeleteEntry(state.files[remotePath] || remoteEntry || previous);
          manifest.files[remotePath] = entry;
          state.files[remotePath] = { ...(state.files[remotePath] || {}), ...entry };
          stats.deleted += 1;
        }
      }
      if (!manifest.files[path]?.deleted) {
        const entry = makeDeleteEntry(previous);
        manifest.files[path] = entry;
        state.files[path] = { ...previous, ...entry };
        stats.deleted += 1;
      }
      continue;
    }
    if (local.has(path)) continue;
    const entry = makeDeleteEntry(previous);
    manifest.files[path] = entry;
    state.files[path] = { ...previous, ...entry };
    stats.deleted += 1;
  }

  const deletedSessionIds = collectDeletedSessionIds(state.files);
  const deletedAgentIds = collectDeletedAgentIds(state.files);

  for (const [path, entry] of local) {
    const previous = state.files[path];
    const remoteEntry = manifest.files[path];
    if (hasDeletedAncestor(state.files, path) || hasDeletedAncestor(manifest.files, path)) {
      await deletePath(path, { internal: true });
      const deleteEntry = makeDeleteEntry(previous || remoteEntry || entry);
      manifest.files[path] = deleteEntry;
      state.files[path] = { ...(previous || {}), ...deleteEntry };
      stats.deleted += 1;
      continue;
    }

    if ((previous?.deleted || remoteEntry?.deleted) && isSessionMessagesPath(path)) {
      if (!manifest.files[path]?.deleted) {
        const deleteEntry = makeDeleteEntry(previous);
        manifest.files[path] = deleteEntry;
        state.files[path] = { ...(previous || {}), ...deleteEntry };
      }
      await deletePath(path, { internal: true });
      state.files[path] = {
        ...(previous || {}),
        ...(state.files[path] || {}),
        deleted: true,
        deletedAt: remoteEntry?.deletedAt || state.files[path]?.deletedAt || previous?.deletedAt || nowIso(),
        remoteUpdatedAt: remoteEntry?.updatedAt || previous?.remoteUpdatedAt || null,
      };
      stats.deleted += 1;
      continue;
    }

    const agentId = agentIdFromWorkspacePath(path);
    if (deletedAgentIds.has(agentId) && isAgentWorkspacePath(path)) {
      if (!manifest.files[path]?.deleted) {
        const deleteEntry = makeDeleteEntry(previous);
        manifest.files[path] = deleteEntry;
        state.files[path] = { ...(previous || {}), ...deleteEntry };
      }
      if (agentId) await deletePath(`workspace/${agentId}`, { internal: true });
      state.files[path] = {
        ...(previous || {}),
        ...(state.files[path] || {}),
        deleted: true,
        deletedAt: remoteEntry?.deletedAt || state.files[path]?.deletedAt || previous?.deletedAt || nowIso(),
        remoteUpdatedAt: remoteEntry?.updatedAt || previous?.remoteUpdatedAt || null,
      };
      stats.deleted += 1;
      continue;
    }

    const shouldPruneIndex = (path === 'session.json' && deletedSessionIds.size > 0)
      || (isConfigPath(path) && deletedAgentIds.size > 0);
    if (!shouldPruneIndex && previous?.hash === entry.hash && remoteEntry && !remoteEntry.deleted) {
      stats.skipped += 1;
      continue;
    }

    const updatedAt = new Date(entry.lastModified || Date.now()).toISOString();
    const structured = isStructuredPath(path);
    const rawKey = objectKey(syncConfig, objectPath(path));
    const updateKey = objectKey(syncConfig, yjsPath(path));

    if (structured) {
      const localText = await readPathText(path);
      const localRawData = parseStructuredContent(path, localText);
      let localData = pruneDeletedRecords(path, localRawData, deletedSessionIds, deletedAgentIds);
      let syncData = isConfigPath(path) ? stripLocalOnlyConfig(localData) : localData;
      let localUpdate = createStructuredUpdate(syncData);
      if (path === 'session.json' || isConfigPath(path)) {
        await writePathText(path, formatStructuredContent(path, localData), { internal: true });
      }
      const remoteUpdate = remoteEntry && !remoteEntry.deleted
        ? await readRemoteStructuredUpdate(backend, syncConfig, path, remoteEntry)
        : null;
      if (remoteUpdate) {
        const remoteRawData = readStructuredUpdate(remoteUpdate);
        const deletedLlmProfileIds = collectDeletedRecordIds(path, localRawData, remoteRawData);
        localData = pruneDeletedRecords(path, localRawData, deletedSessionIds, deletedAgentIds, deletedLlmProfileIds);
        const remoteData = pruneDeletedRecords(path, remoteRawData, deletedSessionIds, deletedAgentIds, deletedLlmProfileIds);
        const localSyncData = isConfigPath(path) ? stripLocalOnlyConfig(localData) : localData;
        const remoteSyncData = isConfigPath(path) ? stripLocalOnlyConfig(remoteData) : remoteData;
        localUpdate = createStructuredUpdate(localSyncData);
        const merged = mergeStructuredUpdates([createStructuredUpdate(remoteSyncData), localUpdate]);
        const finalData = preserveLocalOnlyConfig(path, merged.data, localData);
        syncData = isConfigPath(path) ? stripLocalOnlyConfig(finalData) : finalData;
        localUpdate = createStructuredUpdate(syncData);
        await writePathText(path, formatStructuredContent(path, finalData), { internal: true });
        stats.merged += 1;
      }
      const content = isConfigPath(path)
        ? formatStructuredContent(path, syncData)
        : await readPathText(path);
      await backend.putBytes(updateKey, localUpdate, 'application/octet-stream');
      await backend.putBytes(rawKey, new TextEncoder().encode(content), path.endsWith('.json') ? 'application/json' : 'text/yaml');
    } else {
      await backend.putBytes(rawKey, await readPathBytes(path));
    }

    const finalFile = await readPathBlob(path);
    const finalHash = await hashBlob(finalFile);

    manifest.files[path] = {
      structured,
      deleted: false,
      hash: finalHash,
      size: finalFile.size,
      updatedAt,
      objectKey: rawKey,
      yjsKey: structured ? updateKey : null,
    };
    state.files[path] = {
      hash: finalHash,
      remoteUpdatedAt: updatedAt,
      objectKey: rawKey,
      yjsKey: structured ? updateKey : null,
      deleted: false,
    };
    stats.uploaded += 1;
  }

  await saveRemoteManifest(backend, syncConfig, manifest);
  await saveState(state);
  return stats;
}

function getSyncConfig() {
  return config.get('sync') || {};
}

async function runExclusive(fn) {
  if (activeRun) return activeRun;
  activeRun = fn().finally(() => {
    activeRun = null;
    if (pendingAutoSync) {
      pendingAutoSync = false;
      queueMicrotask(() => {
        const syncConfig = getSyncConfig();
        if (syncConfig.enabled) {
          syncNow(syncConfig)
            .then((result) => {
              if (syncResultChangedLocal(result)) autoRefreshCallback?.();
            })
            .catch((err) => console.warn('Queued auto sync failed:', err));
        }
      });
    }
  });
  return activeRun;
}

export async function testSyncConnection(syncConfig = getSyncConfig()) {
  if (!isSyncConfigured(syncConfig)) throw new Error('Sync backend is not configured.');
  const backend = createS3Backend(syncConfig);
  await backend.test();
  return true;
}

export async function pullSync(syncConfig = getSyncConfig()) {
  if (!isSyncConfigured(syncConfig)) throw new Error('Sync backend is not configured.');
  return runExclusive(() => pullInternal(syncConfig));
}

export async function pushSync(syncConfig = getSyncConfig()) {
  if (!isSyncConfigured(syncConfig)) throw new Error('Sync backend is not configured.');
  return runExclusive(() => pushInternal(syncConfig));
}

export async function syncNow(syncConfig = getSyncConfig()) {
  if (!isSyncConfigured(syncConfig)) throw new Error('Sync backend is not configured.');
  return runExclusive(async () => {
    const pushed = await pushInternal(syncConfig);
    const pulled = await pullInternal(syncConfig);
    return { pulled, pushed };
  });
}

function scheduleAutoSync(onStorageRestored, event) {
  const deleteWrite = event?.type === 'delete' ? rememberDeletedPaths(event.paths) : Promise.resolve();
  clearTimeout(debounceId);
  debounceId = setTimeout(async () => {
    await deleteWrite;
    const syncConfig = getSyncConfig();
    if (!syncConfig.enabled) return;
    if (activeRun) {
      pendingAutoSync = true;
      return;
    }
    syncNow(syncConfig)
      .then((result) => {
        if (syncResultChangedLocal(result)) onStorageRestored?.();
      })
      .catch((err) => console.warn('Auto sync failed:', err));
  }, AUTO_DEBOUNCE_MS);
}

export function configureAutoSync(onStorageRestored, options = {}) {
  if (unsubscribeHook) unsubscribeHook();
  if (intervalId) clearInterval(intervalId);
  autoRefreshCallback = onStorageRestored || null;

  const syncConfig = getSyncConfig();
  if (!syncConfig.enabled) {
    autoRefreshCallback = null;
    return () => {};
  }

  unsubscribeHook = registerOpfsSyncHook((event) => scheduleAutoSync(onStorageRestored, event));

  if (syncConfig.autoOnStart && options.runStartup !== false) {
    syncNow(syncConfig)
      .then((result) => {
        if (syncResultChangedLocal(result)) onStorageRestored?.();
      })
      .catch((err) => console.warn('Startup sync failed:', err));
  }

  const minutes = Number(syncConfig.autoIntervalMinutes);
  if (Number.isFinite(minutes) && minutes > 0) {
    intervalId = setInterval(() => {
      syncNow(getSyncConfig())
        .then((result) => {
          if (syncResultChangedLocal(result)) onStorageRestored?.();
        })
        .catch((err) => console.warn('Periodic sync failed:', err));
    }, Math.max(1, minutes) * 60 * 1000);
  }

  return () => {
    if (unsubscribeHook) unsubscribeHook();
    if (intervalId) clearInterval(intervalId);
    unsubscribeHook = null;
    intervalId = null;
    autoRefreshCallback = null;
  };
}

export const __syncInternals = {
  collectDeletedPaths,
  collectDeletedSessionIds,
  hasDeletedAncestor,
  mergeSets,
  pruneDeletedRecords,
};
