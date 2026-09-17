/**
 * File-domain operations for the agent server, shared by the WebSocket
 * handlers and (transitionally) the HTTP file routes. All paths are validated
 * by the injected file-path policy; uploads stream to a sibling temp file and
 * atomically rename into place, downloads stream as chunked binary frames
 * with backpressure.
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, normalize, resolve } from 'node:path';

const DOWNLOAD_CHUNK_BYTES = 256 * 1024;

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * @param {{
 *   filesRootDir: string,
 *   isSafePath: (path: string) => boolean,
 *   isSafeMutationPath: (path: string) => boolean,
 *   isProtectedControlPath: (path: string) => boolean,
 *   isSameOrChildPath: (target: string, ancestor: string) => boolean,
 *   maxUploadBytes: number,
 *   log?: (...args: any[]) => void,
 * }} deps
 */
export function createFileOperations(deps) {
  const {
    filesRootDir,
    isSafePath,
    isSafeMutationPath,
    isProtectedControlPath,
    isSameOrChildPath,
    maxUploadBytes,
    log = () => {},
  } = deps;

  // In-flight uploads keyed by stream id, shared across connections.
  const uploads = new Map();

  function resolvedSafePath(inputPath) {
    if (!isSafePath(inputPath)) {
      throw errorWithCode('Access denied: Path outside agent files root', 403);
    }
    return resolve(join(filesRootDir, normalize(inputPath || '')));
  }

  function listFileEntries(resolvedPath, normalizedPath, recursive = false, includeHidden = false) {
    const files = [];
    const entries = readdirSync(resolvedPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith('.')) continue;

      const entryPath = join(resolvedPath, entry.name);
      if (isProtectedControlPath(entryPath)) continue;
      let size = 0;
      let lastModified = null;
      try {
        const entryStats = statSync(entryPath);
        size = entryStats.size;
        lastModified = entryStats.mtimeMs;
      } catch { /* ignore */ }

      const relativePath = join(normalizedPath, entry.name);
      files.push({
        id: `${entry.isDirectory() ? 'dir' : 'file'}-${normalizedPath}-${entry.name}`,
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        size,
        lastModified,
        path: relativePath,
        parentDir: normalizedPath === '.' ? '' : normalizedPath,
      });

      if (recursive && entry.isDirectory()) {
        try {
          files.push(...listFileEntries(entryPath, relativePath, true, includeHidden));
        } catch {
          // One unreadable directory should not make the entire search fail.
        }
      }
    }

    return files;
  }

  const operations = {
    list(inputPath = '', { recursive = false, includeHidden = false } = {}) {
      const resolvedPath = resolvedSafePath(inputPath);
      if (!existsSync(resolvedPath)) throw errorWithCode('Directory not found', 404);
      if (!statSync(resolvedPath).isDirectory()) throw errorWithCode('Not a directory', 400);
      const normalizedPath = normalize(inputPath || '');
      const files = listFileEntries(resolvedPath, normalizedPath, recursive, includeHidden);
      return recursive || normalizedPath === '.' || normalizedPath === ''
        ? {
          id: 'root',
          name: '/',
          type: 'directory',
          ...(recursive ? { recursive: true } : {}),
          children: files,
        }
        : files;
    },

    create(inputPath, content = '', isDirectory = false) {
      if (!inputPath || typeof inputPath !== 'string') {
        throw errorWithCode('Missing or invalid "path" field.', 400);
      }
      const resolvedPath = resolvedSafePath(inputPath);
      if (isDirectory) {
        mkdirSync(resolvedPath, { recursive: true });
        return { success: true, message: 'Directory created' };
      }
      const parentDir = join(resolvedPath, '..');
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
      writeFileSync(resolvedPath, content || '');
      return { success: true, message: 'File created' };
    },

    move(sourcePath, targetPath) {
      if (!sourcePath || typeof sourcePath !== 'string' || !targetPath || typeof targetPath !== 'string') {
        throw errorWithCode('Missing or invalid "sourcePath" or "targetPath" field.', 400);
      }
      if (!isSafeMutationPath(sourcePath) || !isSafePath(targetPath)) {
        throw errorWithCode('Access denied: Path outside agent files root', 403);
      }
      const normalizedSource = normalize(sourcePath);
      const normalizedTarget = normalize(targetPath);
      if (normalizedSource === normalizedTarget) {
        return { success: true, message: 'Already at target path' };
      }
      const resolvedSource = resolve(join(filesRootDir, normalizedSource));
      const resolvedTarget = resolve(join(filesRootDir, normalizedTarget));
      if (!existsSync(resolvedSource)) throw errorWithCode('Source file or directory not found', 404);
      if (existsSync(resolvedTarget)) throw errorWithCode('Destination already exists', 409);
      const stats = statSync(resolvedSource);
      if (stats.isDirectory() && isSameOrChildPath(resolvedTarget, resolvedSource)) {
        throw errorWithCode('Cannot move a directory into itself', 400);
      }
      const targetParent = join(resolvedTarget, '..');
      if (!existsSync(targetParent)) mkdirSync(targetParent, { recursive: true });
      if (!statSync(targetParent).isDirectory()) {
        throw errorWithCode('Target parent is not a directory', 400);
      }
      renameSync(resolvedSource, resolvedTarget);
      return { success: true, message: 'Moved successfully' };
    },

    remove(inputPath) {
      if (!inputPath) throw errorWithCode('Missing "path" parameter.', 400);
      if (!isSafeMutationPath(inputPath)) {
        throw errorWithCode('Access denied: Path outside agent files root', 403);
      }
      const resolvedPath = resolvedSafePath(inputPath);
      if (!existsSync(resolvedPath)) throw errorWithCode('File or directory not found', 404);
      if (statSync(resolvedPath).isDirectory()) {
        rmSync(resolvedPath, { recursive: true });
      } else {
        unlinkSync(resolvedPath);
      }
      return { success: true, message: 'Deleted successfully' };
    },

    /** Resolve a download and stream it as chunked binary frames. */
    download(inputPath, conn, streamId) {
      const resolvedPath = resolvedSafePath(inputPath);
      if (!existsSync(resolvedPath)) throw errorWithCode('File not found', 404);
      const stats = statSync(resolvedPath);
      if (stats.isDirectory()) throw errorWithCode('Cannot download a directory', 400);
      const data = readFileSync(resolvedPath);
      const fileName = normalize(inputPath).split(/[\\/]/).pop();
      void (async () => {
        try {
          for (let offset = 0; offset < data.length; offset += DOWNLOAD_CHUNK_BYTES) {
            if (conn.socket.destroyed) return;
            const final = offset + DOWNLOAD_CHUNK_BYTES >= data.length;
            conn.sendBinary(streamId, data.subarray(offset, offset + DOWNLOAD_CHUNK_BYTES), final);
            await conn.waitDrain();
          }
          if (data.length === 0) conn.sendBinary(streamId, Buffer.alloc(0), true);
        } catch (error) {
          log('download stream failed:', error.message);
          conn.notify('stream.error', { streamId, error: error.message });
        }
      })();
      return { streamId, size: stats.size, name: fileName };
    },

    /**
     * Streamed upload lifecycle: `begin` validates the target and opens a
     * temp-file sink; binary frames append; the final-flagged frame closes
     * the write; `file.upload.end` then atomically renames into place and is
     * the client's completion receipt.
     */
    beginUpload(inputPath, conn, streamId, declaredSize) {
      if (uploads.has(streamId)) throw errorWithCode('Stream id already in use.', 409);
      if (!inputPath || typeof inputPath !== 'string') {
        throw errorWithCode('Missing or invalid "path" field.', 400);
      }
      if (!Number.isFinite(declaredSize) || declaredSize < 0) {
        throw errorWithCode('Missing or invalid "size" field.', 400);
      }
      if (declaredSize > maxUploadBytes) {
        throw errorWithCode(`Upload exceeds ${maxUploadBytes} bytes.`, 413);
      }
      const resolvedPath = resolvedSafePath(inputPath);
      const parentDir = join(resolvedPath, '..');
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
      const tempPath = `${resolvedPath}.upload-${streamId}`;
      const upload = {
        tempPath,
        resolvedPath,
        declaredSize,
        received: 0,
        failed: false,
        done: false,
        stream: createWriteStream(tempPath, { mode: 0o600 }),
      };
      uploads.set(streamId, upload);

      const abort = () => {
        if (upload.failed || upload.done) return;
        upload.failed = true;
        uploads.delete(streamId);
        upload.stream.destroy();
        try { unlinkSync(tempPath); } catch { /* best effort */ }
      };
      conn.registerUpload(streamId, {
        onData(chunk, { final }) {
          if (upload.failed || upload.done) return;
          upload.received += chunk.length;
          if (upload.received > maxUploadBytes || upload.received > declaredSize) {
            conn.notify('stream.error', { streamId, error: 'Upload exceeded its declared size.', code: 413 });
            abort();
            return;
          }
          upload.stream.write(chunk);
          if (final) {
            upload.done = true;
            upload.stream.end();
          }
        },
        onError() {
          abort();
        },
      });
      return { accepted: true };
    },

    finishUpload(streamId, conn) {
      const upload = uploads.get(streamId);
      if (!upload || upload.failed) {
        throw errorWithCode('Upload stream not found or aborted.', 404);
      }
      if (!upload.done) {
        throw errorWithCode('Upload is incomplete: the final chunk has not arrived.', 400);
      }
      if (upload.received !== upload.declaredSize) {
        uploads.delete(streamId);
        try { unlinkSync(upload.tempPath); } catch { /* best effort */ }
        throw errorWithCode(`Upload size mismatch: received ${upload.received} of ${upload.declaredSize} bytes.`, 400);
      }
      conn.finishUpload(streamId);
      uploads.delete(streamId);
      try {
        renameSync(upload.tempPath, upload.resolvedPath);
      } catch (error) {
        try { unlinkSync(upload.tempPath); } catch { /* best effort */ }
        throw errorWithCode(error.message || 'Failed to store upload.', 500);
      }
      return { success: true, message: 'File uploaded' };
    },
  };

  return operations;
}

/**
 * WebSocket message handlers wrapping the shared file operations.
 */
export function createFileHandlers(operations) {
  return {
    'file.list': (payload) => operations.list(payload?.path || '', {
      recursive: payload?.recursive === true,
      includeHidden: payload?.includeHidden === true,
    }),
    'file.create': (payload) => operations.create(payload?.path, payload?.content ?? '', payload?.isDirectory === true),
    'file.delete': (payload) => operations.remove(payload?.path),
    'file.move': (payload) => operations.move(payload?.sourcePath, payload?.targetPath),
    'file.download': (payload, conn) => operations.download(payload?.path, conn, Number(payload?.streamId)),
    'file.upload.begin': (payload, conn) => operations.beginUpload(
      payload?.path,
      conn,
      Number(payload?.streamId),
      Number(payload?.size)
    ),
    'file.upload.end': (payload, conn) => operations.finishUpload(Number(payload?.streamId), conn),
  };
}
