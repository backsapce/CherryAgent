import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createCommandExecutor } from './command-executor.js';
import { createCommandJobManager } from './command-jobs.js';

const nodeCommand = (source) => `"${process.execPath}" -e ${JSON.stringify(source)}`;

function createManager(directory) {
  return createCommandJobManager({
    jobsDir: directory,
    executor: createCommandExecutor({ cwd: process.cwd(), killGraceMs: 40, settleGraceMs: 40 }),
    maxLogBytes: 1024 * 1024,
    maxReadBytes: 1024,
  });
}

test('background jobs return immediately and expose incremental logs until completion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cherry-command-jobs-'));
  try {
    const manager = createManager(directory);
    let state = manager.start(nodeCommand("const fs=require('fs');fs.writeSync(1,'first\\n');setTimeout(()=>fs.writeSync(1,'last\\n'),80)"));
    assert.match(state.job_id, /^job-/);
    assert.equal(state.status, 'running');

    let cursor = state.nextCursor;
    let collected = state.log;
    for (let attempt = 0; attempt < 5 && state.status === 'running'; attempt += 1) {
      state = await manager.wait(state.job_id, { cursor, waitMs: 1_000 });
      collected += state.log;
      cursor = state.nextCursor;
    }

    assert.equal(state.status, 'completed');
    assert.equal(state.exit_code, 0);
    assert.match(collected, /first/);
    assert.match(collected, /last/);
    const noRepeatedLogs = manager.get(state.job_id, cursor);
    assert.equal(noRepeatedLogs.log, '');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('stopping a background job terminates its process tree', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cherry-command-stop-'));
  try {
    const manager = createManager(directory);
    const started = manager.start(nodeCommand('setInterval(()=>{},1000)'));
    const stopped = await manager.stop(started.job_id);

    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.exit_code, 130);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a restarted manager marks unobserved active jobs as interrupted', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cherry-command-reload-'));
  try {
    const fakeExecutor = {
      start() {
        return { pid: 42, result: new Promise(() => {}), terminate: async () => {} };
      },
    };
    const first = createCommandJobManager({ jobsDir: directory, executor: fakeExecutor });
    const started = first.start('long-running-command');
    const reloaded = createCommandJobManager({ jobsDir: directory, executor: fakeExecutor });

    assert.equal(reloaded.get(started.job_id).status, 'interrupted');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
