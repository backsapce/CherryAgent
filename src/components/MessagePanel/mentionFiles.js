export const CONTEXT_SOURCE_BROWSER = 'browser';
export const CONTEXT_SOURCE_SANDBOX = 'sandbox';

function normalizeMentionPath(path) {
  return String(path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function joinMentionPath(...parts) {
  return normalizeMentionPath(parts.filter(Boolean).join('/'));
}

function isHiddenDirectory(name) {
  return String(name || '').startsWith('.');
}

export async function collectAgentWorkspaceFiles(agentId, getAgentDirectory) {
  if (!agentId) return [];
  const root = await getAgentDirectory(agentId);
  const files = [];

  async function walk(dir, prefix = '') {
    for await (const [name, handle] of dir) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') {
        if (isHiddenDirectory(name)) continue;
        await walk(handle, relativePath);
      } else {
        const file = await handle.getFile();
        files.push({
          source: CONTEXT_SOURCE_BROWSER,
          name,
          relativePath,
          displayPath: relativePath,
          size: file.size,
          lastModified: file.lastModified,
        });
      }
    }
  }

  await walk(root);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function collectSandboxFiles(sandboxUrl, listDirectory) {
  if (!sandboxUrl) return [];
  const files = [];
  const visitedDirs = new Set();

  async function walk(dir = '') {
    const safeDir = normalizeMentionPath(dir);
    if (visitedDirs.has(safeDir)) return;
    visitedDirs.add(safeDir);

    const listing = await listDirectory(safeDir, sandboxUrl);
    const entries = Array.isArray(listing) ? listing : listing?.children;
    if (!Array.isArray(entries)) return;

    for (const entry of entries) {
      const entryPath = normalizeMentionPath(entry.path || joinMentionPath(safeDir, entry.name));
      if (!entryPath) continue;
      if (entry.type === 'directory') {
        if (isHiddenDirectory(entry.name)) continue;
        await walk(entryPath);
      } else {
        files.push({
          source: CONTEXT_SOURCE_SANDBOX,
          sandboxUrl,
          name: entry.name,
          relativePath: entryPath,
          displayPath: `sandbox/${entryPath}`,
          size: entry.size || 0,
          lastModified: entry.lastModified,
        });
      }
    }
  }

  await walk('');
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
