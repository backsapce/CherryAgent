import assert from 'node:assert/strict';
import test from 'node:test';
import process from 'node:process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isSameOrChildPath,
  migrateLegacyAgentState,
  resolveAgentStatePaths,
} from './agent-state.js';

test('default sandbox control state is outside the executable workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'cherry-agent-state-paths-'));
  try {
    const workspaceDir = join(root, 'workspace');
    const paths = resolveAgentStatePaths({ env: {}, workspaceDir });

    assert.equal(isSameOrChildPath(paths.stateDir, workspaceDir), false);
    assert.equal(isSameOrChildPath(paths.runsDir, paths.stateDir), true);
    assert.equal(isSameOrChildPath(paths.jobsDir, paths.stateDir), true);
    assert.equal(isSameOrChildPath(paths.tokenFile, paths.stateDir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace symlink aliases resolve to the same default control state', {
  skip: process.platform === 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'cherry-agent-state-alias-'));
  try {
    const workspaceDir = join(root, 'workspace');
    const workspaceAlias = join(root, 'workspace-alias');
    mkdirSync(workspaceDir);
    symlinkSync(workspaceDir, workspaceAlias, 'dir');

    const direct = resolveAgentStatePaths({ env: {}, workspaceDir });
    const alias = resolveAgentStatePaths({ env: {}, workspaceDir: workspaceAlias });

    assert.equal(alias.stateDir, direct.stateDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing workspaces use their nearest real parent for the default state key', {
  skip: process.platform === 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'cherry-agent-state-missing-alias-'));
  try {
    const realParent = join(root, 'real-parent');
    const aliasParent = join(root, 'alias-parent');
    mkdirSync(realParent);
    symlinkSync(realParent, aliasParent, 'dir');

    const direct = resolveAgentStatePaths({
      env: {},
      workspaceDir: join(realParent, 'future-workspace'),
    });
    const alias = resolveAgentStatePaths({
      env: {},
      workspaceDir: join(aliasParent, 'future-workspace'),
    });
    assert.equal(alias.stateDir, direct.stateDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy workspace state is copied into isolated control storage once', () => {
  const root = mkdtempSync(join(tmpdir(), 'cherry-agent-state-migrate-'));
  try {
    const workspaceDir = join(root, 'workspace');
    const stateDir = join(root, 'control');
    mkdirSync(join(workspaceDir, '.cherry-runs'), { recursive: true });
    mkdirSync(join(workspaceDir, '.cherry-jobs'), { recursive: true });
    writeFileSync(join(workspaceDir, '.cherry-token'), 'token-one\n');
    writeFileSync(join(workspaceDir, '.cherry-runs', 'run-one.json'), '{"id":"run-one"}');
    writeFileSync(join(workspaceDir, '.cherry-jobs', 'job-one.json'), '{"id":"job-one"}');

    const paths = resolveAgentStatePaths({
      env: { AGENT_STATE_DIR: stateDir },
      workspaceDir,
      legacyCwd: workspaceDir,
    });
    migrateLegacyAgentState(paths, { log() {}, warn() {} });

    assert.equal(readFileSync(paths.tokenFile, 'utf8'), 'token-one\n');
    assert.equal(readFileSync(join(paths.runsDir, 'run-one.json'), 'utf8'), '{"id":"run-one"}');
    assert.equal(readFileSync(join(paths.jobsDir, 'job-one.json'), 'utf8'), '{"id":"job-one"}');
    assert.equal(existsSync(paths.legacyRunsDir), true);

    // A workspace cleanup can remove every executable/user file without
    // touching the copied control plane.
    rmSync(workspaceDir, { recursive: true, force: true });
    assert.equal(readFileSync(join(paths.runsDir, 'run-one.json'), 'utf8'), '{"id":"run-one"}');

    writeFileSync(paths.tokenFile, 'new-token\n');
    migrateLegacyAgentState(paths, { log() {}, warn() {} });
    assert.equal(readFileSync(paths.tokenFile, 'utf8'), 'new-token\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed legacy copy stops startup without suppressing the next retry', () => {
  const root = mkdtempSync(join(tmpdir(), 'cherry-agent-state-retry-'));
  try {
    const workspaceDir = join(root, 'workspace');
    const stateDir = join(root, 'control');
    mkdirSync(join(workspaceDir, '.cherry-runs'), { recursive: true });
    writeFileSync(join(workspaceDir, '.cherry-token'), 'token-one\n');
    writeFileSync(join(workspaceDir, '.cherry-runs', 'run-one.json'), '{"id":"run-one"}');

    const paths = resolveAgentStatePaths({
      env: { AGENT_STATE_DIR: stateDir },
      workspaceDir,
      legacyCwd: workspaceDir,
    });
    const injectedFailure = new Error('injected copy failure');
    assert.throws(
      () => migrateLegacyAgentState(
        paths,
        { log() {}, error() {} },
        { copy() { throw injectedFailure; } }
      ),
      /Could not migrate legacy control state/
    );
    assert.equal(existsSync(paths.tokenFile), false);
    assert.equal(existsSync(paths.runsDir), false);
    assert.equal(
      readdirSync(stateDir).some((name) => name.includes('.migrating-')),
      false
    );

    migrateLegacyAgentState(paths, { log() {}, error() {} });
    assert.equal(readFileSync(paths.tokenFile, 'utf8'), 'token-one\n');
    assert.equal(readFileSync(join(paths.runsDir, 'run-one.json'), 'utf8'), '{"id":"run-one"}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nested legacy symlinks fail closed and remain retryable', {
  skip: process.platform === 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'cherry-agent-state-symlink-'));
  try {
    const workspaceDir = join(root, 'workspace');
    const stateDir = join(root, 'control');
    const legacyRunsDir = join(workspaceDir, '.cherry-runs');
    const linkedRun = join(legacyRunsDir, 'run-one.json');
    const externalRun = join(root, 'external-run.json');
    mkdirSync(legacyRunsDir, { recursive: true });
    writeFileSync(externalRun, '{"id":"outside"}');
    symlinkSync(externalRun, linkedRun, 'file');

    const paths = resolveAgentStatePaths({
      env: {
        AGENT_STATE_DIR: stateDir,
        AGENT_TOKEN_FILE: join(stateDir, 'tokens-explicit'),
      },
      workspaceDir,
    });
    assert.throws(
      () => migrateLegacyAgentState(paths, { log() {}, error() {} }),
      /Nested symlink is not allowed/
    );
    assert.equal(existsSync(paths.runsDir), false);
    assert.equal(
      readdirSync(stateDir).some((name) => name.includes('.migrating-')),
      false
    );

    unlinkSync(linkedRun);
    writeFileSync(linkedRun, '{"id":"run-one"}');
    migrateLegacyAgentState(paths, { log() {}, error() {} });
    assert.equal(readFileSync(join(paths.runsDir, 'run-one.json'), 'utf8'), '{"id":"run-one"}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy token candidates cover both the old process cwd and workspace defaults', () => {
  const root = mkdtempSync(join(tmpdir(), 'cherry-agent-state-token-cwd-'));
  try {
    const legacyCwd = join(root, 'old-cwd');
    const workspaceDir = join(root, 'workspace');
    const stateDir = join(root, 'control');
    mkdirSync(legacyCwd);
    mkdirSync(workspaceDir);
    writeFileSync(join(legacyCwd, '.cherry-token'), 'cwd-token\n');
    writeFileSync(join(workspaceDir, '.cherry-token'), 'workspace-token\n');

    const paths = resolveAgentStatePaths({
      env: { AGENT_STATE_DIR: stateDir },
      workspaceDir,
      legacyCwd,
    });
    migrateLegacyAgentState(paths, { log() {}, error() {} });

    assert.deepEqual(
      readFileSync(paths.tokenFile, 'utf8').trim().split('\n').sort(),
      ['cwd-token', 'workspace-token']
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('physical target containment is rejected before copying legacy state', {
  skip: process.platform === 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'cherry-agent-state-contained-alias-'));
  try {
    const workspaceDir = join(root, 'workspace');
    const legacyRunsDir = join(workspaceDir, '.cherry-runs');
    const physicalStateDir = join(legacyRunsDir, 'control');
    const stateAlias = join(root, 'control-alias');
    mkdirSync(physicalStateDir, { recursive: true });
    writeFileSync(join(legacyRunsDir, 'run-one.json'), '{"id":"run-one"}');
    symlinkSync(physicalStateDir, stateAlias, 'dir');

    const paths = resolveAgentStatePaths({
      env: {
        AGENT_STATE_DIR: stateAlias,
        AGENT_TOKEN_FILE: join(root, 'tokens-explicit'),
        AGENT_JOBS_DIR: join(root, 'jobs-explicit'),
      },
      workspaceDir,
    });
    let copyCalls = 0;
    assert.throws(
      () => migrateLegacyAgentState(
        paths,
        { log() {}, error() {} },
        { copy() { copyCalls += 1; } }
      ),
      /Migration target must not be inside its legacy source/
    );
    assert.equal(copyCalls, 0);
    assert.equal(existsSync(paths.runsDir), false);
    assert.equal(
      readdirSync(physicalStateDir).some((name) => name.includes('.migrating-')),
      false
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an atomic concurrent token migration winner is never overwritten', () => {
  const root = mkdtempSync(join(tmpdir(), 'cherry-agent-state-token-race-'));
  try {
    const workspaceDir = join(root, 'workspace');
    const stateDir = join(root, 'control');
    mkdirSync(workspaceDir);
    writeFileSync(join(workspaceDir, '.cherry-token'), 'legacy-token\n');
    const paths = resolveAgentStatePaths({
      env: {
        AGENT_STATE_DIR: stateDir,
        AGENT_RUNS_DIR: join(root, 'runs-explicit'),
        AGENT_JOBS_DIR: join(root, 'jobs-explicit'),
      },
      workspaceDir,
      legacyCwd: workspaceDir,
    });

    migrateLegacyAgentState(
      paths,
      { log() {}, error() {} },
      {
        copy(source, target, options) {
          cpSync(source, target, options);
          // Model another process atomically winning after this process copied
          // its temporary file but before it installs that file.
          writeFileSync(paths.tokenFile, 'concurrent-winner\n');
        },
      }
    );
    assert.equal(readFileSync(paths.tokenFile, 'utf8'), 'concurrent-winner\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an existing target with the wrong type fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'cherry-agent-state-wrong-target-'));
  try {
    const workspaceDir = join(root, 'workspace');
    const stateDir = join(root, 'control');
    mkdirSync(join(workspaceDir, '.cherry-runs'), { recursive: true });
    mkdirSync(stateDir);
    writeFileSync(join(workspaceDir, '.cherry-runs', 'run-one.json'), '{}');
    const paths = resolveAgentStatePaths({
      env: {
        AGENT_STATE_DIR: stateDir,
        AGENT_TOKEN_FILE: join(root, 'tokens-explicit'),
        AGENT_JOBS_DIR: join(root, 'jobs-explicit'),
      },
      workspaceDir,
    });
    writeFileSync(paths.runsDir, 'not-a-directory');

    assert.throws(
      () => migrateLegacyAgentState(paths, { log() {}, error() {} }),
      /Unsafe existing target state path/
    );
    assert.equal(readFileSync(paths.runsDir, 'utf8'), 'not-a-directory');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
