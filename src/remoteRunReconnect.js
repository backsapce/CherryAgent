/**
 * Reattach loop for durable sandbox-run event streams.
 *
 * A durable run keeps executing on the agent server while the browser is
 * disconnected, so a transport failure (network blip, LAN route flap, agent
 * server restart for a deployment) must not fail the turn. Instead of
 * surfacing "connection lost" as a terminal error, this module reattaches the
 * live subscription from the persisted event cursor until the server answers
 * with a definitive run status:
 *
 *   - transport errors  → retry with backoff (UI shows a reconnect notice)
 *   - definitive reply  → rethrow immediately (run not found, auth, conflict)
 *   - running/waiting   → keep streaming, exactly like the first attach
 *   - terminal status   → resolve; the caller reads the final snapshot
 *
 * The reconnect window bounds one outage. If it expires, the last transport
 * error is rethrown so the existing outer resume/retry machinery takes over.
 */

// A rolling deploy (rsync + PM2 reload + health check) keeps the server down
// for seconds; a network flap is usually shorter. The window must cover the
// worst realistic outage while still guaranteeing the user eventually sees a
// result instead of an eternal "reconnecting…" state.
export const REMOTE_RUN_RECONNECT_WINDOW_MS = 10 * 60_000;
export const REMOTE_RUN_RECONNECT_BASE_DELAY_MS = 1_000;
export const REMOTE_RUN_RECONNECT_MAX_DELAY_MS = 10_000;

const RECONNECTABLE_ERROR_CODES = new Set([
  'AGENT_CONNECTION_LOST',
  'AGENT_REQUEST_TIMEOUT',
  'AGENT_RUNTIME_NETWORK_ERROR',
]);

/**
 * Can this subscription failure be bridged by silently reattaching?
 * Transport failures can (the durable run is unaffected server-side);
 * definitive server replies cannot — retrying a 404/401/409 only hides the
 * real problem. Abort errors never reconnect.
 */
export function isRemoteRunReconnectableError(error) {
  if (!error) return false;
  if (error.retryable === true) return true;
  if (RECONNECTABLE_ERROR_CODES.has(error.code)) return true;
  const status = Number(error.status);
  if (Number.isFinite(status)) return status >= 500 || status === 429;
  return false;
}

function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

function abortError() {
  return new DOMException('Agent run detached', 'AbortError');
}

/** Exponential backoff with jitter; rejects early when the run is aborted. */
function reconnectDelay(baseDelayMs, maxDelayMs, attempt, signal) {
  const raw = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempt - 1, 4));
  const delay = Math.max(0, Math.floor(raw * (0.7 + Math.random() * 0.6)));
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timerId);
      reject(abortError());
    };
    const timerId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Subscribe to a durable run's live event stream and keep that subscription
 * alive across transport outages.
 *
 * @param {{
 *   url: string,
 *   runId: string,
 *   cursor?: number,
 *   signal?: AbortSignal,
 *   isAlive?: () => boolean,
 *   subscribe: (url: string, spec: object) => {{ready: Promise<void>, unsubscribe: () => void}},
 *   onEvents?: (events: Array) => void,
 *   onStatus?: (snapshot: object) => void,
 *   onReconnect?: (notice: {attempt: number, sinceMs: number} | null) => void,
 *   windowMs?: number,
 *   baseDelayMs?: number,
 *   maxDelayMs?: number,
 * }} spec
 * @returns {Promise<void>} resolves when the server reports a terminal status
 */
export async function attachRemoteRunStream({
  url,
  runId,
  cursor = 0,
  signal,
  isAlive = () => true,
  subscribe,
  onEvents,
  onStatus,
  onReconnect,
  windowMs = REMOTE_RUN_RECONNECT_WINDOW_MS,
  baseDelayMs = REMOTE_RUN_RECONNECT_BASE_DELAY_MS,
  maxDelayMs = REMOTE_RUN_RECONNECT_MAX_DELAY_MS,
}) {
  // The loop owns the event cursor so every reattach resumes exactly where
  // the previous subscription stopped, without replaying applied events.
  let appliedCursor = Math.max(0, Math.floor(Number(cursor) || 0));
  let outageStartedAtMs = 0;
  let attempt = 0;
  for (;;) {
    let loopSettled = false;
    let resolveLoop;
    let rejectLoop;
    const loopDone = new Promise((resolve, reject) => {
      resolveLoop = resolve;
      rejectLoop = reject;
    });
    const finishLoop = (error) => {
      if (loopSettled) return;
      loopSettled = true;
      if (error) rejectLoop(asError(error));
      else resolveLoop();
    };
    const subscription = subscribe(url, {
      runId,
      after: appliedCursor,
      signal,
      onEvents: (events) => {
        const list = Array.isArray(events) ? events : [];
        for (const event of list) {
          appliedCursor = Math.max(appliedCursor, Number(event?.remoteSequence) || 0);
        }
        onEvents?.(events);
      },
      onStatus: (snapshot) => {
        onStatus?.(snapshot);
        // running/waiting keep streaming; anything else is the run's final
        // word (completed, idle, error, interrupted, aborted).
        if (!['running', 'waiting'].includes(snapshot?.status)) finishLoop();
      },
      onError: finishLoop,
    });
    let attemptError = null;
    try {
      await subscription.ready;
      if (signal?.aborted || !isAlive()) throw abortError();
      // The server answered this attempt: the outage (if any) is over.
      if (attempt > 0) onReconnect?.(null);
      outageStartedAtMs = 0;
      attempt = 0;
      await loopDone;
      return;
    } catch (error) {
      attemptError = asError(error);
    } finally {
      try { subscription.unsubscribe(); } catch { /* best effort */ }
    }
    if (signal?.aborted || !isAlive()) throw attemptError;
    if (!isRemoteRunReconnectableError(attemptError)) throw attemptError;
    if (!outageStartedAtMs) outageStartedAtMs = Date.now();
    if (Date.now() - outageStartedAtMs > windowMs) {
      onReconnect?.(null);
      throw attemptError;
    }
    attempt += 1;
    onReconnect?.({ attempt, sinceMs: outageStartedAtMs });
    await reconnectDelay(baseDelayMs, maxDelayMs, attempt, signal);
  }
}
