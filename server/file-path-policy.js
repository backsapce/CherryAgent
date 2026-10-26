import { existsSync, realpathSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
  sep,
} from 'node:path';
import process from 'node:process';

function comparablePath(path, platform) {
  return ['darwin', 'win32'].includes(platform) ? path.toLowerCase() : path;
}

export function resolvePathThroughExistingPrefix(inputPath) {
  let current = resolve(inputPath);
  const missingSegments = [];

  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missingSegments.unshift(basename(current));
    current = parent;
  }

  const canonicalBase = existsSync(current)
    ? (realpathSync.native?.(current) || realpathSync(current))
    : current;
  return resolve(canonicalBase, ...missingSegments);
}

export function createFilePathPolicy({
  filesRootDir,
  protectedPaths = [],
  platform = process.platform,
}) {
  const root = resolve(filesRootDir);
  const canonicalProtectedPaths = [...new Set(
    protectedPaths.map((path) => resolvePathThroughExistingPrefix(path))
  )];

  const isSameOrChild = (candidate, parent) => {
    const compareCandidate = comparablePath(resolve(candidate), platform);
    const compareParent = comparablePath(resolve(parent), platform);
    return compareCandidate === compareParent
      || compareCandidate.startsWith(compareParent + sep);
  };

  const isProtectedPath = (path) => {
    const canonicalPath = resolvePathThroughExistingPrefix(path);
    return canonicalProtectedPaths.some((protectedPath) => (
      isSameOrChild(canonicalPath, protectedPath)
    ));
  };

  const containsProtectedPath = (path) => {
    const canonicalPath = resolvePathThroughExistingPrefix(path);
    return canonicalProtectedPaths.some((protectedPath) => (
      isSameOrChild(protectedPath, canonicalPath)
    ));
  };

  // Unrestricted resolution: absolute paths are honored as-is and relative
  // paths resolve against the files root. There is no containment, traversal
  // (`..`), or symlink rejection — the sandbox container is the security
  // boundary, matching the already-unrestricted shell tools. Only protected
  // control-plane paths remain guarded for mutations (delete/move), so a run
  // cannot destroy the agent server's own state, tokens, or job records.
  const resolveSafePath = (inputPath) => {
    if (typeof inputPath !== 'string' || inputPath.includes('\0')) return null;
    const resolvedPath = isAbsolute(inputPath)
      ? resolve(inputPath)
      : resolve(join(root, normalize(inputPath)));
    const canonicalPath = resolvePathThroughExistingPrefix(resolvedPath);
    return { resolvedPath, canonicalPath };
  };

  return {
    containsProtectedPath,
    isProtectedPath,
    isSameOrChildPath: isSameOrChild,
    isSafeMutationPath(inputPath) {
      const safePath = resolveSafePath(inputPath);
      return Boolean(
        safePath
        && !isProtectedPath(safePath.canonicalPath)
        && !containsProtectedPath(safePath.canonicalPath)
      );
    },
    isSafePath(inputPath) {
      return Boolean(resolveSafePath(inputPath));
    },
    resolveSafePath,
  };
}
