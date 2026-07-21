/**
 * Track in-flight agent turns by session.
 *
 * The registry deliberately owns only lifecycle state. Streaming buffers,
 * remote-run metadata, and animation-frame ids live on each returned record so
 * callers can update them without sharing mutable state across conversations.
 */
export function createSessionRunRegistry({
  onChange = () => {},
  createController = () => new AbortController(),
} = {}) {
  const runs = new Map();
  const completionResolvers = new WeakMap();

  const notify = () => onChange(new Set(runs.keys()));

  const begin = (sessionId, initial = {}) => {
    const id = String(sessionId || '');
    if (!id || runs.has(id)) return null;

    let resolveCompletion;
    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    const record = {
      ...initial,
      sessionId: id,
      controller: initial.controller || createController(),
      completion,
    };
    completionResolvers.set(record, resolveCompletion);
    runs.set(id, record);
    notify();
    return record;
  };

  const finish = (sessionId, record) => {
    const id = String(sessionId || '');
    if (!record || runs.get(id) !== record) return false;
    runs.delete(id);
    completionResolvers.get(record)?.();
    completionResolvers.delete(record);
    notify();
    return true;
  };

  return {
    begin,
    finish,
    enqueueIfCurrent(sessionId, record, enqueue) {
      const id = String(sessionId || '');
      if (!record || runs.get(id) !== record) return false;
      enqueue();
      return true;
    },
    get(sessionId) {
      return runs.get(String(sessionId || '')) || null;
    },
    has(sessionId) {
      return runs.has(String(sessionId || ''));
    },
    values() {
      return [...runs.values()];
    },
    entries() {
      return [...runs.entries()];
    },
    runningSessionIds() {
      return new Set(runs.keys());
    },
    abort(sessionId) {
      const record = runs.get(String(sessionId || ''));
      record?.controller?.abort();
      return record?.completion || null;
    },
    abortAll() {
      const completions = [];
      for (const record of runs.values()) {
        record.controller?.abort();
        completions.push(record.completion);
      }
      return completions;
    },
  };
}
