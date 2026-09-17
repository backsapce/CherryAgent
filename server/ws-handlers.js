/**
 * Domain message handlers for the agent WebSocket protocol: foreground
 * command execution (multiplexed push streams), managed background jobs
 * (request/reply + push subscription), and the web search/fetch proxies.
 * Each handler mirrors the semantics of the HTTP routes this protocol
 * replaces, including rate limits and validation, so the browser client only
 * changes transport.
 */

const DEFAULT_MAX_CONCURRENT_EXEC = 8;
// One job subscription serves its waits in bounded slices: every slice
// boundary produces a push, which also keeps proxies and intermediaries from
// declaring the connection idle during long waits.
const JOB_SUBSCRIBE_SLICE_MS = 20_000;
const JOB_TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted']);

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isTerminalSnapshot(snapshot) {
  return JOB_TERMINAL_STATUSES.has(snapshot?.status) && !snapshot?.hasMore;
}

/**
 * @param {{
 *   streamCommand: (cmd: string, callbacks: object, timeout?: number) => object,
 *   validateCommand: (cmd: string) => {blocked: boolean, reason?: string},
 *   rateLimit: (key: string, max: number, windowMs: number) => boolean,
 *   jobManager: {start: Function, get: Function, wait: Function, stop: Function},
 *   runWebSearch: Function,
 *   fetchWebPage: Function,
 *   normalizeWebUrl: Function,
 *   isPrivateWebHostname: Function,
 *   allowPrivateWebFetch?: boolean,
 *   maxConcurrentExec?: number,
 *   log?: (...args: any[]) => void,
 *   warn?: (...args: any[]) => void,
 *   truncateLog?: (value: string, max?: number) => string,
 * }} deps
 */
