/**
 * Browser-side WebSocket connection manager for CherryAgent agent servers.
 *
 * One multiplexed connection per agent URL carries all traffic (commands,
 * jobs, durable runs, files, web proxies) using the request/reply + push
 * envelope defined in server/ws-protocol.js:
 *
 *   browser → server:  { id, type, payload }
 *   server → browser:  { id, ok: true, data } | { id, ok: false, error, code }
 *   server → browser:  { type, sub, data }              (push)
 *   binary frames:     [u32 streamId][u8 flags] + chunk  (file transfers)
 *
 * Reconnects with backoff while a request is in flight; in-flight requests
 * and subscriptions fail fast with AGENT_CONNECTION_LOST so callers can apply
 * their own resume policies (the durable-run reattach flow already does).
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 20_000;
const PING_TIMEOUT_MS = 10_000;
const PING_FAILURES_BEFORE_RESET = 2;
// While a large request frame (e.g. a run.start carrying image attachments) is
// still queued in the browser's send buffer, ping replies cannot overtake it.
// Pings that time out in that state describe a busy wire, not a dead server.
const PING_SEND_BUFFER_BUSY_BYTES = 64 * 1024;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 8_000;
const SEND_BUFFER_HIGH_BYTES = 4 * 1024 * 1024;

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  return LOOPBACK_HOSTNAMES.has(host) || host.endsWith('.localhost');
}

/**
 * Reject unencrypted agent endpoints outside the loopback. Agent traffic
 * carries the auth token (and sandbox runs carry the LLM API key), so plain
 * http/ws to a LAN or remote host leaks a credential that cannot be scoped or
 * expired from the UI. Relative URLs ride the page origin and are allowed.
 */
export function assertSecureAgentUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return; // Relative path: same origin as the page.
  }
  if (parsed.protocol !== 'http:') return;
  if (isLoopbackHostname(parsed.hostname)) return;
  const error = new Error(
    `Refusing to contact agent server over unencrypted http://${parsed.hostname}. Agent requests carry the auth token (and sandbox runs carry the LLM API key), so use an https:// URL; plain http is only allowed for localhost.`
  );
  error.name = 'AgentUrlSecurityError';
  error.code = 'AGENT_INSECURE_URL';
  throw error;
}

function isLoopbackAgentUrl(url) {
  if (!url) return true;
  try {
    const parsed = new URL(url, window.location.href);
    const page = new URL(window.location.href);
    const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    const isAgentPath = parsed.pathname === '/agent' || parsed.pathname.startsWith('/agent/');
    // Port 3099 is the one endpoint deliberately routed through the page's
    // Vite proxy. An explicit localhost URL on any other port must remain
    // explicit; treating every `/agent` pathname as proxied silently sends
    // custom AGENT_PORT installations to the wrong server.
    return isLoopback && (
      parsed.port === '3099'
      || (parsed.origin === page.origin && isAgentPath)
    );
  } catch {
    return false;
  }
}

/**
 * Resolve an agent host URL (or relative path) into the WebSocket endpoint.
 * Loopback endpoints collapse to the page origin so they ride the Vite proxy.
 */
export function resolveAgentWsUrl(url) {
  if (isLoopbackAgentUrl(url)) {
    const base = new URL('/agent/ws', window.location.href);
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    return base.toString();
  }
  assertSecureAgentUrl(url);
  let endpoint;
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.pathname === '/agent' || parsed.pathname === '/agent/ws') {
      endpoint = new URL('/agent/ws', parsed.origin);
    } else {
      // A bare origin targets the server root: the server only serves the
      // canonical /agent/ws endpoint, so an empty path falls back to /agent.
      // Other paths are proxy-mounted prefixes and keep the <prefix>/ws form.
      const path = parsed.pathname.replace(/\/+$/, '');
      endpoint = new URL(`${path || '/agent'}/ws`, parsed.origin);
    }
  } catch {
    endpoint = new URL('/agent/ws', window.location.href);
  }
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  return endpoint.toString();
}

