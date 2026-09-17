#!/usr/bin/env node
/**
 * WebSocket protocol health check for deploy tooling and ops probes.
 *
 * The agent server no longer exposes an HTTP API: everything (including
 * health capabilities) rides the multiplexed WebSocket at /agent/ws. This
 * probe performs the raw handshake plus a `hello` exchange over a plain
 * net socket, so it works on any Node version without a WebSocket global.
 *
 * Usage:
 *   AGENT_PORT=3099 MIN_AGENT_RUN_PROTOCOL=4 node server/ws-healthcheck.js
 *   node server/ws-healthcheck.js 3099
 *
 * Exits 0 and prints the welcome capabilities on success; exits 1 with a
 * diagnostic on any failure.
 */

import { createConnection } from 'node:net';
import { encodeMaskedWsFrame, parseWsFrames, WS_OPCODE } from './ws-frames.js';

const port = Number(process.argv[2]) || Number(process.env.AGENT_PORT) || 3099;
const requiredProtocol = Number(process.env.MIN_AGENT_RUN_PROTOCOL) || 4;
const HELLO_ID = 'healthcheck';

const fail = (message) => {
  console.error(`[ws-healthcheck] ${message}`);
  process.exit(1);
};

const socket = createConnection({ host: '127.0.0.1', port }, () => {
  socket.write(
    'GET /agent/ws HTTP/1.1\r\n'
    + `Host: 127.0.0.1:${port}\r\n`
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Key: ${Buffer.from(Math.random().toString(36)).toString('base64')}\r\n`
    + 'Sec-WebSocket-Version: 13\r\n'
    + '\r\n'
  );
});

const timer = setTimeout(() => fail(`timed out talking to 127.0.0.1:${port}`), 10_000);
timer.unref?.();

let buffer = Buffer.alloc(0);
let upgraded = false;
let answered = false;

socket.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (!upgraded) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const statusLine = buffer.slice(0, headerEnd).toString('utf8').split('\r\n')[0];
    if (!/\s101\s/.test(statusLine)) {
      fail(`expected 101 Switching Protocols, got: ${statusLine}`);
    }
    buffer = buffer.slice(headerEnd + 4);
    upgraded = true;
    socket.write(encodeMaskedWsFrame(
      WS_OPCODE.TEXT,
      Buffer.from(JSON.stringify({ id: HELLO_ID, type: 'hello', payload: {} }))
    ));
  }

  let parsed;
  try {
    parsed = parseWsFrames(buffer);
  } catch (error) {
    fail(`frame error: ${error.message}`);
  }
  buffer = parsed.rest;
  for (const frame of parsed.frames) {
    if (frame.opcode !== WS_OPCODE.TEXT) continue;
    let message;
    try {
      message = JSON.parse(frame.payload.toString('utf8'));
    } catch {
      continue;
    }
    if (message.id !== HELLO_ID) continue;
    answered = true;
    clearTimeout(timer);
    socket.destroy();
    if (!message.ok) {
      fail(`hello rejected: ${message.error || 'unknown error'}`);
    }
    const capabilities = message.data?.capabilities || {};
    const protocol = Number(capabilities.agentRunProtocol) || 0;
    const wsProtocol = Number(capabilities.wsProtocol) || 0;
    if (protocol < requiredProtocol) {
      fail(`agentRunProtocol ${requiredProtocol} required, received ${protocol || 'missing'}`);
    }
    if (wsProtocol < 1) {
      fail(`wsProtocol 1 required, received ${wsProtocol || 'missing'}`);
    }
    console.log(`ok agentRunProtocol=${protocol} wsProtocol=${wsProtocol} needsAuth=${!!message.data.needsAuth}`);
    process.exit(0);
  }
});

socket.on('error', (error) => fail(error.message));
socket.on('close', () => {
  if (!answered) fail('connection closed before the hello reply');
});
