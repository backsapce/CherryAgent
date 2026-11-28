import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

function createControlledJobs(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cherry-command-jobs-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const handles = [];
  const executor = {
    start(_command, { onStdout, onStderr }) {
      const { promise: result, resolve, reject } = Promise.withResolvers();
      const handle = {
        pid: 42 + handles.length,
        result,
        stdout: onStdout,
        stderr: onStderr,
        finish: (value = { code: 0, status: 'exited' }) => resolve(value),
        reject,
        terminate(reason) {
          this.termination = reason;
          return result;
        },
      };
      handles.push(handle);
      return handle;
    },
  };
  const manager = createCommandJobManager({ jobsDir: directory, executor, ...options });
  return { directory, handles, executor, manager };
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

test('a log write failure wakes the waiter and terminates only its own job', { timeout: 3_000 }, async (t) => {
  const { directory, handles, manager } = createControlledJobs(t, { maxActiveJobs: 2 });
  const job = manager.start('first');
  const other = manager.start('second');
  const waiting = manager.wait(job.job_id);
  const path = join(directory, `${job.job_id}.log`);
  rmSync(path);
  mkdirSync(path);

  handles[0].stdout('output');
  const failed = await waiting;
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Could not save background command/);
  assert.equal(failed.log, '');
  assert.equal(failed.hasMore, false);
  assert.equal(handles[0].termination, 'aborted');
  assert.equal(handles[1].termination, undefined);
  assert.equal(manager.get(other.job_id).status, 'running');
  assert.equal(manager.start('third').status, 'running');

  handles[0].stderr('late output');
  handles[0].finish({ code: 130, status: 'aborted' });
  await handles[0].result;
  assert.equal(manager.get(job.job_id).error, failed.error);
});

for (const phase of ['truncation', 'completion', 'stop']) {
  test(`a metadata write failure during ${phase} leaves no active job`, { timeout: 3_000 }, async (t) => {
    const { directory, handles, manager } = createControlledJobs(t, { maxLogBytes: 4, maxActiveJobs: 1 });
    const job = manager.start('example');
    const waiting = manager.wait(job.job_id);
    mkdirSync(join(directory, `${job.job_id}.json.tmp`));
    if (phase === 'truncation') handles[0].stdout('abcde');
    if (phase === 'completion') handles[0].finish();
    if (phase === 'stop') assert.equal((await manager.stop(job.job_id)).status, 'failed');

    const failed = await waiting;
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /Could not save background command/);
    assert.equal(failed.log, phase === 'truncation' ? 'abcd' : '');
    assert.equal(handles[0].termination, phase === 'completion' ? undefined : 'aborted');
    assert.equal(manager.start('next').status, 'running');
  });
}

test('a job is not started if its initial files cannot be created', (t) => {
  const { directory, handles, manager } = createControlledJobs(t, { maxActiveJobs: 1 });
  rmSync(directory, { recursive: true });
  assert.throws(() => manager.start('first'), { code: 'ENOENT' });
  assert.equal(handles.length, 0);
  mkdirSync(directory);
  assert.equal(manager.start('next').status, 'running');
});

test('a pid save failure after spawn still terminates and observes the child', async (t) => {
  const { directory, handles, executor, manager } = createControlledJobs(t);
  const start = executor.start;
  executor.start = (...args) => {
    const metadata = readdirSync(directory).find((name) => name.endsWith('.json'));
    mkdirSync(join(directory, `${metadata}.tmp`));
    return start(...args);
  };

  const failed = manager.start('example');
  assert.equal(failed.status, 'failed');
  handles[0].reject(new Error('injected cleanup failure'));
  await assert.rejects(handles[0].result, /injected cleanup failure/);
  assert.equal(handles[0].termination, 'aborted');
  assert.equal(manager.get(failed.job_id).error, failed.error);
});

test('a rejected executor result wakes the waiter despite failed cleanup', { timeout: 3_000 }, async (t) => {
  const { handles, manager } = createControlledJobs(t, { maxActiveJobs: 1 });
  const job = manager.start('example');
  const waiting = manager.wait(job.job_id);
  handles[0].reject(new Error('injected executor failure'));

  const failed = await waiting;
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /injected executor failure/);
  assert.equal(handles[0].termination, 'aborted');
  assert.equal(manager.start('next').status, 'running');
});

test('log limits write whole UTF-8 characters and preserve byte cursors across pages', (t) => {
  const { directory, handles, manager } = createControlledJobs(t, { maxLogBytes: 8, maxReadBytes: 4 });
  const job = manager.start('example');
  handles[0].stdout('a🙂b€');
  assert.deepEqual(readFileSync(join(directory, `${job.job_id}.log`)), Buffer.from('a🙂b'));

  const first = manager.get(job.job_id);
  const second = manager.get(job.job_id, first.nextCursor);
  const last = manager.get(job.job_id, second.nextCursor);
  assert.equal(first.log_truncated, true);
  assert.deepEqual([first.log, second.log, last.log], ['a', '🙂', 'b']);
  assert.deepEqual([first.nextCursor, second.nextCursor, last.nextCursor], [1, 5, 6]);
  assert.deepEqual([first.hasMore, second.hasMore, last.hasMore], [true, true, false]);
});

test('an incomplete log tail waits for terminal status, then drains', { timeout: 3_000 }, async (t) => {
  const { directory, handles, manager } = createControlledJobs(t);
  const job = manager.start('example');
  const damaged = Buffer.from('a🙂').subarray(0, 3);
  writeFileSync(join(directory, `${job.job_id}.log`), damaged);

  const first = manager.get(job.job_id);
  const pending = manager.get(job.job_id, first.nextCursor);
  assert.equal(first.log, 'a');
  assert.equal(pending.log, '');
  assert.equal(pending.nextCursor, 1);
  assert.equal(pending.hasMore, false);

  const waiting = manager.wait(job.job_id, { cursor: pending.nextCursor });
  handles[0].finish();
  const last = await waiting;
  assert.equal(last.status, 'completed');
  assert.equal(last.log, '\uFFFD');
  assert.equal(last.nextCursor, damaged.length);
  assert.equal(last.hasMore, false);
});
