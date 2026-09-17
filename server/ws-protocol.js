/**
 * WebSocket protocol core for the agent server.
 *
 * One multiplexed connection per client carries every interaction: auth,
 * command execution, background jobs, durable agent runs, file transfers, and
 * web proxies. Messages are JSON text frames with a request/reply envelope
 * (correlated by `id`) plus server-initiated pushes addressed to a
 * subscription id:
 *
 *   client → server:  { id, type, payload }
 *   server → client:  { id, ok: true, data } | { id, ok: false, error, code }
 *   server → client:  { type, sub, data }              (push, no id)
 *
 * Binary frames multiplex file transfers with a 5-byte stream header (see
 * ws-frames.js). Auth happens on the first `hello` message; an unauthenticated
 * connection may only exchange hello/connect and is closed after a bounded
 * idle window. The upgrade-time Origin allowlist (enforced by the caller) plus
 * the token are the CSRF/trust boundary.
 */

import { randomUUID } from 'node:crypto';
import {
  WS_BINARY_FLAG_FINAL,
  WS_BINARY_HEADER_BYTES,
  WS_OPCODE,
  closeWs,
  parseWsFrames,
  sendWsBinary,
  sendWsFrame,
  sendWsPing,
  sendWsPong,
} from './ws-frames.js';

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
// Authenticated connections may push very large control payloads (a durable
// run start carries the full conversation). A token holder can already run
// arbitrary shell, so the large caps add no new trust; the small caps keep
// unauthenticated sockets cheap to attack.
const DEFAULT_AUTHED_MAX_FRAME_BYTES = 132 * 1024 * 1024;
const DEFAULT_AUTHED_MAX_BUFFER_BYTES = 136 * 1024 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
// A connection with no pong and no data for this long is presumed dead (the
// browser auto-pongs server pings; two missed intervals cover timer jitter).
const DEFAULT_HEARTBEAT_DEAD_MS = 60_000;
const DEFAULT_UNAUTH_IDLE_MS = 60_000;
// Requests are small control messages; a client flooding the socket with more
// than this many concurrent requests is misbehaving, not busy.
const DEFAULT_MAX_INFLIGHT_REQUESTS = 128;
const DEFAULT_MAX_UPLOAD_STREAMS = 4;
// Pause binary pushes when the socket write buffer grows past this; resume on
// drain. Keeps one slow client from ballooning server memory.
const DEFAULT_BACKPRESSURE_BYTES = 4 * 1024 * 1024;

