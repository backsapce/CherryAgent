/**
 * Session folder grouping shared by the sidebar and its persistence layer.
 * The default folder is implicit: sessions without a valid folderId (or whose
 * folderId no longer matches a stored folder record) always fall back to it.
 */
export const DEFAULT_FOLDER_ID = 'default';
export const DEFAULT_FOLDER_NAME = 'default';
export const FOLDER_PAGE_SIZE = 50;

/**
 * Config key for the "user deleted the default folder" flag. While it is set
 * the sidebar omits an empty default row once other folders exist; the flag is
 * cleared whenever the default folder regenerates (last folder standing).
 */
export const DEFAULT_FOLDER_HIDDEN_KEY = 'general.defaultFolderHidden';

/** Normalize a folder reference; anything unsafe means the default folder. */
export function sessionFolderKey(session) {
  const value = session?.folderId;
  if (typeof value !== 'string') return DEFAULT_FOLDER_ID;
  const trimmed = value.trim();
  return trimmed && !trimmed.includes('/') ? trimmed : DEFAULT_FOLDER_ID;
}

/** Order user folders oldest-first so the list matches creation order. */
export function sortSessionFolders(folders) {
  return [...(folders || [])]
    .filter((folder) => typeof folder?.id === 'string' && folder.id.trim())
    .sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));
}

/**
 * Pick the initial name for a newly added folder: the base name when free,
 * otherwise the base name with the lowest suffix number ≥ 2 that is free.
 */
export function nextFolderName(folders, baseName) {
  const taken = new Set(
    (folders || []).map((folder) => (typeof folder?.name === 'string' ? folder.name : '')),
  );
  if (!taken.has(baseName)) return baseName;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${baseName}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Split ordered sessions into folder groups: the default folder first, then
 * each stored folder in creation order. Sessions referencing a missing folder
 * land in the default group so they can never disappear from the sidebar.
 *
 * `options.defaultHidden` suppresses the default row after the user deleted
 * the default folder while other folders still exist. It is never suppressed
 * while it still holds sessions (they must stay visible) nor when no other
 * folder remains — the default folder regenerates in that case instead.
 */
export function groupSessionsByFolder(sessions, folders, options = {}) {
  const knownFolderIds = new Set(
    sortSessionFolders(folders).map((folder) => folder.id),
  );
  const groups = [
    { id: DEFAULT_FOLDER_ID, name: DEFAULT_FOLDER_NAME, folder: null, sessions: [] },
    ...[...knownFolderIds].map((id) => ({
      id,
      name: folders.find((folder) => folder.id === id)?.name || id,
      folder: folders.find((folder) => folder.id === id) || null,
      sessions: [],
    })),
  ];
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  for (const session of sessions || []) {
    const key = sessionFolderKey(session);
    const group = knownFolderIds.has(key) ? groupsById.get(key) : groups[0];
    group.sessions.push(session);
  }
  const { defaultHidden = false } = options;
  const suppressDefault = defaultHidden
    && knownFolderIds.size > 0
    && groups[0].sessions.length === 0;
  return suppressDefault ? groups.slice(1) : groups;
}
