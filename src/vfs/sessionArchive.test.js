import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHUNK_MAX_MESSAGES,
  HOT_KEEP_MESSAGES,
  chunkFileName,
  fingerprintString,
  formatHotFileBody,
  mergeArchivedView,
  parseChunkFileName,
  parseHotFileBody,
  planSessionArchive,
} from './sessionArchive.js';

const msg = (index, extra = {}) => ({
  id: `m${index}`,
  role: index % 2 ? 'assistant' : 'user',
  content: `message ${index} with some 中英混合 content to give the payload weight`,
  ...extra,
});
const messages = (count, extra) => Array.from({ length: count }, (_, i) => msg(i, extra));

test('sessions at or below the hot-keep threshold never archive', () => {
  for (const count of [0, 1, 50, HOT_KEEP_MESSAGES]) {
    const plan = planSessionArchive(messages(count));
    assert.equal(plan.chunks.length, 0);
    assert.equal(plan.hotMessages.length, count);
    assert.equal(plan.archivedCount, 0);
  }
});

test('crossing the threshold seals only full chunks and keeps the recent 100 hot', () => {
  // Region = messages[0..150): chunk 0 [0,100) hits the message cap and seals;
  // the [100,150) remainder is partial and stays in the hot file (150 total).
  const plan = planSessionArchive(messages(250));
  assert.equal(plan.chunks.length, 1);
  assert.deepEqual(
    plan.chunks.map((chunk) => [chunk.start, chunk.end, chunk.count]),
    [[0, 100, 100]]
  );
  assert.equal(plan.archivedCount, 100);
  assert.equal(plan.hotMessages.length, 50 + HOT_KEEP_MESSAGES);
  // The most recent 100 messages are always inside the hot tail verbatim.
  const all = messages(250);
  assert.deepEqual(plan.hotMessages.slice(-HOT_KEEP_MESSAGES), all.slice(-HOT_KEEP_MESSAGES));
});

test('appending messages never moves an existing chunk boundary', () => {
  const before = planSessionArchive(messages(450));
  const after = planSessionArchive(messages(450 + 130));
  for (const chunk of before.chunks) {
    const again = after.chunks.find((candidate) => candidate.index === chunk.index);
    assert.ok(again, `chunk ${chunk.index} disappeared`);
    assert.equal(again.start, chunk.start);
    assert.equal(again.end, chunk.end);
    assert.equal(again.fingerprint, chunk.fingerprint);
  }
  assert.ok(after.archivedCount > before.archivedCount);
  const reassembled = [...after.chunks.flatMap((chunk) => JSON.parse(chunk.serialized)), ...after.hotMessages];
  assert.equal(reassembled.length, 450 + 130);
});

test('a huge single message becomes its own chunk instead of looping forever', () => {
  const huge = messages(102, { content: 'x'.repeat(1024) });
  huge[0] = { ...huge[0], content: 'y'.repeat(5 * 1024 * 1024) };
  const plan = planSessionArchive(huge);
  // Message 0 alone exceeds the byte cap, so chunk 0 seals with exactly it.
  assert.equal(plan.chunks[0].count, 1);
  assert.equal(plan.chunks[0].start, 0);
  assert.equal(plan.chunks[0].end, 1);
  assert.equal(plan.hotMessages.length, 102 - 1);
});

test('chunks respect the serialized byte cap', () => {
  // 130 messages of ~40KB each: byte cap splits before the message cap.
  const big = messages(130, { content: 'z'.repeat(40 * 1024) });
  const plan = planSessionArchive(big, { maxBytes: 64 * 1024 });
  assert.ok(plan.chunks.length >= 2);
  for (const chunk of plan.chunks) {
    assert.ok(chunk.serialized.length <= 64 * 1024 + 64 * 1024, 'chunk exceeded cap by more than one message');
    assert.ok(chunk.count < CHUNK_MAX_MESSAGES || chunk.serialized.length <= 64 * 1024 * 2);
  }
});

test('chunk boundaries are stable under the byte cap when messages append', () => {
  const make = (count) => messages(count, { content: 'w'.repeat(10 * 1024) });
  const before = planSessionArchive(make(250), { maxBytes: 64 * 1024 });
  const after = planSessionArchive(make(250 + 40), { maxBytes: 64 * 1024 });
  for (const chunk of before.chunks) {
    const again = after.chunks.find((candidate) => candidate.index === chunk.index);
    assert.ok(again);
    assert.equal(again.fingerprint, chunk.fingerprint);
  }
});

