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

test('file path policy rejects direct and ancestor mutations of protected state', () => {
  const root = mkdtempSync(join(tmpdir(), 'vertex-agent-path-policy-'));
  try {
    const filesRootDir = join(root, 'files');
    const legacyRunsDir = join(filesRootDir, '.vertex-runs');
    mkdirSync(legacyRunsDir, { recursive: true });
    writeFileSync(join(legacyRunsDir, 'run.json'), '{}');
    const policy = createFilePathPolicy({
      filesRootDir,
      protectedPaths: [legacyRunsDir],
    });

    assert.equal(policy.isSafePath('notes/new.txt'), true);
    assert.equal(policy.isSafePath('.vertex-runs/run.json'), false);
    assert.equal(policy.isSafeMutationPath(''), false);
    assert.equal(policy.isSafeMutationPath('notes'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('file path policy rejects a symlink alias to external control state', {
  skip: process.platform === 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'vertex-agent-path-alias-'));
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

    assert.equal(policy.isSafePath('state-link/tokens'), false);
    assert.equal(policy.isSafePath('state-link/new-run.json'), false);
    assert.equal(policy.isSafeMutationPath('state-link'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('protected path comparisons are case-insensitive on default macOS filesystems', () => {
  const root = mkdtempSync(join(tmpdir(), 'vertex-agent-path-case-'));
  try {
    const filesRootDir = join(root, 'files');
    mkdirSync(filesRootDir);
    const policy = createFilePathPolicy({
      filesRootDir,
      protectedPaths: [join(filesRootDir, '.vertex-token')],
      platform: 'darwin',
    });

    assert.equal(policy.isSafePath('.VERTEX-TOKEN'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
