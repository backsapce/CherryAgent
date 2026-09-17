/**
 * Durable-run WebSocket handlers: start, incremental continue, state replay,
 * live event subscription, listing, and cancellation. Thin wrappers over the
 * run manager; the ndjson event log and remoteSequence cursor remain the
 * source of truth for reconnect/replay.
 */

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * @param {{runManager: object}} deps
 */
export function createRunHandlers({ runManager }) {
  return {
    'run.start': (payload) => runManager.start(payload),
    'run.continue': (payload) => runManager.continue(payload),
    'run.state': (payload) => {
      const run = runManager.get(String(payload?.runId || ''), Math.max(0, Number(payload?.after) || 0));
      if (!run) throw errorWithCode('Agent run not found', 404);
      return run;
    },
    'run.list': (payload) => ({ runs: runManager.list(payload?.sessionId || null) }),
    'run.cancel': async (payload) => {
      const run = await runManager.abort(String(payload?.runId || ''));
      if (!run) throw errorWithCode('Agent run not found', 404);
      return run;
    },
    'run.subscribe': (payload, conn) => {
      const { sub, runId, after } = payload;
      if (!runId || typeof runId !== 'string') {
        throw errorWithCode('Missing or invalid "runId" field.', 400);
      }
      const unsubscribe = runManager.subscribe(runId, Math.max(0, Number(after) || 0), (notification) => {
        if (notification.events) {
          conn.send('run.events', sub, { events: notification.events });
        } else if (notification.run) {
          conn.send('run.status', sub, notification.run);
        }
      });
      if (!unsubscribe) throw errorWithCode('Agent run not found', 404);
      conn.addSubscription(sub, unsubscribe);
      return { subscribed: true };
    },
  };
}
