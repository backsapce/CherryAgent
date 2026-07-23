import { joinFileManagerPath, normalizeFileManagerPath } from './pathUtils.js';

function pathDepth(path) {
  return path ? path.split('/').length : 0;
}

/**
 * Normalize a browser-provided relative upload path without allowing it to
 * escape the selected destination.
 */
export function normalizeUploadRelativePath(path, options = {}) {
  const rawPath = String(path ?? '').replace(/\\/g, '/');
  if (rawPath.includes('\0')) {
    throw new Error('Upload path contains invalid characters');
  }
  if (rawPath.startsWith('/') || /^[A-Za-z]:\//.test(rawPath)) {
    throw new Error('Upload path must be relative');
  }

  const parts = rawPath.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) {
    throw new Error('Upload path cannot leave the destination');
  }

  const normalizedPath = parts.join('/');
  if (!options.allowEmpty && !normalizedPath) {
    throw new Error('Upload path is required');
  }
  return normalizedPath;
}

function addParentDirectories(path, directories) {
  const parts = path.split('/');
  parts.pop();
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    directories.add(current);
  }
}

/**
 * Turn File objects (including webkitdirectory input files) and explicit
 * directory paths into one backend-neutral upload batch.
 */
export function createUploadBatch(files = [], directoryPaths = []) {
  const directories = new Set();
  for (const path of directoryPaths) {
    const normalizedPath = normalizeUploadRelativePath(path);
    directories.add(normalizedPath);
    addParentDirectories(`${normalizedPath}/placeholder`, directories);
  }

  const fileMap = new Map();
  for (const candidate of Array.from(files || [])) {
    const file = candidate?.file || candidate;
    if (!file) continue;
    const relativePath = normalizeUploadRelativePath(
      candidate?.relativePath || file.webkitRelativePath || file.name
    );
    addParentDirectories(relativePath, directories);
    fileMap.set(relativePath, { file, relativePath });
  }

  return {
    files: Array.from(fileMap.values()),
    directories: Array.from(directories)
      .filter(Boolean)
      .sort((left, right) => pathDepth(left) - pathDepth(right) || left.localeCompare(right)),
  };
}

/**
 * Execute a batch through the FileManage storage adapter. Both OPFS and
 * sandbox adapters implement createDir(name, parent) and upload(name, file,
 * parent), so their destination semantics stay identical.
 */
export async function uploadBatchToDestination(batch, targetPath, fileOps, onError = () => {}) {
  const destination = normalizeFileManagerPath(targetPath);
  let successCount = 0;
  let failCount = 0;

  for (const relativePath of batch.directories) {
    const fullPath = joinFileManagerPath(destination, relativePath);
    const parts = fullPath.split('/');
    const name = parts.pop();
    const parentPath = parts.join('/');
    try {
      await fileOps.createDir(name, parentPath);
      successCount++;
    } catch (error) {
      onError('directory', fullPath, error);
      failCount++;
    }
  }

  for (const { file, relativePath } of batch.files) {
    const fullPath = joinFileManagerPath(destination, relativePath);
    const parts = fullPath.split('/');
    const name = parts.pop();
    const parentPath = parts.join('/');
    try {
      await fileOps.upload(name, file, parentPath);
      successCount++;
    } catch (error) {
      onError('file', fullPath, error);
      failCount++;
    }
  }

  return { successCount, failCount };
}

function readLegacyFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readLegacyDirectoryEntries(entry) {
  const reader = entry.createReader();
  const entries = [];

  return new Promise((resolve, reject) => {
    const readNext = () => {
      reader.readEntries((chunk) => {
        if (!chunk?.length) {
          resolve(entries);
          return;
        }
        entries.push(...chunk);
        readNext();
      }, reject);
    };
    readNext();
  });
}

async function walkLegacyEntry(entry, parentPath, files, directories) {
  const relativePath = normalizeUploadRelativePath(
    parentPath ? `${parentPath}/${entry.name}` : entry.name
  );

  if (entry.isDirectory) {
    directories.push(relativePath);
    const children = await readLegacyDirectoryEntries(entry);
    for (const child of children) {
      await walkLegacyEntry(child, relativePath, files, directories);
    }
    return;
  }

  if (entry.isFile) {
    files.push({ file: await readLegacyFile(entry), relativePath });
  }
}

async function walkFileSystemHandle(handle, parentPath, files, directories) {
  const relativePath = normalizeUploadRelativePath(
    parentPath ? `${parentPath}/${handle.name}` : handle.name
  );

  if (handle.kind === 'directory') {
    directories.push(relativePath);
    for await (const child of handle.values()) {
      await walkFileSystemHandle(child, relativePath, files, directories);
    }
    return;
  }

  if (handle.kind === 'file') {
    files.push({ file: await handle.getFile(), relativePath });
  }
}

/**
 * Recursively collect files and folders from an external drag. The legacy
 * entry API is still the broadest implementation, with File System Access and
 * DataTransfer.files fallbacks for other browsers.
 */
export async function readDroppedUploadBatch(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []).filter((item) => item.kind === 'file');
  const legacyItems = items.map((item) => {
    const getEntry = item.getAsEntry || item.webkitGetAsEntry;
    if (typeof getEntry !== 'function') return { item, entry: null };
    try {
      return { item, entry: getEntry.call(item) };
    } catch {
      return { item, entry: null };
    }
  });
  const hasLegacyEntries = legacyItems.some(({ entry }) => entry);

  if (hasLegacyEntries) {
    const files = [];
    const directories = [];
    for (const { item, entry } of legacyItems) {
      if (entry) {
        await walkLegacyEntry(entry, '', files, directories);
        continue;
      }
      const file = item.getAsFile?.();
      if (!file) throw new Error('A dropped folder could not be read');
      files.push({ file, relativePath: file.name });
    }
    return createUploadBatch(files, directories);
  }

  // Capture every promise synchronously while the drop event still grants
  // access to its DataTransferItem objects.
  const hasFileSystemHandleApi = items.some(
    (item) => typeof item.getAsFileSystemHandle === 'function'
  );
  const handleRequests = items.map((item) => {
    if (typeof item.getAsFileSystemHandle !== 'function') {
      return { item, promise: Promise.resolve(null) };
    }
    try {
      return { item, promise: item.getAsFileSystemHandle() };
    } catch {
      return { item, promise: Promise.resolve(null) };
    }
  });

  if (hasFileSystemHandleApi) {
    const files = [];
    const directories = [];
    const settledHandles = await Promise.allSettled(handleRequests.map(({ promise }) => promise));
    for (let index = 0; index < settledHandles.length; index++) {
      const result = settledHandles[index];
      if (result.status === 'fulfilled' && result.value) {
        await walkFileSystemHandle(result.value, '', files, directories);
        continue;
      }
      const file = handleRequests[index].item.getAsFile?.();
      if (!file) throw new Error('A dropped folder could not be read');
      files.push({ file, relativePath: file.name });
    }
    if (files.length > 0 || directories.length > 0) {
      return createUploadBatch(files, directories);
    }
  }

  return createUploadBatch(dataTransfer?.files || []);
}