test('hot file body is a bare array without chunks and an envelope with them', () => {
  const bare = formatHotFileBody({ chunks: [], hotMessages: messages(3) });
  assert.deepEqual(JSON.parse(bare), JSON.parse(JSON.stringify(messages(3))));

  const plan = planSessionArchive(messages(250));
  const envelopeText = formatHotFileBody({ chunks: plan.chunks, hotMessages: plan.hotMessages });
  const envelope = JSON.parse(envelopeText);
  assert.equal(envelope.v, 1);
  assert.deepEqual(envelope.chunks.map((entry) => entry.index), [0]);
  assert.equal(envelope.chunks[0].count, 100);
  assert.equal(typeof envelope.chunks[0].fingerprint, 'string');
  assert.equal(envelope.messages.length, 150);
});

test('parseHotFileBody accepts arrays and v1 envelopes, rejects future versions', () => {
  const parsed = parseHotFileBody(JSON.parse(formatHotFileBody({
    chunks: [{ index: 0, count: 100, bytes: 12, fingerprint: 'f' }],
    hotMessages: messages(2),
  })));
  assert.equal(parsed.chunks.length, 1);
  assert.equal(parsed.hotMessages.length, 2);

  assert.deepEqual(parseHotFileBody([1, 2]), { chunks: [], hotMessages: [1, 2] });
  assert.equal(parseHotFileBody({ v: 2, chunks: [], messages: [] }), null);
  assert.equal(parseHotFileBody('nope'), null);
  assert.equal(parseHotFileBody(null), null);
  // Invalid chunk entries are dropped rather than fatal.
  const lenient = parseHotFileBody({ v: 1, chunks: [{ index: -1 }, 'junk', { index: 5, count: 1, fingerprint: 'ok' }], messages: [] });
  assert.deepEqual(lenient.chunks, [{ index: 5, count: 1, bytes: null, fingerprint: 'ok' }]);
});

test('mergeArchivedView concatenates and de-duplicates by id, preferring hot content', () => {
  const chunkA = [{ id: 'a', content: 'old a' }, { id: 'b', content: 'b' }];
  const chunkB = [{ id: 'c', content: 'c' }];
  const hot = [{ id: 'a', content: 'new a' }, { id: 'd', content: 'd' }];
  const merged = mergeArchivedView([chunkA, chunkB], hot);
  assert.deepEqual(merged.map((message) => message.id), ['a', 'b', 'c', 'd']);
  assert.equal(merged[0].content, 'new a');
  // Id-less messages pass through untouched.
  const loose = mergeArchivedView([[{ content: 'anon' }]], [{ id: 'x', content: 'x' }]);
  assert.equal(loose.length, 2);
});

test('chunk file names round-trip their index', () => {
  assert.equal(chunkFileName(0), 'c0000.json.gz');
  assert.equal(chunkFileName(42), 'c0042.json.gz');
  assert.equal(chunkFileName(10000), 'c10000.json.gz');
  assert.equal(parseChunkFileName('c0042.json.gz'), 42);
  assert.equal(parseChunkFileName('c10000.json.gz'), 10000);
  assert.equal(parseChunkFileName('c42.json.gz'), null);
  assert.equal(parseChunkFileName('c0000.json'), null);
  assert.equal(parseChunkFileName('evil.json.gz'), null);
  assert.equal(parseChunkFileName('.json.gz'), null);
});

test('fingerprintString is stable and length-sensitive', () => {
  assert.equal(fingerprintString('abc'), fingerprintString('abc'));
  assert.notEqual(fingerprintString('abc'), fingerprintString('abcd'));
  assert.notEqual(fingerprintString('abc'), fingerprintString('acb'));
});

test('planned chunks serialize to exactly their message slice', () => {
  const all = messages(250);
  const plan = planSessionArchive(all);
  for (const chunk of plan.chunks) {
    assert.deepEqual(JSON.parse(chunk.serialized), all.slice(chunk.start, chunk.end));
  }
  assert.deepEqual(plan.hotMessages, all.slice(plan.archivedCount));
});