export function connectionLostError(message = 'Agent server connection lost') {
  const error = new Error(message);
  error.name = 'AgentConnectionLostError';
  error.code = 'AGENT_CONNECTION_LOST';
  error.retryable = true;
  return error;
}

function timeoutError(message) {
  const error = new Error(message);
  error.name = 'TimeoutError';
  error.code = 'AGENT_REQUEST_TIMEOUT';
  return error;
}

function requestError(message, code) {
  const error = new Error(message);
  error.code = Number(code) || 500;
  // Mirror the numeric code as `status` for callers that classify errors by
  // the old HTTP status convention.
  if (Number.isFinite(error.code)) error.status = error.code;
  if (error.code >= 500) error.retryable = true;
  return error;
}

let requestSeq = 0;
function nextRequestId(prefix = 'c') {
  requestSeq += 1;
  return `${prefix}${Date.now().toString(36)}-${requestSeq}`;
}

function jitter(delay) {
  return Math.floor(delay * (0.7 + Math.random() * 0.6));
}

export class AgentWsConnection {
  #resolveReady = null;
  #rejectReady = null;

  /**
   * @param {string} url - agent host URL (any form resolveAgentWsUrl accepts)
   * @param {{getToken?: () => string|null, WebSocketImpl?: typeof WebSocket}} [options]
   */
  constructor(url, options = {}) {
    this.url = url;
    this.wsUrl = resolveAgentWsUrl(url);
    this.getToken = options.getToken || (() => null);
    this.WebSocketImpl = options.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this.state = 'idle'; // idle | connecting | connected | needsAuth | closed
    this.stateListeners = new Set();
    this.welcome = null;
    this.socket = null;
    this.generation = 0;
    this.readyPromise = null;
    this.helloRequestId = null;
    this.handshakeTimer = null;
    this.pending = new Map(); // requestId → {resolve, reject, timer, onAbort}
    this.subscribers = new Map(); // subId → {onData, onError, pushTypes}
    this.streamReceivers = new Map(); // streamId → {chunks, resolve, reject}
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.pingTimer = null;
    this.pingFailures = 0;
    this.keepAliveCount = 0;
    this.closedByUser = false;
    this.#resolveReady = null;
    this.#rejectReady = null;
  }

