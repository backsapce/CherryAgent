import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REMOTE_RUN_RECONNECT_WINDOW_MS,
  attachRemoteRunStream,
  isRemoteRunReconnectableError,
} from './remoteRunReconnect.js';

function connectionLost(message = 'Agent server connection lost') {
  const error = new Error(message);
  error.code = 'AGENT_CONNECTION_LOST';
  error.retryable = true;
  return error;
}

function requestError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * Scripted fake for subscribeRemoteAgentRun. Each element of `script` is one
 * attempt: { readyError } fails the handshake, { events, status, drop } streams
 * after a successful handshake. `drop` simulates the connection dying mid
 * stream (rejects the loop with a connection-lost error).
 */
function scriptedSubscribe(script) {
  const calls = [];
  const subscribe = (url, spec) => {
    calls.push({ url, spec, after: spec.after });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    let unsubscribed = false;
    if (step.readyError) {
      return {
        ready: Promise.reject(step.readyError),
        unsubscribe: () => { unsubscribed = true; },
      };
    }
    let onError = null;
    const ready = new Promise((resolve, reject) => {
      // Stash a reject so `drop` can simulate a mid-stream connection loss.
      onError = (error) => reject(error);
      resolve();
    });
    queueMicrotask(() => {
      if (unsubscribed) return;
      if (step.events?.length) spec.onEvents(step.events);
      if (step.status) spec.onStatus(step.status);
      if (step.drop && onError) spec.onError(connectionLost());
    });
    return {
      ready,
      unsubscribe: () => { unsubscribed = true; },
    };
  };
  subscribe.calls = calls;
  return subscribe;
}

const fastLoop = {
  baseDelayMs: 1,
  maxDelayMs: 2,
};

test('isRemoteRunReconnectableError: transport failures reconnect, definitive replies do not', () => {
  assert.equal(isRemoteRunReconnectableError(connectionLost()), true);
  const timeout = new Error('run.subscribe timed out');
  timeout.code = 'AGENT_REQUEST_TIMEOUT';
  assert.equal(isRemoteRunReconnectableError(timeout), true);
  assert.equal(isRemoteRunReconnectableError(requestError('boom', 502)), true);
  assert.equal(isRemoteRunReconnectableError(requestError('busy', 429)), true);

  assert.equal(isRemoteRunReconnectableError(requestError('Agent run not found', 404)), false);
  assert.equal(isRemoteRunReconnectableError(requestError('unauthorized', 401)), false);
  assert.equal(isRemoteRunReconnectableError(requestError('conflict', 409)), false);
  assert.equal(isRemoteRunReconnectableError(new DOMException('aborted', 'AbortError')), false);
  assert.equal(isRemoteRunReconnectableError(null), false);
});

test('attachRemoteRunStream resolves when the server reports a terminal status', async () => {
  const seenStatuses = [];
  const subscribe = scriptedSubscribe([
    { events: [{ remoteSequence: 3 }], status: { id: 'run-1', status: 'completed' } },
  ]);
  await attachRemoteRunStream({
    url: 'https://nas.example',
    runId: 'run-1',
    subscribe,
    onStatus: (snapshot) => seenStatuses.push(snapshot.status),
    ...fastLoop,
  });
  assert.deepEqual(seenStatuses, ['completed']);
  assert.equal(subscribe.calls.length, 1);
  assert.equal(subscribe.calls[0].after, 0);
});

