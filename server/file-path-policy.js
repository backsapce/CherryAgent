import { existsSync, lstatSync, realpathSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
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
  const canonicalRoot = resolvePathThroughExistingPrefix(root);
  const canonicalProtectedPaths = [...new Set(
    protectedPaths.map((path) => resolvePathThroughExistingPrefix(path))
  )];

  const isSameOrChild = (candidate, parent) => {
    const compareCandidate = comparablePath(resolve(candidate), platform);
    const compareParent = comparablePath(resolve(parent), platform);
    return compareCandidate === compareParent
      || compareCandidate.startsWith(compareParent + sep);
  };

  const hasSymlinkBelowRoot = (resolvedPath) => {
    const relativePath = relative(root, resolvedPath);
    if (!relativePath) return false;
    let current = root;
    for (const segment of relativePath.split(/[\\/]+/).filter(Boolean)) {
      current = join(current, segment);
      try {
        if (lstatSync(current).isSymbolicLink()) return true;
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        return true;
      }
    }
    return false;
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

  const resolveSafePath = (inputPath) => {
    if (
      typeof inputPath !== 'string'
      || inputPath.includes('\0')
      || isAbsolute(inputPath)
    ) return null;
    const normalizedPath = normalize(inputPath);
    if (normalizedPath.split(/[\\/]+/).includes('..')) return null;
    const resolvedPath = resolve(join(root, normalizedPath));
    if (!isSameOrChild(resolvedPath, root)) return null;

    // Existing symlinks below the public root are never followed. This also
    // protects not-yet-created targets whose nearest existing parent is an
    // alias to the isolated control plane.
    if (hasSymlinkBelowRoot(resolvedPath)) return null;
    const canonicalPath = resolvePathThroughExistingPrefix(resolvedPath);
    if (!isSameOrChild(canonicalPath, canonicalRoot)) return null;
    if (isProtectedPath(canonicalPath)) return null;
    return { resolvedPath, canonicalPath };
  };

  return {
    containsProtectedPath,
    isProtectedPath,
    isSameOrChildPath: isSameOrChild,
    isSafeMutationPath(inputPath) {
      const safePath = resolveSafePath(inputPath);
      return Boolean(safePath && !containsProtectedPath(safePath.canonicalPath));
    },
    isSafePath(inputPath) {
      return Boolean(resolveSafePath(inputPath));
    },
    resolveSafePath,
  };
}
