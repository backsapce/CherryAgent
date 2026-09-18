import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WS_BINARY_FLAG_FINAL,
  WS_OPCODE,
  closeWs,
  encodeMaskedWsFrame,
  encodeWsFrame,
  parseWsFrames,
  sendWsBinary,
  sendWsFrame,
} from './ws-frames.js';

class FakeSocket {
  constructor() {
    this.written = [];
    this.destroyed = false;
  }
  write(chunk) {
    if (this.destroyed) return false;
    this.written.push(Buffer.from(chunk));
    return true;
  }
  end(chunk) {
    if (chunk) this.written.push(Buffer.from(chunk));
    this.destroyed = true;
  }
}

function decodeAll(socket) {
  return parseWsFrames(Buffer.concat(socket.written)).frames;
}

test('text frames round-trip through sendWsFrame and parseWsFrames', () => {
  const socket = new FakeSocket();
  sendWsFrame(socket, { type: 'hello', payload: { token: 'abc' } });
  const frames = decodeAll(socket);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, WS_OPCODE.TEXT);
  assert.deepEqual(JSON.parse(frames[0].payload.toString('utf8')), { type: 'hello', payload: { token: 'abc' } });
});

test('masked client frames are unmasked by the parser', () => {
  const payload = Buffer.from(JSON.stringify({ cmd: 'echo hi' }));
  const masked = encodeMaskedWsFrame(WS_OPCODE.TEXT, payload, Buffer.from([0x0a, 0x0b, 0x0c, 0x0d]));
  const { frames } = parseWsFrames(masked);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.toString('utf8'), payload.toString('utf8'));
});

test('binary frames carry the stream header and final flag', () => {
  const socket = new FakeSocket();
  sendWsBinary(socket, 42, Buffer.from('chunk'), WS_BINARY_FLAG_FINAL);
  const frames = decodeAll(socket);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, WS_OPCODE.BINARY);
  assert.equal(frames[0].payload.readUInt32BE(0), 42);
  assert.equal(frames[0].payload[4] & WS_BINARY_FLAG_FINAL, WS_BINARY_FLAG_FINAL);
  assert.equal(frames[0].payload.slice(5).toString('utf8'), 'chunk');
});

test('closeWs emits a close frame with the status code', () => {
  const socket = new FakeSocket();
  closeWs(socket, 1008, 'nope');
  const frames = decodeAll(socket);
  assert.equal(frames[0].opcode, WS_OPCODE.CLOSE);
  assert.equal(frames[0].payload.readUInt16BE(0), 1008);
  assert.ok(frames[0].payload.slice(2).toString('utf8').includes('nope'));
});

test('closeWs truncates reasons to the protocol limit', () => {
  const socket = new FakeSocket();
  closeWs(socket, 1011, 'x'.repeat(300));
  const frames = decodeAll(socket);
  assert.ok(frames[0].payload.length <= 127);
});

test('parseWsFrames rejects frames above maxFrameBytes', () => {
  const big = encodeWsFrame(WS_OPCODE.TEXT, Buffer.alloc(64 * 1024));
  assert.throws(() => parseWsFrames(big, { maxFrameBytes: 1024 }), /too large/);
});

test('parseWsFrames returns incomplete trailing bytes as rest', () => {
  const frame = encodeWsFrame(WS_OPCODE.TEXT, Buffer.from('{"a":12345}'));
  const partial = Buffer.concat([frame, frame.slice(0, 5)]);
  const { frames, rest } = parseWsFrames(partial);
  assert.equal(frames.length, 1);
  assert.equal(rest.length, 5);
});

test('extended-length frames round-trip', () => {
  const payload = Buffer.alloc(70_000, 0x61);
  const encoded = encodeWsFrame(WS_OPCODE.BINARY, payload);
  const { frames } = parseWsFrames(encoded);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.length, payload.length);
});

/** Masked client→server fragment with an explicit FIN bit (RFC 6455 §5.4). */
function encodeMaskedFragment(opcode, payload, fin, mask = Buffer.from([0x01, 0x02, 0x03, 0x04])) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0x00) | opcode, 0x80 | length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0x00) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0x00) | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const maskedPayload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  return Buffer.concat([header, mask, maskedPayload]);
}

