import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import process from 'node:process';

function safeStateKey(workspaceDir) {
  const name = basename(workspaceDir)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48) || 'workspace';
  const digest = createHash('sha256').update(workspaceDir).digest('hex').slice(0, 24);
  return `${name}-${digest}`;
}

function canonicalWorkspacePath(workspaceDir) {
  let current = resolve(workspaceDir);
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

export function isSameOrChildPath(candidate, parent) {
  const resolvedCandidate = resolve(candidate);
  const resolvedParent = resolve(parent);
  const compareCandidate = process.platform === 'win32'
    ? resolvedCandidate.toLowerCase()
    : resolvedCandidate;
  const compareParent = process.platform === 'win32'
    ? resolvedParent.toLowerCase()
    : resolvedParent;
  return compareCandidate === compareParent
    || compareCandidate.startsWith(compareParent + sep);
}

/** Resolve control-plane storage independently from the executable workspace. */
export function resolveAgentStatePaths({
  env = process.env,
  workspaceDir = env.AGENT_WORKING_DIR || process.cwd(),
  legacyCwd = process.cwd(),
} = {}) {
  const workspace = resolve(workspaceDir);
  const canonicalWorkspace = canonicalWorkspacePath(workspace);
  const stateKeyWorkspace = process.platform === 'win32'
    ? canonicalWorkspace.toLowerCase()
    : canonicalWorkspace;
  const stateDir = resolve(
    env.AGENT_STATE_DIR
      || join(
        dirname(canonicalWorkspace),
        '.vertex-sandbox-state',
        safeStateKey(stateKeyWorkspace)
      )
  );
  const legacyTokenFiles = [...new Set([
    join(resolve(legacyCwd), '.vertex-token'),
    join(workspace, '.vertex-token'),
  ])];
  return {
    workspaceDir: workspace,
    stateDir,
    tokenFile: resolve(env.AGENT_TOKEN_FILE || join(stateDir, 'tokens')),
    runsDir: resolve(env.AGENT_RUNS_DIR || join(stateDir, 'runs')),
    jobsDir: resolve(env.AGENT_JOBS_DIR || join(stateDir, 'jobs')),
    legacyTokenFile: join(workspace, '.vertex-token'),
    legacyTokenFiles,
    legacyRunsDir: join(workspace, '.vertex-runs'),
    legacyJobsDir: join(workspace, '.vertex-jobs'),
    migrateToken: !env.AGENT_TOKEN_FILE,
    migrateRuns: !env.AGENT_RUNS_DIR,
    migrateJobs: !env.AGENT_JOBS_DIR,
  };
}

/**
 * Copy legacy workspace-owned state once. The old copy is deliberately kept so
 * a failed upgrade remains reversible; all new writes target the isolated
 * state directory.
 */
export function migrateLegacyAgentState(paths, logger = console, { copy = cpSync } = {}) {
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const migrations = [
    {
      enabled: paths.migrateToken,
      kind: 'file',
      sources: paths.legacyTokenFiles || [paths.legacyTokenFile],
      target: paths.tokenFile,
    },
    {
      enabled: paths.migrateRuns,
      kind: 'directory',
      sources: [paths.legacyRunsDir],
      target: paths.runsDir,
    },
    {
      enabled: paths.migrateJobs,
      kind: 'directory',
      sources: [paths.legacyJobsDir],
      target: paths.jobsDir,
    },
  ];

  for (const migration of migrations) {
    if (!migration.enabled) continue;
    const sources = [...new Set(migration.sources.map((source) => resolve(source)))]
      .filter((source) => source !== resolve(migration.target) && existsSync(source));
    if (sources.length === 0) continue;
    try {
      for (const source of sources) {
        assertStatePathType(source, migration.kind, 'legacy');
      }
      if (existsSync(migration.target)) {
        assertStatePathType(migration.target, migration.kind, 'existing target');
        continue;
      }
      mkdirSync(dirname(migration.target), { recursive: true });
      const physicalTarget = resolve(
        realpathSync(dirname(migration.target)),
        basename(migration.target)
      );
      for (const source of sources) {
        const physicalSource = realpathSync(source);
        if (isSameOrChildPath(physicalTarget, physicalSource)) {
          throw new Error(
            `Migration target must not be inside its legacy source: ${source}`
          );
        }
      }
      const temporary = `${migration.target}.migrating-${process.pid}-${randomUUID()}`;
      rmSync(temporary, { recursive: true, force: true });
      try {
        copy(sources[0], temporary, {
          recursive: migration.kind === 'directory',
          errorOnExist: true,
          force: false,
          filter: (source) => {
            const stats = lstatSync(source);
            if (stats.isSymbolicLink()) {
              throw new Error(`Nested symlink is not allowed in legacy state: ${source}`);
            }
            if (!stats.isDirectory() && !stats.isFile()) {
              throw new Error(`Unsupported legacy state entry: ${source}`);
            }
            return true;
          },
        });
        if (migration.kind === 'file' && sources.length > 1) {
          const tokens = new Set();
          for (const source of sources) {
            for (const token of readFileSync(source, 'utf8').split('\n')) {
              if (token.trim()) tokens.add(token.trim());
            }
          }
          writeFileSync(temporary, `${[...tokens].join('\n')}\n`, {
            encoding: 'utf8',
            mode: 0o600,
          });
        }
        try {
          if (migration.kind === 'file') {
            // A hard link installs the fully-written token file atomically and
            // refuses to overwrite a concurrent migration winner.
            linkSync(temporary, migration.target);
            unlinkSync(temporary);
          } else {
            renameSync(temporary, migration.target);
          }
        } catch (installError) {
          if (!existsSync(migration.target)) throw installError;
          assertStatePathType(migration.target, migration.kind, 'concurrent target');
          logger.log?.(`[agent] Another process migrated control state to ${migration.target}`);
        }
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
      logger.log?.(`[agent] Copied legacy control state to ${migration.target}`);
    } catch (error) {
      const sourceLabel = sources.join(', ');
      const migrationError = new Error(
        `Could not migrate legacy control state ${sourceLabel}: ${error.message}`,
        { cause: error }
      );
      logger.error?.(`[agent] ${migrationError.message}`);
      // Starting with an empty canonical directory would make the legacy runs
      // appear lost and would permanently suppress the next migration attempt.
      // Fail closed while the atomic source remains available for a retry.
      throw migrationError;
    }
  }
}

function assertStatePathType(path, kind, label) {
  const stats = lstatSync(path);
  const validType = kind === 'directory' ? stats.isDirectory() : stats.isFile();
  if (!validType || stats.isSymbolicLink()) {
    throw new Error(`Unsafe ${label} state path: ${path}`);
  }
}
