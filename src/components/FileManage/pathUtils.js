export function normalizeFileManagerPath(path) {
  return String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/');
}

export function joinFileManagerPath(...parts) {
  return normalizeFileManagerPath(
    parts
      .filter((part) => part !== null && part !== undefined && String(part).length > 0)
      .join('/')
  );
}

export function isOrphanedAgentWorkspace(parentDir, directoryName, agentIds) {
  if (!(agentIds instanceof Set)) return false;
  return normalizeFileManagerPath(parentDir) === 'workspace'
    && !agentIds.has(directoryName);
}

export function isCurrentAgentWorkspace(parentDir, directoryName, activeAgentId) {
  if (!activeAgentId) return false;
  return normalizeFileManagerPath(parentDir) === 'workspace'
    && directoryName === activeAgentId;
}
