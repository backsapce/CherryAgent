import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const DEFAULT_MAX_LOG_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_READ_BYTES = 64 * 1024;
const DEFAULT_MAX_ACTIVE_JOBS = 16;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted']);

function abortError() {
  const error = new Error('Command wait aborted');
  error.name = 'AbortError';
  return error;
}

function clampInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

export function createCommandJobManager({
  jobsDir,
  executor,
  maxLogBytes = DEFAULT_MAX_LOG_BYTES,
  maxReadBytes = DEFAULT_MAX_READ_BYTES,
  maxActiveJobs = DEFAULT_MAX_ACTIVE_JOBS,
} = {}) {
  if (!jobsDir) throw new Error('jobsDir is required');
  if (!executor?.start) throw new Error('executor is required');
  mkdirSync(jobsDir, { recursive: true });

  const jobs = new Map();
  const waiters = new Map();

  const metadataPath = (id) => join(jobsDir, `${id}.json`);
  const logPath = (id) => join(jobsDir, `${id}.log`);

  const persist = (job) => {
    const target = metadataPath(job.id);
    const temporary = `${target}.tmp`;
    const { handle: _handle, ...serializable } = job;
    writeFileSync(temporary, JSON.stringify(serializable, null, 2), 'utf8');
    renameSync(temporary, target);
  };

  const notify = (id) => {
    const pending = waiters.get(id);
    if (!pending) return;
    waiters.delete(id);
    for (const resolve of pending) resolve();
  };

  for (const name of readdirSync(jobsDir).filter((entry) => entry.endsWith('.json'))) {
    try {
      const saved = JSON.parse(readFileSync(join(jobsDir, name), 'utf8'));
      if (!saved?.id) continue;
      if (['running', 'stopping'].includes(saved.status)) {
        saved.status = 'interrupted';
        saved.finishedAt = new Date().toISOString();
        saved.error = 'Agent server restarted before command completion could be observed.';
      }
      saved.handle = null;
      jobs.set(saved.id, saved);
      persist(saved);
    } catch {
      // A damaged job record must not prevent other jobs from loading.
    }
  }

  const appendLog = (job, chunk) => {
    if (!chunk || job.logTruncated) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const remaining = maxLogBytes - job.logBytes;
    if (remaining > 0) {
      const accepted = buffer.subarray(0, remaining);
      appendFileSync(logPath(job.id), accepted);
      job.logBytes += accepted.length;
    }
    if (buffer.length > remaining || job.logBytes >= maxLogBytes) {
      job.logTruncated = true;
      persist(job);
    }
    job.updatedAt = new Date().toISOString();
    notify(job.id);
  };

  const readLog = (job, cursor = 0) => {
    const path = logPath(job.id);
    const size = existsSync(path) ? statSync(path).size : 0;
    const start = clampInteger(cursor, 0, size);
    const length = Math.min(maxReadBytes, size - start);
    if (length <= 0) {
      return { log: '', logCursor: start, nextCursor: start, logSize: size, hasMore: false };
    }
    const buffer = Buffer.alloc(length);
    const descriptor = openSync(path, 'r');
    try {
      readSync(descriptor, buffer, 0, length, start);
    } finally {
      closeSync(descriptor);
    }
    return {
      log: buffer.toString(),
      logCursor: start,
      nextCursor: start + length,
      logSize: size,
      hasMore: start + length < size,
    };
  };

  const snapshot = (job, cursor = 0) => ({
    job_id: job.id,
    status: job.status,
    command: job.command,
    pid: job.pid || null,
    started_at: job.startedAt,
    updated_at: job.updatedAt,
    finished_at: job.finishedAt || null,
    exit_code: job.exitCode ?? null,
    signal: job.signal || null,
    duration_ms: job.durationMs ?? null,
    error: job.error || null,
    log_truncated: !!job.logTruncated,
    ...readLog(job, cursor),
  });

  const complete = (job, result) => {
    if (job.status === 'stopped') return;
    job.status = result.status === 'aborted'
      ? 'stopped'
      : result.status === 'exited' && result.code === 0
        ? 'completed'
        : 'failed';
    job.exitCode = result.code;
    job.signal = result.signal || null;
    job.durationMs = result.durationMs;
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    if (result.status === 'spawn_error') job.error = result.stderr || 'Command failed to start.';
    job.handle = null;
    persist(job);
    notify(job.id);
  };

  const start = (command) => {
    const active = [...jobs.values()].filter((job) => !TERMINAL_STATUSES.has(job.status));
    if (active.length >= maxActiveJobs) {
      throw new Error(`Too many active background commands (maximum ${maxActiveJobs}).`);
    }

    const now = new Date().toISOString();
    const job = {
      id: `job-${randomUUID()}`,
      status: 'running',
      command,
      pid: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      exitCode: null,
      signal: null,
      durationMs: null,
      error: null,
      logBytes: 0,
      logTruncated: false,
      handle: null,
    };
    jobs.set(job.id, job);
    writeFileSync(logPath(job.id), '');
    persist(job);

    try {
      const handle = executor.start(command, {
        captureOutput: false,
        maxOutputBytes: Number.POSITIVE_INFINITY,
        onStdout: (chunk) => appendLog(job, chunk),
        onStderr: (chunk) => appendLog(job, chunk),
      });
      job.handle = handle;
      job.pid = handle.pid;
      persist(job);
      handle.result.then((result) => complete(job, result));
    } catch (error) {
      complete(job, {
        status: 'spawn_error',
        code: 1,
        signal: null,
        durationMs: 0,
        stderr: error.message || String(error),
      });
    }

    return snapshot(job, 0);
  };

  const get = (id, cursor = 0) => {
    const job = jobs.get(id);
    return job ? snapshot(job, cursor) : null;
  };

  const wait = async (id, { cursor = 0, waitMs = 30_000, signal } = {}) => {
    const initial = get(id, cursor);
    if (!initial) return null;
    if (TERMINAL_STATUSES.has(initial.status) || initial.logSize > initial.logCursor || waitMs <= 0) return initial;
    if (signal?.aborted) throw abortError();

    await new Promise((resolve, reject) => {
      let timer;
      const removeWaiter = () => {
        const pending = waiters.get(id);
        pending?.delete(finish);
        if (pending?.size === 0) waiters.delete(id);
      };
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        removeWaiter();
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        removeWaiter();
        reject(abortError());
      };
      if (!waiters.has(id)) waiters.set(id, new Set());
      waiters.get(id).add(finish);
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(finish, clampInteger(waitMs, 1, 30_000));

      const latest = get(id, cursor);
      if (!latest || TERMINAL_STATUSES.has(latest.status) || latest.logSize > latest.logCursor) finish();
    });
    return get(id, cursor);
  };

  const stop = async (id) => {
    const job = jobs.get(id);
    if (!job) return null;
    if (TERMINAL_STATUSES.has(job.status)) return snapshot(job, job.logBytes);
    job.status = 'stopping';
    job.updatedAt = new Date().toISOString();
    persist(job);
    notify(id);

    if (!job.handle) {
      job.status = 'interrupted';
      job.finishedAt = new Date().toISOString();
      job.error = 'The command process is no longer attached to this server.';
      persist(job);
      return snapshot(job, job.logBytes);
    }
    await job.handle.terminate('aborted');
    return snapshot(job, job.logBytes);
  };

  return { start, get, wait, stop };
}