function fragmentedText(payload, { fragmentBytes = 4, masks } = {}) {
  const parts = [];
  let offset = 0;
  let first = true;
  while (offset < payload.length) {
    const end = Math.min(offset + fragmentBytes, payload.length);
    const fin = end >= payload.length;
    const opcode = first ? WS_OPCODE.TEXT : WS_OPCODE.CONTINUATION;
    // Distinct masks per fragment: each frame carries its own mask key.
    const mask = masks?.[parts.length] || Buffer.from([0x10 + parts.length, 0x21, 0x32, 0x43]);
    parts.push(encodeMaskedFragment(opcode, payload.slice(offset, end), fin, mask));
    offset = end;
    first = false;
  }
  return parts;
}

test('a fragmented text message reassembles into one frame', () => {
  const payload = Buffer.from(JSON.stringify({ type: 'run.start', images: [{ dataUrl: 'x'.repeat(50) }] }));
  const parts = fragmentedText(payload, { fragmentBytes: 16 });
  assert.ok(parts.length >= 3, 'expected multiple fragments');
  const assembly = { pending: null };
  const received = [];
  let rest = Buffer.alloc(0);
  for (const part of parts) {
    const parsed = parseWsFrames(Buffer.concat([rest, part]), { assembly });
    received.push(...parsed.frames);
    rest = parsed.rest;
  }
  assert.equal(rest.length, 0);
  assert.equal(received.length, 1);
  assert.equal(received[0].opcode, WS_OPCODE.TEXT);
  assert.deepEqual(JSON.parse(received[0].payload.toString('utf8')), JSON.parse(payload.toString('utf8')));
});

test('control frames interleaved between fragments pass through immediately', () => {
  const payload = Buffer.from('abcdefgh');
  const parts = fragmentedText(payload, { fragmentBytes: 3 });
  const pong = encodeMaskedFragment(WS_OPCODE.PONG, Buffer.alloc(0), true);
  const assembly = { pending: null };
  const first = parseWsFrames(parts[0], { assembly });
  assert.equal(first.frames.length, 0, 'first fragment emits nothing on its own');
  const middle = parseWsFrames(Buffer.concat([pong, parts[1]]), { assembly });
  assert.equal(middle.frames.length, 1);
  assert.equal(middle.frames[0].opcode, WS_OPCODE.PONG);
  const last = parseWsFrames(parts[2], { assembly });
  assert.equal(last.frames.length, 1);
  assert.equal(last.frames[0].opcode, WS_OPCODE.TEXT);
  assert.equal(last.frames[0].payload.toString('utf8'), 'abcdefgh');
});

test('maxFrameBytes caps the reassembled message, not only each fragment', () => {
  const payload = Buffer.alloc(64, 0x61);
  const parts = fragmentedText(payload, { fragmentBytes: 16 });
  const assembly = { pending: null };
  parseWsFrames(parts[0], { assembly, maxFrameBytes: 32 });
  parseWsFrames(parts[1], { assembly, maxFrameBytes: 32 });
  assert.throws(() => parseWsFrames(parts[2], { assembly, maxFrameBytes: 32 }), /too large/);
});

test('continuation without a fragmented message is a protocol error', () => {
  const stray = encodeMaskedFragment(WS_OPCODE.CONTINUATION, Buffer.from('nope'), true);
  assert.throws(() => parseWsFrames(stray), /continuation frame without/);
});

test('a new data frame during a fragmented message is a protocol error', () => {
  const payload = Buffer.from('abcdefgh');
  const parts = fragmentedText(payload, { fragmentBytes: 3 });
  const assembly = { pending: null };
  parseWsFrames(parts[0], { assembly });
  const interloper = encodeMaskedFragment(WS_OPCODE.TEXT, Buffer.from('new message'), true);
  assert.throws(() => parseWsFrames(interloper, { assembly }), /during a fragmented message/);
});

test('a fragmented binary message reassembles with its opcode preserved', () => {
  const payload = Buffer.alloc(10, 0xff);
  const parts = [
    encodeMaskedFragment(WS_OPCODE.BINARY, payload.slice(0, 4), false),
    encodeMaskedFragment(WS_OPCODE.CONTINUATION, payload.slice(4), true, Buffer.from([9, 9, 9, 9])),
  ];
  const assembly = { pending: null };
  const { frames } = parseWsFrames(Buffer.concat(parts), { assembly });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, WS_OPCODE.BINARY);
  assert.deepEqual([...frames[0].payload], [...payload]);
});
