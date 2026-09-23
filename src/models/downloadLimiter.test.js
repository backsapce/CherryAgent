import assert from 'node:assert/strict';
import test from 'node:test';
import { createDownloadLimiter } from './downloadLimiter.js';

test('runs at most maxConcurrent downloads and starts waiters FIFO', async () => {
  const limiter = createDownloadLimiter(2);
  const events = [];

  const run = async (id) => {
    await limiter.acquire();
    try {
      events.push(`start-${id}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push(`end-${id}`);
    } finally {
      limiter.release();
    }
  };

  await Promise.all([run(1), run(2), run(3), run(4)]);

  assert.deepEqual(events.slice(0, 2), ['start-1', 'start-2']);
  assert.ok(events.indexOf('start-3') > Math.min(events.indexOf('end-1'), events.indexOf('end-2')));
  assert.ok(events.indexOf('start-4') > Math.min(events.indexOf('end-1'), events.indexOf('end-2')));
  // At no prefix do more than 2 downloads overlap.
  let overlap = 0;
  let maxOverlap = 0;
  for (const event of events) {
    overlap += event.startsWith('start') ? 1 : -1;
    maxOverlap = Math.max(maxOverlap, overlap);
  }
  assert.equal(maxOverlap, 2);
  assert.equal(limiter.active, 0);
  assert.equal(limiter.queued, 0);
});

test('aborting a queued waiter rejects it without consuming a slot', async () => {
  const limiter = createDownloadLimiter(1);
  await limiter.acquire();
  const controller = new AbortController();
  const queued = limiter.acquire(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(limiter.queued, 1);

  controller.abort();
  await assert.rejects(queued, (error) => error.name === 'AbortError');
  assert.equal(limiter.queued, 0);

  // The freed-by-nothing release must not hand a slot to the aborted waiter.
  limiter.release();
  assert.equal(limiter.active, 0);
  await limiter.acquire(); // slot available again immediately
  limiter.release();
});

test('an already-aborted signal rejects acquire without touching the counters', async () => {
  const limiter = createDownloadLimiter(2);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(limiter.acquire(controller.signal), (error) => error.name === 'AbortError');
  assert.equal(limiter.active, 0);
  assert.equal(limiter.queued, 0);
});

test('release past zero stays clamped', () => {
  const limiter = createDownloadLimiter(2);
  limiter.release();
  limiter.release();
  assert.equal(limiter.active, 0);
});