export function createDomainHandlers(deps) {
  const {
    streamCommand,
    validateCommand,
    rateLimit,
    jobManager,
    runWebSearch,
    fetchWebPage,
    normalizeWebUrl,
    isPrivateWebHostname,
    allowPrivateWebFetch = false,
    maxConcurrentExec = DEFAULT_MAX_CONCURRENT_EXEC,
    log = () => {},
    warn = () => {},
    truncateLog = (value) => value,
  } = deps;

  function checkCommandAllowed(conn, cmd, label) {
    if (rateLimit(`cmd:${conn.ip}`, 30, 60_000)) {
      throw errorWithCode('Too many commands. Slow down.', 429);
    }
    if (typeof cmd !== 'string' || !cmd) {
      throw errorWithCode(`Missing or invalid "${label}" field.`, 400);
    }
    const validation = validateCommand(cmd);
    if (validation.blocked) {
      warn(`BLOCKED command: ${cmd} (${validation.reason})`);
      throw errorWithCode(`Command blocked: ${validation.reason}`, 403);
    }
  }

  const exec = {
    'exec.start'(payload, conn) {
      const { sub, cmd } = payload;
      checkCommandAllowed(conn, cmd, 'cmd');
      const active = conn.execHandles || (conn.execHandles = new Map());
      if (active.size >= maxConcurrentExec) {
        throw errorWithCode('Too many concurrent commands on this connection.', 429);
      }
      log(`exec: ${cmd}`);
      let settled = false;
      const finish = () => {
        settled = true;
        active.delete(sub);
        conn.removeSubscription(sub);
      };
      const handle = streamCommand(cmd, {
        onStart: (meta) => conn.send('exec.start', sub, meta),
        onStdout: (data) => conn.send('exec.data', sub, { stream: 'stdout', data }),
        onStderr: (data) => conn.send('exec.data', sub, { stream: 'stderr', data }),
        onError: (error) => {
          warn(`exec error: ${error.message}`);
          conn.send('exec.error', sub, { error: error.message });
          finish();
        },
        onExit: (result) => {
          log(`exec exit code: ${result.code} (${result.platform}, ${result.shell}, cwd=${result.cwd})`);
          if (result.code !== 0) {
            if (result.stdout) log(`stdout:\n${truncateLog(result.stdout)}`);
            if (result.stderr) warn(`stderr:\n${truncateLog(result.stderr)}`);
          }
          conn.send('exec.exit', sub, result);
          finish();
        },
      });
      if (settled) {
        // A synchronous spawn failure already terminated this stream.
        return { started: false };
      }
      active.set(sub, handle);
      conn.addSubscription(sub, () => {
        active.delete(sub);
        handle.terminate('aborted');
      });
      return { started: true };
    },
    'exec.cancel'(payload, conn) {
      const active = conn.execHandles;
      const handle = active?.get(payload.sub);
      if (!handle) throw errorWithCode('No such command stream.', 404);
      handle.terminate('aborted');
      return { cancelling: true };
    },
  };

  const jobs = {
    'job.start'(payload, conn) {
      const command = payload?.command;
      checkCommandAllowed(conn, command, 'command');
      log(`background exec: ${command}`);
      try {
        return jobManager.start(command);
      } catch (error) {
        throw errorWithCode(error.message || 'Could not start background command', 400);
      }
    },
    async 'job.get'(payload) {
      const result = jobManager.get(payload?.job_id, Number(payload?.cursor) || 0);
      if (!result) throw errorWithCode('Background command not found', 404);
      return result;
    },
    async 'job.stop'(payload) {
      const result = await jobManager.stop(payload?.job_id);
      if (!result) throw errorWithCode('Background command not found', 404);
      return result;
    },
    async 'job.subscribe'(payload, conn) {
      const { sub, job_id: jobId } = payload;
      const cursor = Math.max(0, Number(payload?.cursor) || 0);
      if (!jobId || typeof jobId !== 'string') {
        throw errorWithCode('Missing or invalid "job_id" field.', 400);
      }
      const initial = jobManager.get(jobId, cursor);
      if (!initial) throw errorWithCode('Background command not found', 404);
      conn.send('job.update', sub, initial);

      const waiter = new AbortController();
      conn.addSubscription(sub, () => waiter.abort());
      // Reply after the initial snapshot so a client racing unsubscribe vs
      // updates never sees a reply for a subscription it already dropped.
      setImmediate(() => {
        void (async () => {
          let current = initial;
          try {
            while (
              !waiter.signal.aborted
              && !isTerminalSnapshot(current)
            ) {
              current = await jobManager.wait(jobId, {
                cursor: current.nextCursor ?? current.logCursor ?? 0,
                waitMs: JOB_SUBSCRIBE_SLICE_MS,
                signal: waiter.signal,
              });
              if (waiter.signal.aborted) return;
              conn.send('job.update', sub, current);
            }
          } catch (error) {
            if (error?.name !== 'AbortError') {
              conn.send('job.error', sub, { error: error.message || 'Job wait failed' });
            }
          } finally {
            if (!waiter.signal.aborted) conn.removeSubscription(sub);
          }
        })();
      });
      return { subscribed: true };
    },
  };

  const web = {
    async 'web.search'(payload, conn) {
      if (rateLimit(`websearch:${conn.ip}`, 30, 60_000)) {
        throw errorWithCode('Too many search requests. Slow down.', 429);
      }
      const searchConfig = payload?.config || {};
      const searchRequest = payload?.request || {};
      if (!searchRequest || typeof searchRequest.query !== 'string' || !searchRequest.query.trim()) {
        throw errorWithCode('Missing or invalid "request.query" field.', 400);
      }
      log(`web-search: ${searchConfig.provider} "${searchRequest.query.slice(0, 200)}"`);
      try {
        return await runWebSearch(searchConfig, searchRequest, {});
      } catch (error) {
        warn(`web-search failed: ${error.message}`);
        const code = error.statusCode && error.statusCode >= 400 && error.statusCode < 500
          ? error.statusCode
          : 502;
        throw errorWithCode(error.message || 'Web search failed', code);
      }
    },
    async 'web.fetch'(payload, conn) {
      if (rateLimit(`webfetch:${conn.ip}`, 60, 60_000)) {
        throw errorWithCode('Too many fetch requests. Slow down.', 429);
      }
      const normalizedTarget = normalizeWebUrl(payload?.url);
      if (!normalizedTarget) {
        throw errorWithCode('Missing or invalid "url" field: only http(s) URLs are supported', 400);
      }
      // Defense-in-depth for CSRF-shaped misuse when auth is disabled: private
      // addresses stay unreachable unless the operator opts in. A token holder
      // can already run arbitrary shell, so this is not a hard boundary.
      let targetHost = null;
      try {
        targetHost = new URL(normalizedTarget).hostname;
      } catch { /* unreachable: normalizeWebUrl validated it */ }
      if (!allowPrivateWebFetch && isPrivateWebHostname(targetHost)) {
        throw errorWithCode(
          'Refusing to fetch private or loopback addresses through the web proxy (set AGENT_ALLOW_PRIVATE_WEB_FETCH=1 to allow).',
          403
        );
      }
      log(`web-fetch: ${normalizedTarget}`);
      try {
        return await fetchWebPage(normalizedTarget, {
          maxChars: payload?.max_chars,
          timeoutMs: 30_000,
          // The proxy is the shared cache owner; each request re-validates the
          // TTL centrally instead of trusting a client-supplied cache flag.
          noCache: false,
        });
      } catch (error) {
        warn(`web-fetch failed: ${error.message}`);
        throw errorWithCode(error.message || 'Web fetch failed', error.statusCode || 502);
      }
    },
  };

  return {
    ping: () => ({ t: Date.now() }),
    ...exec,
    ...jobs,
    ...web,
  };
}