function errorWithCode(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/**
 * @param {{
 *   authDisabled?: boolean,
 *   isValidToken?: (token: string) => boolean,
 *   exchangeTempToken?: (tempToken: string, conn: object) => string | null,
 *   capabilities?: (conn: object) => object,
 *   rateLimit?: (key: string, max: number, windowMs: number) => boolean,
 *   handlers?: Record<string, (payload: object, ctx: object) => Promise<any> | any>,
 *   onConnectionClosed?: (conn: object) => void,
 *   legacyFirstMessage?: (socket: import('node:net').Socket, message: object) => boolean,
 *   maxFrameBytes?: number, maxBufferBytes?: number,
 *   authedMaxFrameBytes?: number, authedMaxBufferBytes?: number,
 *   heartbeatIntervalMs?: number, heartbeatDeadMs?: number,
 *   unauthIdleMs?: number, maxInflightRequests?: number,
 *   maxUploadStreams?: number, backpressureBytes?: number,
 *   log?: (...args: any[]) => void,
 * }} options
 */
export function createAgentWsServer(options = {}) {
  const {
    authDisabled = false,
    isValidToken = () => false,
    exchangeTempToken = () => null,
    capabilities = () => ({}),
    rateLimit = () => false,
    handlers = {},
    onConnectionClosed = () => {},
    legacyFirstMessage = null,
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
    authedMaxFrameBytes = DEFAULT_AUTHED_MAX_FRAME_BYTES,
    authedMaxBufferBytes = DEFAULT_AUTHED_MAX_BUFFER_BYTES,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    heartbeatDeadMs = DEFAULT_HEARTBEAT_DEAD_MS,
    unauthIdleMs = DEFAULT_UNAUTH_IDLE_MS,
    maxInflightRequests = DEFAULT_MAX_INFLIGHT_REQUESTS,
    maxUploadStreams = DEFAULT_MAX_UPLOAD_STREAMS,
    backpressureBytes = DEFAULT_BACKPRESSURE_BYTES,
    log = () => {},
  } = options;

  const connections = new Set();

  const domainHandlers = new Map(Object.entries(handlers));

  function reply(conn, id, data) {
    if (id == null || conn.socket.destroyed) return;
    sendWsFrame(conn.socket, { id, ok: true, data });
  }

  function replyError(conn, id, error) {
    if (id == null || conn.socket.destroyed) return;
    sendWsFrame(conn.socket, {
      id,
      ok: false,
      error: error?.message || String(error || 'Request failed'),
      // Numeric codes win; legacy statusCode (run manager) is honored; plain
      // fs/platform errors (string codes) map to 500.
      code: Number.isFinite(Number(error?.code))
        ? Number(error.code)
        : (Number(error?.statusCode) || 500),
    });
  }

  function push(conn, type, sub, data) {
    if (conn.socket.destroyed || sub == null) return;
    sendWsFrame(conn.socket, { type, sub, data });
  }

  async function routeMessage(conn, envelope) {
    const { id, type } = envelope;
    const payload = envelope.payload;
    if (payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload))) {
      replyError(conn, id, errorWithCode('Request payload must be an object.', 400));
      return;
    }
    if (typeof type !== 'string' || !type) {
      replyError(conn, id, errorWithCode('Missing message "type".', 400));
      return;
    }
    if (!conn.authed && type !== 'hello' && type !== 'connect') {
      replyError(conn, id, errorWithCode('Unauthorized.', 401));
      return;
    }
    const handler = type === 'hello'
      ? handleHello
      : type === 'connect'
        ? handleConnect
        : type === 'unsubscribe'
          ? handleUnsubscribe
          : domainHandlers.get(type);
    if (!handler) {
      replyError(conn, id, errorWithCode(`Unknown message type: ${type}`, 400));
      return;
    }
    if (conn.inflightRequests >= maxInflightRequests) {
      replyError(conn, id, errorWithCode('Too many concurrent requests.', 429));
      return;
    }
    conn.inflightRequests += 1;
    try {
      const data = await handler(payload ?? {}, conn);
      reply(conn, id, data ?? {});
    } catch (error) {
      replyError(conn, id, error);
    } finally {
      conn.inflightRequests -= 1;
    }
  }

  function handleHello(payload, conn) {
    const token = payload?.token;
    if (!conn.authed) {
      conn.authed = authDisabled || (typeof token === 'string' && isValidToken(token));
    }
    if (conn.authed) {
      conn.clearUnauthTimer();
    } else {
      conn.armUnauthTimer();
    }
    return {
      authenticated: conn.authed,
      authRequired: !authDisabled,
      needsAuth: !conn.authed,
      capabilities: capabilities(conn),
    };
  }

  function handleUnsubscribe(payload, conn) {
    const sub = payload?.sub;
    if (typeof sub !== 'string') {
      throw errorWithCode('Missing or invalid "sub" field.', 400);
    }
    const disposed = conn.removeSubscription(sub);
    return { unsubscribed: disposed };
  }

  function handleConnect(payload, conn) {
    if (conn.authed) return { alreadyAuthenticated: true };
    if (rateLimit(`connect:${conn.ip}`, 5, 60_000)) {
      throw errorWithCode('Too many connect attempts. Try again later.', 429);
    }
    const tempToken = payload?.token;
    if (!tempToken || typeof tempToken !== 'string') {
      throw errorWithCode('Missing or invalid "token" field.', 400);
    }
    const longLivedToken = exchangeTempToken(tempToken, conn);
    if (!longLivedToken) {
      throw errorWithCode('Invalid token. Check the server console for the correct token.', 403);
    }
    conn.authed = true;
    conn.clearUnauthTimer();
    log('Client authenticated successfully.');
    return { token: longLivedToken };
  }

  function handleBinaryFrame(conn, payload) {
    if (payload.length < WS_BINARY_HEADER_BYTES) {
      conn.close(1008, 'Malformed binary frame');
      return;
    }
    const streamId = payload.readUInt32BE(0);
    const flags = payload[WS_BINARY_HEADER_BYTES - 1];
    const final = (flags & WS_BINARY_FLAG_FINAL) !== 0;
    const sink = conn.uploadStreams.get(streamId);
    if (!sink) return; // Unknown or already-finished stream: drop the chunk.
    if (final) conn.uploadStreams.delete(streamId);
    const chunk = payload.slice(WS_BINARY_HEADER_BYTES);
    try {
      sink.onData(chunk, { final });
    } catch (error) {
      sink.onError?.(error);
    }
  }

  function createConnection(socket, ip) {
    const conn = {
      id: randomUUID(),
      socket,
      ip: ip || 'unknown',
      authed: false,
      subscriptions: new Map(), // subId → dispose callback
      inflightRequests: 0,
      uploadStreams: new Map(),
      pendingBuffer: Buffer.alloc(0),
      firstMessageSeen: false,
      lastActivityAt: Date.now(),
      unauthTimer: null,
      heartbeatTimer: null,
      closed: false,

      /**
       * Register the dispose callback for a push subscription established by
       * a domain handler. It runs on `unsubscribe`, on connection close, and
       * on replacement (the protocol never keeps two owners for one sub).
       */
      addSubscription(sub, dispose) {
        if (typeof sub !== 'string' || !sub) {
          throw errorWithCode('Subscription id must be a non-empty string.', 400);
        }
        const existing = conn.subscriptions.get(sub);
        conn.subscriptions.set(sub, dispose);
        if (existing) {
          try { existing(); } catch { /* dispose errors must not break routing */ }
        }
      },
      removeSubscription(sub) {
        const dispose = conn.subscriptions.get(sub);
        if (!dispose) return false;
        conn.subscriptions.delete(sub);
        try { dispose(); } catch { /* ignore */ }
        return true;
      },

      send(type, sub, data) {
        push(conn, type, sub, data);
      },
      /** Out-of-band notice (no subscription id), e.g. stream errors. */
      notify(type, data) {
        if (!conn.socket.destroyed) sendWsFrame(conn.socket, { type, data });
      },
      sendBinary(streamId, chunk, final = false) {
        return sendWsBinary(socket, streamId, chunk, final ? WS_BINARY_FLAG_FINAL : 0);
      },
      waitDrain() {
        if (socket.writableLength <= backpressureBytes) return Promise.resolve();
        return new Promise((resolve) => {
          const onDrain = () => {
            socket.removeListener('drain', onDrain);
            socket.removeListener('close', onDrain);
            socket.removeListener('error', onDrain);
            resolve();
          };
          socket.once('drain', onDrain);
          socket.once('close', onDrain);
          socket.once('error', onDrain);
        });
      },
      registerUpload(streamId, sink) {
        if (conn.uploadStreams.size >= maxUploadStreams) {
          throw errorWithCode('Too many concurrent uploads.', 429);
        }
        conn.uploadStreams.set(streamId, sink);
      },
      finishUpload(streamId) {
        conn.uploadStreams.delete(streamId);
      },
      close(code = 1000, reason = '') {
        if (conn.closed) return;
        conn.closed = true;
        closeWs(socket, code, reason);
        socket.destroy();
      },

      clearUnauthTimer() {
        if (conn.unauthTimer) {
          clearTimeout(conn.unauthTimer);
          conn.unauthTimer = null;
        }
      },
      armUnauthTimer() {
        conn.clearUnauthTimer();
        conn.unauthTimer = setTimeout(() => {
          conn.close(1000, 'Unauthenticated connection idle');
        }, unauthIdleMs);
        conn.unauthTimer.unref?.();
      },
    };

    conn.heartbeatTimer = setInterval(() => {
      if (socket.destroyed) return;
      if (Date.now() - conn.lastActivityAt > heartbeatDeadMs) {
        log('Closing dead WebSocket connection', conn.ip);
        conn.close(1001, 'Heartbeat timeout');
        return;
      }
      sendWsPing(socket);
    }, heartbeatIntervalMs);
    conn.heartbeatTimer.unref?.();

    const cleanup = () => {
      if (conn.cleaned) return;
      conn.cleaned = true;
      conn.clearUnauthTimer();
      if (conn.heartbeatTimer) clearInterval(conn.heartbeatTimer);
      for (const sink of conn.uploadStreams.values()) {
        sink.onError?.(errorWithCode('Connection closed during upload.', 1006));
      }
      conn.uploadStreams.clear();
      for (const dispose of conn.subscriptions.values()) {
        try { dispose(); } catch { /* ignore */ }
      }
      conn.subscriptions.clear();
      connections.delete(conn);
      if (!conn.delegated) onConnectionClosed(conn);
    };

    const onData = (chunk) => {
      conn.lastActivityAt = Date.now();
      if (conn.closed || socket.destroyed) return;
      const frameCap = conn.authed ? authedMaxFrameBytes : maxFrameBytes;
      const bufferCap = conn.authed ? authedMaxBufferBytes : maxBufferBytes;
      conn.pendingBuffer = Buffer.concat([conn.pendingBuffer, chunk]);
      if (conn.pendingBuffer.length > bufferCap) {
        conn.close(1009, 'WebSocket message too large');
        return;
      }
      let parsed;
      try {
        parsed = parseWsFrames(conn.pendingBuffer, { maxFrameBytes: frameCap });
      } catch (error) {
        conn.close(1009, error.message);
        return;
      }
      conn.pendingBuffer = parsed.rest;

      for (const frame of parsed.frames) {
        switch (frame.opcode) {
          case WS_OPCODE.PONG:
            break; // lastActivityAt already refreshed above.
          case WS_OPCODE.PING:
            sendWsPong(socket, frame.payload);
            break;
          case WS_OPCODE.CLOSE:
            closeWs(socket, 1000);
            socket.destroy();
            return;
          case WS_OPCODE.BINARY:
            handleBinaryFrame(conn, frame.payload);
            break;
          case WS_OPCODE.TEXT: {
            let message;
            try {
              message = JSON.parse(frame.payload.toString('utf8'));
            } catch {
              conn.close(1008, 'Invalid JSON message');
              return;
            }
            if (!message || typeof message !== 'object' || Array.isArray(message)) {
              conn.close(1008, 'Message must be an object');
              return;
            }
            if (!conn.firstMessageSeen) {
              conn.firstMessageSeen = true;
              // Transitional bridge: the pre-protocol client sends
              // { cmd, token } as its first (and only) message. Hand the
              // whole socket to the legacy one-command handler.
              if (legacyFirstMessage && message.type === undefined && message.cmd !== undefined) {
                socket.removeListener('data', onData);
                cleanupConnectionTracking(conn);
                legacyFirstMessage(socket, message);
                return;
              }
            }
            void routeMessage(conn, message);
            break;
          }
          default:
            break; // Continuation frames are not used by this protocol.
        }
      }
    };

    socket.on('data', onData);

    socket.on('close', cleanup);
    socket.on('error', (error) => {
      log('WebSocket connection error:', error.message);
      cleanup();
    });

    function cleanupConnectionTracking(target) {
      // The legacy handler owns the socket lifecycle now; stop protocol-level
      // timers and skip the protocol-level close notification for it.
      target.delegated = true;
      target.clearUnauthTimer();
      if (target.heartbeatTimer) clearInterval(target.heartbeatTimer);
      connections.delete(target);
    }

    connections.add(conn);
    return conn;
  }

  return {
    connections,
    handleUpgrade(socket, ip) {
      socket.setNoDelay(true);
      return createConnection(socket, ip);
    },
    registerHandler(type, handler) {
      domainHandlers.set(type, handler);
    },
    pushTo(conn, type, sub, data) {
      push(conn, type, sub, data);
    },
  };
}
