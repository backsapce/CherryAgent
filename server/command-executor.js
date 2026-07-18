import { spawn } from 'node:child_process';
import process from 'node:process';

const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_SETTLE_GRACE_MS = 1_000;

function abortError() {
  const error = new Error('Command execution aborted');
  error.name = 'AbortError';
  return error;
}

function boundedText(chunk, remainingBytes) {
  if (remainingBytes <= 0) return '';
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  return buffer.subarray(0, remainingBytes).toString();
}

function resultCode(reason, code) {
  if (reason === 'timeout') return 124;
  if (reason === 'aborted') return 130;
  if (reason === 'output_limit') return 125;
  return code ?? 1;
}

/**
 * Run shell commands in their own process group so cancellation applies to the
 * shell and every CLI process it creates. The final watchdog guarantees that a
 * caller is never left waiting for a close event held open by a descendant.
 */
export function createCommandExecutor({
  cwd,
  shell,
  publicCwd = 'workspace',
  publicFilesRoot = 'workspace',
  maxOutputBytes = 10 * 1024 * 1024,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  settleGraceMs = DEFAULT_SETTLE_GRACE_MS,
  spawnImpl = spawn,
  platform = process.platform,
  killProcess = process.kill.bind(process),
} = {}) {
  function signalTree(child, signal) {
    if (!child?.pid) return false;

    if (platform === 'win32') {
      const args = ['/pid', String(child.pid), '/t'];
      if (signal === 'SIGKILL') args.push('/f');
      try {
        const killer = spawnImpl('taskkill', args, { windowsHide: true, stdio: 'ignore' });
        killer.unref?.();
        return true;
      } catch {
        return child.kill?.(signal) ?? false;
      }
    }

    try {
      killProcess(-child.pid, signal);
      return true;
    } catch {
      try {
        return child.kill?.(signal) ?? false;
      } catch {
        return false;
      }
    }
  }

  function start(command, options = {}) {
    const startedAtMs = Date.now();
    const captureOutput = options.captureOutput !== false;
    const outputLimit = options.maxOutputBytes === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Number.isFinite(options.maxOutputBytes)
        ? Math.max(0, options.maxOutputBytes)
        : maxOutputBytes;
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let terminationReason = null;
    let timeoutTimer = null;
    let forceTimer = null;
    let settleTimer = null;
    let resolveResult;

    const child = spawnImpl(command, {
      cwd,
      shell: shell || true,
      windowsHide: true,
      detached: platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const result = new Promise((resolve) => { resolveResult = resolve; });

    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (settleTimer) clearTimeout(settleTimer);
    };

    const finish = ({ code = null, signal = null, error = null } = {}) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (terminationReason) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      const status = terminationReason === 'timeout'
        ? 'timed_out'
        : terminationReason === 'aborted'
          ? 'aborted'
          : terminationReason === 'output_limit'
            ? 'output_limit'
            : error
              ? 'spawn_error'
              : 'exited';
      resolveResult({
        stdout,
        stderr: error && !stderr ? String(error.message || error) : stderr,
        code: resultCode(terminationReason, code),
        status,
        signal,
        timedOut: status === 'timed_out',
        durationMs: Date.now() - startedAtMs,
        outputTruncated: terminationReason === 'output_limit',
        platform,
        shell: shell || 'default',
        cwd: publicCwd,
        filesRoot: publicFilesRoot,
      });
    };

    const terminate = (reason = 'aborted') => {
      if (settled) return result;
      if (!terminationReason) terminationReason = reason;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      signalTree(child, 'SIGTERM');
      if (!forceTimer) {
        forceTimer = setTimeout(() => {
          signalTree(child, 'SIGKILL');
          settleTimer = setTimeout(() => finish({ signal: 'SIGKILL' }), settleGraceMs);
        }, killGraceMs);
      }
      return result;
    };

    const handleChunk = (streamName, chunk) => {
      if (settled || terminationReason) return;
      const chunkBytes = Buffer.byteLength(chunk);
      const remainingBytes = outputLimit - outputBytes;
      const accepted = boundedText(chunk, remainingBytes);
      const acceptedBytes = Buffer.byteLength(accepted);
      outputBytes += acceptedBytes;

      if (streamName === 'stdout') {
        if (captureOutput) stdout += accepted;
        if (accepted) options.onStdout?.(accepted);
      } else {
        if (captureOutput) stderr += accepted;
        if (accepted) options.onStderr?.(accepted);
      }

      if (chunkBytes > acceptedBytes) {
        const notice = `\n[agent] Output exceeded ${outputLimit} bytes; command terminated.\n`;
        if (captureOutput) stderr += notice;
        options.onStderr?.(notice);
        terminate('output_limit');
      }
    };

    options.onStart?.({
      platform,
      shell: shell || 'default',
      cwd: publicCwd,
      filesRoot: publicFilesRoot,
      pid: child.pid,
    });

    child.stdout?.on('data', (chunk) => handleChunk('stdout', chunk));
    child.stderr?.on('data', (chunk) => handleChunk('stderr', chunk));
    child.on('error', (error) => finish({ error }));
    child.on('close', (code, signal) => finish({ code, signal }));

    if (Number.isFinite(options.timeout) && options.timeout > 0) {
      timeoutTimer = setTimeout(() => terminate('timeout'), options.timeout);
    }

    return {
      child,
      pid: child.pid,
      result,
      terminate,
    };
  }

  async function execute(command, options = {}) {
    if (options.signal?.aborted) throw abortError();
    const handle = start(command, options);
    let aborted = false;
    const abort = () => {
      aborted = true;
      handle.terminate('aborted');
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const commandResult = await handle.result;
      if (aborted || options.signal?.aborted) throw abortError();
      return commandResult;
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  }

  return { execute, start };
}