  onStateChange(listener) {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // Listener errors must not break connection state tracking.
      }
    }
  }

  /**
   * Ensure a live connection and resolve once the hello/welcome exchange
   * finished on the current socket (authenticated or explicitly needsAuth).
   */
  ready() {
    if (this.closedByUser) this.closedByUser = false;
    const live = (this.state === 'connected' || this.state === 'needsAuth') && this.readyPromise;
    if (live) return this.readyPromise;
    if (!this.socket && this.state !== 'connecting') this.#connect();
    return this.readyPromise
      || Promise.reject(connectionLostError('Agent connection failed to start'));
  }

  #connect() {
    if (!this.WebSocketImpl) {
      this.#setState('closed');
      this.readyPromise = Promise.reject(new Error('WebSocket is not available in this environment.'));
      this.readyPromise.catch(() => {});
      return;
    }
    this.generation += 1;
    const generation = this.generation;
    this.#clearReconnectTimer();
    clearTimeout(this.handshakeTimer);
    this.#setState('connecting');
    this.welcome = null;
    this.helloRequestId = `hello-${generation}`;

    this.readyPromise = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.readyPromise.catch(() => {});

    const settleReady = (fn, value) => {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      this.#resolveReady = null;
      this.#rejectReady = null;
      fn(value);
    };

    this.handshakeTimer = setTimeout(() => {
      if (this.generation !== generation) return;
      try { this.socket?.close(); } catch { /* ignore */ }
    }, HANDSHAKE_TIMEOUT_MS);

    let socket;
    try {
      socket = new this.WebSocketImpl(this.wsUrl);
    } catch (error) {
      settleReady(this.#rejectReady, connectionLostError(`Could not open agent connection: ${error.message}`));
      this.socket = null;
      this.#setState('closed');
      return;
    }
    this.socket = socket;
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('open', () => {
      if (this.generation !== generation) return;
      this.#sendRaw({ id: this.helloRequestId, type: 'hello', payload: { token: this.getToken() } });
    });

    socket.addEventListener('message', (event) => {
      if (this.generation !== generation) return;
      this.#handleMessage(event.data, generation, settleReady);
    });

    socket.addEventListener('close', (event) => {
      if (this.generation !== generation) return;
      this.socket = null;
      this.#stopPing();
      if (this.#rejectReady) {
        settleReady(this.#rejectReady, connectionLostError('Could not reach the agent server'));
      }
      // Surface why the server closed (e.g. 1009 "WebSocket frame too large")
      // instead of a bare "connection closed" that hides the real cause.
      const detail = Number(event?.code) ? ` (${event.code}${event.reason ? `: ${event.reason}` : ''})` : '';
      this.#failPending(connectionLostError(`Agent server connection closed${detail}`));
      this.#scheduleReconnect(generation);
    });

    socket.addEventListener('error', () => {
      // The close event carries the failure; only refresh state here.
      if (this.generation === generation) this.#setState('connecting');
    });
  }

  #handleMessage(data, generation, settleReady) {
    if (data instanceof ArrayBuffer) {
      this.#handleBinary(new Uint8Array(data));
      return;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      data.arrayBuffer()
        .then((buffer) => { if (this.generation === generation) this.#handleBinary(new Uint8Array(buffer)); })
        .catch(() => {});
      return;
    }
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    if (message.id === this.helloRequestId && this.#resolveReady) {
      const resolve = this.#resolveReady;
      if (message.ok) {
        this.welcome = message.data ?? {};
        this.reconnectAttempts = 0;
        if (this.welcome.authenticated) {
          this.#setState('connected');
          this.#startPing();
        } else {
          this.#setState('needsAuth');
        }
        settleReady(resolve, this.welcome);
      } else {
        settleReady(this.#rejectReady, requestError(message.error || 'Agent hello failed', message.code));
        this.#setState('closed');
      }
      return;
    }

    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.onAbortSignal?.removeEventListener('abort', entry.onAbort);
      if (message.ok) {
        // A successful connect exchange authenticates the live socket; without
        // this flip every later request would still be gated as needsAuth.
        if (entry.type === 'connect' && this.state === 'needsAuth') {
          this.welcome = { ...(this.welcome || {}), authenticated: true, needsAuth: false };
          this.#setState('connected');
          this.#startPing();
        }
        entry.resolve(message.data ?? {});
      } else {
        entry.reject(requestError(message.error || 'Agent request failed', message.code));
      }
      return;
    }

    if (message.sub !== undefined) {
      const subscriber = this.subscribers.get(message.sub);
      if (subscriber) {
        try {
          subscriber.onData(message.type, message.data);
        } catch {
          // Handler errors must not break the connection pump.
        }
      }
      return;
    }

    if (message.type === 'stream.error') {
      const streamId = Number(message.data?.streamId);
      const receiver = this.streamReceivers.get(streamId);
      if (receiver) {
        this.streamReceivers.delete(streamId);
        receiver.reject(requestError(message.data?.error || 'Stream failed', message.data?.code));
      }
      return;
    }

    if (message.type === 'bye') {
      try { this.socket?.close(); } catch { /* ignore */ }
    }
  }

  #handleBinary(bytes) {
    if (bytes.length < 5) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const streamId = view.getUint32(0);
    const final = (bytes[4] & 0x01) !== 0;
    const receiver = this.streamReceivers.get(streamId);
    if (!receiver) return;
    if (bytes.length > 5) receiver.chunks.push(bytes.subarray(5));
    if (final) {
      this.streamReceivers.delete(streamId);
      receiver.resolve(receiver.chunks);
    }
  }

  #sendRaw(value) {
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  #failPending(error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.onAbortSignal?.removeEventListener('abort', entry.onAbort);
      entry.reject(error);
      this.pending.delete(id);
    }
    for (const [, receiver] of this.streamReceivers) {
      receiver.reject(error);
    }
    this.streamReceivers.clear();
    const subscribers = [...this.subscribers.values()];
    this.subscribers.clear();
    for (const subscriber of subscribers) {
      try {
        subscriber.onError?.(error);
      } catch {
        // Subscriber error handlers must not break reconnection.
      }
    }
    this.#setState('closed');
  }

  #scheduleReconnect(generation) {
    if (this.generation !== generation) return;
    if (this.closedByUser || !this.#shouldStayConnected()) {
      this.#setState('closed');
      return;
    }
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.#setState('connecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.generation !== generation) return;
      if (this.#shouldStayConnected()) this.#connect();
      else this.#setState('closed');
    }, jitter(delay));
  }

  #shouldStayConnected() {
    return this.subscribers.size > 0 || this.pending.size > 0 || this.keepAliveCount > 0;
  }

  #clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  #startPing() {
    this.#stopPing();
    this.pingFailures = 0;
    this.pingTimer = setInterval(() => {
      if (this.state !== 'connected') return;
      this.request('ping', {}, { timeoutMs: PING_TIMEOUT_MS })
        .then(() => { this.pingFailures = 0; })
        .catch(() => {
          if (this.state !== 'connected') return;
          // A large queued frame blocks ping replies (single ordered stream);
          // while the send buffer is draining the socket is busy, not dead.
          if ((this.socket?.bufferedAmount || 0) > PING_SEND_BUFFER_BUSY_BYTES) return;
          this.pingFailures += 1;
          if (this.pingFailures >= PING_FAILURES_BEFORE_RESET) {
            // The socket is dead even though no close event arrived (common
            // after sleep/network change). Force-close to trigger reconnect.
            try { this.socket?.close(); } catch { /* ignore */ }
          }
        });
    }, PING_INTERVAL_MS);
  }

  #stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Send one request and resolve with the reply data.
   * @param {string} type
   * @param {object} [payload]
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   */
  async request(type, payload = {}, options = {}) {
    const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal } = options;
    await this.ready();
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new DOMException('Request aborted', 'AbortError');
    }
    // The server only accepts hello/connect before authentication, and caps
    // unauthenticated frames at ~1MB: a run payload with image attachments
    // sent here would get the whole socket killed with 1009 instead of a
    // usable error. Fail fast with an auth error the UI can act on.
    if (this.state === 'needsAuth' && type !== 'connect') {
      throw requestError(
        'Agent server requires authentication. Pair the server (agent token) in Settings and try again.',
        401
      );
    }
    const id = nextRequestId();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(signal.reason instanceof Error ? signal.reason : new DOMException('Request aborted', 'AbortError'));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        reject(timeoutError(`${type} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      const entry = {
        type,
        resolve,
        reject,
        timer,
        onAbort,
        onAbortSignal: signal,
      };
      this.pending.set(id, entry);
      if (!this.#sendRaw({ id, type, payload })) {
        clearTimeout(timer);
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        reject(connectionLostError(`Agent connection is not open (${type})`));
      }
    });
  }

  /**
   * Establish a push subscription. The request type establishes it; the
   * generated `sub` id is echoed by every push, so subscriptions multiplex
   * over one connection. Pushes are delivered as onData(type, data); a
   * connection loss surfaces as onError once and ends the subscription.
   *
   * @param {{
   *   request: string,
   *   payload?: object,
   *   onData: (type: string, data: any) => void,
   *   onError?: (error: Error) => void,
   *   signal?: AbortSignal,
   *   timeoutMs?: number,
   * }} spec
   * @returns {{ready: Promise<void>, unsubscribe: () => void}}
   */
  subscribe(spec) {
    const sub = nextRequestId('s');
    const { request: requestType, payload = {}, onData, onError } = spec;
    this.subscribers.set(sub, { onData, onError });
    const ready = this.request(requestType, { ...payload, sub }, { timeoutMs: spec.timeoutMs, signal: spec.signal })
      .catch((error) => {
        this.subscribers.delete(sub);
        throw error;
      });
    const unsubscribe = () => {
      this.subscribers.delete(sub);
      void this.request('unsubscribe', { sub }, { timeoutMs: 5_000 }).catch(() => {});
    };
    if (spec.signal) {
      spec.signal.addEventListener('abort', () => {
        this.subscribers.delete(sub);
      }, { once: true });
    }
    return { ready, unsubscribe };
  }

  /**
   * Register a receiver for an incoming binary stream (file download) and
   * resolve with the chunks once the final-flagged frame arrives.
   */
  receiveStream(streamId) {
    return new Promise((resolve, reject) => {
      this.streamReceivers.set(streamId, { chunks: [], resolve, reject });
    });
  }

  /** Drop a pending stream receiver (failed control request, caller abort). */
  cancelStream(streamId, reason = 'Stream cancelled') {
    const receiver = this.streamReceivers.get(streamId);
    if (!receiver) return;
    this.streamReceivers.delete(streamId);
    receiver.reject?.(connectionLostError(reason));
  }

  /**
   * Send a binary stream (file upload): chunks with the shared 5-byte header,
   * last chunk flagged final. Yields while the socket buffer is full.
   */
  async sendStream(streamId, blob, { chunkBytes = 256 * 1024, signal } = {}) {
    await this.ready();
    if (this.state === 'needsAuth') {
      throw requestError(
        'Agent server requires authentication. Pair the server (agent token) in Settings and try again.',
        401
      );
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== this.WebSocketImpl.OPEN) {
      throw connectionLostError('Agent connection is not open');
    }
    if (blob.size === 0) {
      socket.send(this.#encodeStreamFrame(streamId, new Uint8Array(0), true));
      return;
    }
    let offset = 0;
    while (offset < blob.size) {
      if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError');
      const slice = blob.slice(offset, offset + chunkBytes);
      const buffer = new Uint8Array(await slice.arrayBuffer());
      offset += buffer.byteLength;
      socket.send(this.#encodeStreamFrame(streamId, buffer, offset >= blob.size));
      // Avoid unbounded browser-side buffering between chunks.
      while (socket.readyState === this.WebSocketImpl.OPEN && socket.bufferedAmount > SEND_BUFFER_HIGH_BYTES) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (socket.readyState !== this.WebSocketImpl.OPEN) {
        throw connectionLostError('Agent connection closed during upload');
      }
    }
  }

  #encodeStreamFrame(streamId, bytes, final) {
    const frame = new Uint8Array(5 + bytes.byteLength);
    const view = new DataView(frame.buffer);
    view.setUint32(0, streamId);
    frame[4] = final ? 0x01 : 0x00;
    frame.set(bytes, 5);
    return frame;
  }

  /** Hold the connection open across idle periods (probes, UI state). */
  keepAlive(on = true) {
    this.keepAliveCount = Math.max(0, this.keepAliveCount + (on ? 1 : -1));
    if (this.keepAliveCount > 0 && (this.state === 'idle' || this.state === 'closed')) void this.ready();
    return () => this.keepAlive(false);
  }

  close() {
    this.closedByUser = true;
    this.#clearReconnectTimer();
    this.#stopPing();
    clearTimeout(this.handshakeTimer);
    this.#failPending(connectionLostError('Connection closed'));
    try { this.socket?.close(); } catch { /* ignore */ }
    this.socket = null;
    this.#setState('closed');
  }
}

const connectionRegistry = new Map();

/**
 * Get (or create) the shared connection for an agent URL. Connections are
 * keyed by the resolved WebSocket URL so the Vite-proxied loopback endpoint
 * and an explicit URL to the same server share one socket.
 * @param {string} url
 * @param {{getToken?: () => string|null}} [options]
 */
export function getAgentConnection(url, options = {}) {
  const key = resolveAgentWsUrl(url);
  let conn = connectionRegistry.get(key);
  if (!conn) {
    conn = new AgentWsConnection(url, options);
    connectionRegistry.set(key, conn);
  }
  return conn;
}

/** Drop all cached connections (tests and factory reset). */
export function resetAgentConnections() {
  for (const conn of connectionRegistry.values()) {
    try { conn.close(); } catch { /* ignore */ }
  }
  connectionRegistry.clear();
}
