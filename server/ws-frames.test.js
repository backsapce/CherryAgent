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
