/**
 * FIFO concurrency limiter for agent-server file downloads.
 *
 * Every image reference rendered in the message transcript downloads its
 * whole file on mount, and all browser↔server traffic multiplexes over one
 * WebSocket connection. A page full of images therefore fires one burst of
 * `file.download` requests that the server counts as simultaneously
 * in-flight, rejecting the excess with 429 "Too many concurrent requests."
 * Downloads queue here instead so the wire stays under that guard.
 */

const DEFAULT_MAX_CONCURRENT = 6;

/**
 * @param {number} [maxConcurrent] - Simultaneous downloads allowed
 * @returns {{
 *   acquire: (signal?: AbortSignal) => Promise<void>,
 *   release: () => void,
 *   active: number,
 *   queued: number,
 * }}
 */
export function createDownloadLimiter(maxConcurrent = DEFAULT_MAX_CONCURRENT) {
  let active = 0;
  const waiters = [];

  function abortErrorOf(signal) {
    return signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Request aborted', 'AbortError');
  }

  function acquire(signal) {
    if (signal?.aborted) return Promise.reject(abortErrorOf(signal));
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, signal, onAbort: null };
      // A waiter that aborts must leave the queue without a slot: release()
      // hands slots only to waiters it shifts off the queue itself.
      waiter.onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index === -1) return;
        waiters.splice(index, 1);
        reject(abortErrorOf(signal));
      };
      waiters.push(waiter);
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
    });
  }

  function release() {
    const waiter = waiters.shift();
    if (!waiter) {
      active = Math.max(0, active - 1);
      return;
    }
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    waiter.resolve();
  }

  return {
    acquire,
    release,
    get active() { return active; },
    get queued() { return waiters.length; },
  };
}