test('attachRemoteRunStream reattaches from the last applied cursor after a connection drop', async () => {
  const notices = [];
  const receivedEvents = [];
  const subscribe = scriptedSubscribe([
    // Attempt 1: replays two events, then the connection dies mid-stream.
    { events: [{ remoteSequence: 4 }, { remoteSequence: 5 }], status: { id: 'run-1', status: 'running' }, drop: true },
    // Attempt 2: server is back; replay continues from 5 and the run finishes.
    { events: [{ remoteSequence: 6 }], status: { id: 'run-1', status: 'idle' } },
  ]);
  await attachRemoteRunStream({
    url: 'https://nas.example',
    runId: 'run-1',
    cursor: 3,
    subscribe,
    onEvents: (events) => receivedEvents.push(...events),
    onReconnect: (notice) => notices.push(notice),
    ...fastLoop,
  });
  assert.equal(subscribe.calls.length, 2);
  assert.equal(subscribe.calls[0].after, 3);
  assert.equal(subscribe.calls[1].after, 5, 'reattach resumes after the last applied event');
  assert.deepEqual(receivedEvents.map((event) => event.remoteSequence), [4, 5, 6]);
  assert.deepEqual(notices, [{ attempt: 1, sinceMs: notices[0]?.sinceMs }, null]);
  assert.ok(Number.isFinite(notices[0].sinceMs));
});

test('attachRemoteRunStream rethrows definitive server replies without retrying', async () => {
  const notices = [];
  const subscribe = scriptedSubscribe([
    { readyError: requestError('Agent run not found', 404) },
  ]);
  await assert.rejects(
    attachRemoteRunStream({
      url: 'https://nas.example',
      runId: 'run-gone',
      subscribe,
      onReconnect: (notice) => notices.push(notice),
      ...fastLoop,
    }),
    /Agent run not found/
  );
  assert.equal(subscribe.calls.length, 1, 'a 404 must not be retried');
  assert.deepEqual(notices, []);
});

test('attachRemoteRunStream keeps retrying transport failures until the window expires', async () => {
  const notices = [];
  const subscribe = scriptedSubscribe([
    { readyError: connectionLost('Could not reach the agent server') },
  ]);
  await assert.rejects(
    attachRemoteRunStream({
      url: 'https://nas.example',
      runId: 'run-1',
      subscribe,
      onReconnect: (notice) => notices.push(notice),
      windowMs: 15,
      ...fastLoop,
    }),
    /Could not reach the agent server/
  );
  assert.ok(subscribe.calls.length > 1, `expected several attempts, got ${subscribe.calls.length}`);
  // Notice raised on the first failure and cleared when the window expires.
  assert.equal(notices[notices.length - 1], null);
  assert.ok(notices.slice(0, -1).every((notice) => notice && notice.attempt >= 1));
});

test('attachRemoteRunStream stops reconnecting when the run is aborted mid-backoff', async () => {
  const controller = new AbortController();
  const subscribe = scriptedSubscribe([
    { readyError: connectionLost() },
  ]);
  const pending = attachRemoteRunStream({
    url: 'https://nas.example',
    runId: 'run-1',
    subscribe,
    signal: controller.signal,
    windowMs: REMOTE_RUN_RECONNECT_WINDOW_MS,
    baseDelayMs: 60_000,
    maxDelayMs: 60_000,
  });
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await rejection;
});

test('attachRemoteRunStream treats a dead run as a silent stop, not a reconnect', async () => {
  let alive = true;
  const subscribe = scriptedSubscribe([
    { readyError: connectionLost() },
  ]);
  const pending = attachRemoteRunStream({
    url: 'https://nas.example',
    runId: 'run-1',
    subscribe,
    isAlive: () => alive,
    windowMs: REMOTE_RUN_RECONNECT_WINDOW_MS,
    baseDelayMs: 60_000,
    maxDelayMs: 60_000,
  });
  const rejection = assert.rejects(pending, /connection lost/i);
  await new Promise((resolve) => setTimeout(resolve, 5));
  alive = false;
  await rejection;
});

test('attachRemoteRunStream keeps waiting runs subscribed across outages', async () => {
  const subscribe = scriptedSubscribe([
    // A waiting run first goes through an outage, then reports waiting again.
    { readyError: connectionLost() },
    { events: [{ remoteSequence: 2 }], status: { id: 'run-1', status: 'waiting' }, drop: true },
    { status: { id: 'run-1', status: 'waiting' }, drop: true },
    { status: { id: 'run-1', status: 'completed' } },
  ]);
  await attachRemoteRunStream({
    url: 'https://nas.example',
    runId: 'run-1',
    subscribe,
    ...fastLoop,
  });
  assert.equal(subscribe.calls.length, 4);
});
