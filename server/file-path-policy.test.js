import assert from 'node:assert/strict';
import test from 'node:test';
import process from 'node:process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFilePathPolicy } from './file-path-policy.js';

test('file path policy allows unrestricted reads/writes, including outside the files root', () => {
  const root = mkdtempSync(join(tmpdir(), 'cherry-agent-path-policy-'));
  try {
    const filesRootDir = join(root, 'files');
    const legacyRunsDir = join(filesRootDir, '.cherry-runs');
    mkdirSync(legacyRunsDir, { recursive: true });
    writeFileSync(join(legacyRunsDir, 'run.json'), '{}');
    const policy = createFilePathPolicy({
      filesRootDir,
      protectedPaths: [legacyRunsDir],
    });

    // Reads and writes are no longer intercepted: protected paths, traversal,
    // and absolute paths outside the files root all resolve.
    assert.equal(policy.isSafePath('notes/new.txt'), true);
    assert.equal(policy.isSafePath('.cherry-runs/run.json'), true);
    assert.equal(policy.isSafePath('../../elsewhere.txt'), true);
    assert.equal(policy.isSafePath(join(root, 'outside.txt')), true);

    // Mutations still refuse to touch protected control state (or an ancestor
    // that contains it), but stay unrestricted everywhere else.
    assert.equal(policy.isSafeMutationPath(''), false);
    assert.equal(policy.isSafeMutationPath('notes'), true);
    assert.equal(policy.isSafeMutationPath('.cherry-runs/run.json'), false);
    assert.equal(policy.isSafeMutationPath(join(root, 'outside')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('file path policy resolves absolute and relative paths to distinct targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'cherry-agent-path-resolve-'));
  try {
    const filesRootDir = join(root, 'files');
    mkdirSync(filesRootDir);
    const outsideDir = join(root, 'outside');
    mkdirSync(outsideDir);
    const policy = createFilePathPolicy({ filesRootDir, protectedPaths: [] });

    const relative = policy.resolveSafePath('notes/a.txt');
    assert.equal(relative.resolvedPath, join(filesRootDir, 'notes/a.txt'));

    const absolute = policy.resolveSafePath(join(outsideDir, 'b.txt'));
    assert.equal(absolute.resolvedPath, join(outsideDir, 'b.txt'));

    // Only non-strings and NUL bytes are rejected.
    assert.equal(policy.isSafePath(null), false);
    assert.equal(policy.isSafePath('a\0b'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('file path policy no longer blocks symlinked paths for reads but guards them for mutations', {
  skip: process.platform === 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'cherry-agent-path-alias-'));
  try {
    const filesRootDir = join(root, 'files');
    const stateDir = join(root, 'state');
    mkdirSync(filesRootDir);
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, 'tokens'), 'secret');
    symlinkSync(stateDir, join(filesRootDir, 'state-link'), 'dir');
    const policy = createFilePathPolicy({
      filesRootDir,
      protectedPaths: [stateDir],
    });

    assert.equal(policy.isSafePath('state-link/tokens'), true);
    assert.equal(policy.isSafePath('state-link/new-run.json'), true);
    assert.equal(policy.isSafeMutationPath('state-link'), false);
    assert.equal(policy.isSafeMutationPath(join(stateDir, 'tokens')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('protected mutation guards are case-insensitive on default macOS filesystems', () => {
  const root = mkdtempSync(join(tmpdir(), 'cherry-agent-path-case-'));
  try {
    const filesRootDir = join(root, 'files');
    mkdirSync(filesRootDir);
    const policy = createFilePathPolicy({
      filesRootDir,
      protectedPaths: [join(filesRootDir, '.cherry-token')],
      platform: 'darwin',
    });

    assert.equal(policy.isSafePath('.CHERRY-TOKEN'), true);
    assert.equal(policy.isSafeMutationPath('.CHERRY-TOKEN'), false);
    assert.equal(policy.isSafeMutationPath('.cherry-token'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
