/**
 * Minimal RFC 6455 frame codec shared by the agent server's WebSocket
 * protocol layer. Server→client frames are unmasked; client→client masking
 * is decoded in the parser. Supports text, binary, ping/pong, and close
 * frames; fragmentation is not used by this protocol (control payloads are
 * small and binary transfers are chunked into independent frames).
 */

export const WS_OPCODE = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});

// Binary frames carry a fixed 5-byte header so file transfers can multiplex
// over one connection: [u32 streamId BE][u8 flags]. flag bit0 marks the final
// chunk of that stream.
export const WS_BINARY_HEADER_BYTES = 5;
export const WS_BINARY_FLAG_FINAL = 0x01;

export function encodeWsFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

export function sendWsFrame(socket, value) {
  if (socket.destroyed) return;
  socket.write(encodeWsFrame(WS_OPCODE.TEXT, Buffer.from(JSON.stringify(value))));
}

export function sendWsBinary(socket, streamId, chunk, flags = 0) {
  if (socket.destroyed) return false;
  const payload = Buffer.alloc(WS_BINARY_HEADER_BYTES + chunk.length);
  payload.writeUInt32BE(streamId >>> 0, 0);
  payload[WS_BINARY_HEADER_BYTES - 1] = flags & 0xff;
  chunk.copy(payload, WS_BINARY_HEADER_BYTES);
  return socket.write(encodeWsFrame(WS_OPCODE.BINARY, payload));
}

export function sendWsPing(socket) {
  if (socket.destroyed) return;
  socket.write(encodeWsFrame(WS_OPCODE.PING, Buffer.alloc(0)));
}

export function sendWsPong(socket, payload = Buffer.alloc(0)) {
  if (socket.destroyed) return;
  socket.write(encodeWsFrame(WS_OPCODE.PONG, payload));
}

export function closeWs(socket, code = 1000, reason = '') {
  if (socket.destroyed) return;
  // A close frame carries the reason in a <=123-byte payload (125 minus the
  // 2-byte status code); longer reasons must be truncated, not wrapped.
  const reasonBuffer = Buffer.from(String(reason || ''), 'utf8').subarray(0, 123);
  const payload = Buffer.alloc(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  socket.end(encodeWsFrame(WS_OPCODE.CLOSE, payload));
}

/**
 * Parse complete frames out of an accumulating buffer. Client frames must be
 * masked (RFC requirement); the mask is removed on the returned payloads.
 * Throws on frames larger than maxFrameBytes so the caller can fail the
 * connection instead of buffering without bound.
 *
 * @param {Buffer} buffer
 * @param {{maxFrameBytes?: number}} [options]
 * @returns {{frames: Array<{opcode: number, payload: Buffer}>, rest: Buffer}}
 */
export function parseWsFrames(buffer, options = {}) {
  const maxFrameBytes = options.maxFrameBytes ?? Number.POSITIVE_INFINITY;
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame too large');
      length = Number(bigLength);
      headerLength = 10;
    }

    if (length > maxFrameBytes) throw new Error('WebSocket frame too large');

    const maskLength = masked ? 4 : 0;
    const frameEnd = offset + headerLength + maskLength + length;
    if (frameEnd > buffer.length) break;

    let payload = buffer.slice(offset + headerLength + maskLength, frameEnd);
    if (masked) {
      const mask = buffer.slice(offset + headerLength, offset + headerLength + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }

    frames.push({ opcode, payload });
    offset = frameEnd;
  }

  return { frames, rest: buffer.slice(offset) };
}

/**
 * Encode a client frame (masked), used by tests to talk to the server with a
 * raw socket. The browser client uses the native WebSocket implementation.
 */
export function encodeMaskedWsFrame(opcode, payload, mask = Buffer.from([0x11, 0x22, 0x33, 0x44])) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const maskedPayload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  return Buffer.concat([header, mask, maskedPayload]);
}
