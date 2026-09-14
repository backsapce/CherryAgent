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
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const DEFAULT_MAX_LOG_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_READ_BYTES = 64 * 1024;
const DEFAULT_MAX_ACTIVE_JOBS = 16;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted']);
const DEFAULT_JOB_RETENTION_MS = 7 * 24 * 60 * 60_000;
// Longest single wait a caller may request (7 days, matching schedule_wakeup
// and comfortably inside Node's ~24.8-day setTimeout range).
const MAX_WAIT_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_JOB_PRUNE_INTERVAL_MS = 60 * 60_000;
const MAX_RETAINED_TERMINAL_JOBS = 200;

function abortError() {
  const error = new Error('Command wait aborted');
  error.name = 'AbortError';
  return error;
}

/** Trim a trailing incomplete UTF-8 sequence so segment boundaries stay valid. */
function utf8SafeLength(buffer) {
  let end = buffer.length;
  if (end === 0) return 0;
  const last = buffer[end - 1];
  if ((last & 0xc0) === 0x80) {
    // Continuation byte: locate its lead byte and drop the partial sequence
    // when not all of its continuation bytes have arrived yet.
    let lead = end - 1;
    let steps = 0;
    while (lead > 0 && (buffer[lead] & 0xc0) === 0x80 && steps < 3) {
      lead -= 1;
      steps += 1;
    }
    const leadByte = buffer[lead];
    const expected = leadByte >= 0xf0 ? 4 : leadByte >= 0xe0 ? 3 : leadByte >= 0xc0 ? 2 : 0;
    if (expected === 0 || end - lead < expected) end = lead;
  } else if ((last & 0xc0) === 0xc0) {
    // Lead byte without any continuation yet.
    end -= 1;
  }
  return end;
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
  jobRetentionMs = DEFAULT_JOB_RETENTION_MS,
  jobPruneIntervalMs = DEFAULT_JOB_PRUNE_INTERVAL_MS,
  maxRetainedTerminalJobs = MAX_RETAINED_TERMINAL_JOBS,
} = {}) {
  if (!jobsDir) throw new Error('jobsDir is required');
  if (!executor?.start) throw new Error('executor is required');
  mkdirSync(jobsDir, { recursive: true, mode: 0o700 });

  const jobs = new Map();
  const waiters = new Map();

  const metadataPath = (id) => join(jobsDir, `${id}.json`);
  const logPath = (id) => join(jobsDir, `${id}.log`);

  const removeJobFiles = (id) => {
    if (!/^[\w.-]+$/.test(String(id || ''))) return;
    for (const suffix of ['.json', '.json.tmp', '.log']) {
      try {
        rmSync(join(jobsDir, `${id}${suffix}`), { force: true });
      } catch {
        // Best effort; the next prune pass retries.
      }
    }
  };

  // Terminal job records and their logs are useful for replay, not forever:
  // each log can reach maxLogBytes, so unbounded retention eventually fills
  // the disk on a long-lived server.
  const pruneExpiredJobs = () => {
    const cutoff = Date.now() - Math.max(1, jobRetentionMs);
    const terminal = [...jobs.values()]
      .filter((job) => TERMINAL_STATUSES.has(job.status))
      .sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')));
    const overflow = terminal.slice(0, Math.max(0, terminal.length - maxRetainedTerminalJobs));
    const expired = terminal.filter((job) => Date.parse(job.updatedAt || '') < cutoff);
    for (const job of [...overflow, ...expired]) {
      jobs.delete(job.id);
      removeJobFiles(job.id);
    }
  };

  const pruneTimer = typeof jobPruneIntervalMs === 'number' && jobPruneIntervalMs > 0
    ? setInterval(pruneExpiredJobs, jobPruneIntervalMs)
    : null;
  pruneTimer?.unref?.();

  const persist = (job) => {
    const target = metadataPath(job.id);
    const temporary = `${target}.tmp`;
    const { handle: _handle, ...serializable } = job;
    writeFileSync(temporary, JSON.stringify(serializable, null, 2), { encoding: 'utf8', mode: 0o600 });
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
  pruneExpiredJobs();

  const appendLog = (job, chunk) => {
    if (!chunk || job.logTruncated) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const remaining = maxLogBytes - job.logBytes;
    if (remaining > 0) {
      const accepted = buffer.subarray(0, remaining);
      appendFileSync(logPath(job.id), accepted, { mode: 0o600 });
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
    // Never hand out a trailing partial UTF-8 sequence: the log is append-only,
    // so backing the cursor up re-reads those bytes once they are complete.
    const safeLength = utf8SafeLength(buffer);
    return {
      log: buffer.subarray(0, safeLength).toString('utf8'),
      logCursor: start,
      nextCursor: start + safeLength,
      logSize: size,
      hasMore: start + safeLength < size,
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
      timer = setTimeout(finish, clampInteger(waitMs, 1, MAX_WAIT_MS));

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
