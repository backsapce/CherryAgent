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

  async function walk(dir, prefix = '') {
    const entries = [];
    for await (const [name, handle] of dir) {
      entries.push([name, handle]);
    }

    const batches = await Promise.all(entries.map(async ([name, handle]) => {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') {
        if (isHiddenDirectory(name)) return [];
        return walk(handle, relativePath);
      }

      const file = await handle.getFile();
      return [{
        source: CONTEXT_SOURCE_BROWSER,
        name,
        relativePath,
        displayPath: relativePath,
        size: file.size,
        lastModified: file.lastModified,
      }];
    }));

    return batches.flat();
  }

  const files = await walk(root);
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

    // Supported sandboxes can return the complete tree in one request. Older
    // servers ignore this option and fall back to the parallel directory walk.
    const listing = await listDirectory(safeDir, sandboxUrl, { recursive: safeDir === '' });
    const entries = Array.isArray(listing) ? listing : listing?.children;
    if (!Array.isArray(entries)) return;
    const isRecursiveListing = safeDir === '' && listing?.recursive === true;
    const childDirectories = [];

    for (const entry of entries) {
      const entryPath = normalizeMentionPath(entry.path || joinMentionPath(safeDir, entry.name));
      if (!entryPath) continue;
      const pathParts = entryPath.split('/');
      const directoryParts = entry.type === 'directory' ? pathParts : pathParts.slice(0, -1);
      if (directoryParts.some(isHiddenDirectory)) continue;

      if (entry.type === 'directory') {
        if (!isRecursiveListing) childDirectories.push(entryPath);
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

    await Promise.all(childDirectories.map((entryPath) => walk(entryPath)));
  }

  await walk('');
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
