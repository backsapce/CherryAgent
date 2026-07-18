/**
 * Coordinate debounced session persistence without doing any cloning work in
 * React's render/effect hot path. Writes are serialized so an older, slower
 * save can never finish after a newer save and replace its persisted baseline.
 */
export function createSessionSaveCoordinator({
  save,
  snapshot,
  checkpoint = null,
  clearCheckpoint = null,
  onCommitted = () => {},
  onError = () => {},
  delayMs = 300,
  checkpointDelayMs = delayMs,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer = null;
  let checkpointTimer = null;
  let pendingSource = null;
  let pendingCheckpoint = null;
  let queue = Promise.resolve();
  let checkpointQueue = Promise.resolve();
  let latestTask = queue;
  let nextGeneration = 0;
  let committedGeneration = 0;
  let latestSuccessful = null;
  let suspendDepth = 0;
  let hasPendingSource = false;
  let activityGeneration = 0;
  let failedAttemptGeneration = 0;
  let retryCandidate = null;

  const commitLatestSuccessful = () => {
    if (!latestSuccessful || latestSuccessful.generation <= committedGeneration) return;
    committedGeneration = latestSuccessful.generation;
    onCommitted(latestSuccessful.value, latestSuccessful.generation);
    // The caller now owns any baseline it needs. Keeping the successful value
    // here retained a full serialized snapshot of large conversations forever.
    latestSuccessful = null;
  };

  const retainRetryCandidate = (candidate) => {
    if (candidate.revision !== activityGeneration || hasPendingSource) return;
    retryCandidate = {
      ...candidate,
      failedAttemptGeneration: ++failedAttemptGeneration,
    };
  };

  const enqueueValue = (value, revision) => {
    const generation = ++nextGeneration;
    const persistValue = checkpoint || clearCheckpoint
      ? async () => {
        // A recovery checkpoint may have started while a storage barrier was
        // active. Let that isolated write finish before publishing the normal
        // session files, then clear it only after the normal save is durable
        // and only if no newer in-memory generation appeared meanwhile.
        await checkpointQueue;
        await save(value);
        if (clearCheckpoint) {
          // Clearing participates in the same journal queue as writes. If a
          // new checkpoint is requested while deletion is in flight, it chains
          // after deletion and recreates the journal instead of being erased
          // by a late clear.
          const clearTask = checkpointQueue.then(async () => {
            if (
              revision === activityGeneration
              && !hasPendingSource
              && pendingCheckpoint == null
            ) {
              await clearCheckpoint();
            }
          });
          checkpointQueue = clearTask.catch(() => {});
          await clearTask;
        }
      }
      : () => save(value);

    const task = queue
      .then(persistValue)
      .then(
        () => {
          latestSuccessful = { generation, value };
          // schedule() advances activityGeneration before the newer value is
          // snapshotted. Do not expose this write as the latest baseline when
          // a newer in-memory source is already waiting behind it.
          if (revision === activityGeneration) commitLatestSuccessful();
        },
        (error) => {
          retainRetryCandidate({ kind: 'value', revision, value });
          onError(error);
          // When the newest write fails, the last successful write is the
          // value that storage actually contains and therefore the safe base.
          if (revision === activityGeneration) commitLatestSuccessful();
          throw error;
        }
      );

    // A failed write must not poison later writes, while latestTask retains the
    // rejection so the flush that observed this attempt can report it.
    queue = task.catch(() => {});
    latestTask = task;
    return task;
  };

  const enqueueCheckpoint = (candidate) => {
    if (!checkpoint) return checkpointQueue;
    let value;
    let baseline;
    try {
      value = snapshot(candidate.source);
      baseline = snapshot(candidate.baseline || []);
    } catch (error) {
      onError(error);
      const failed = Promise.reject(error);
      failed.catch(() => {});
      return failed;
    }

    const task = checkpointQueue.then(() => checkpoint(value, baseline));
    checkpointQueue = task.catch((error) => {
      onError(error);
    });
    return task;
  };

  const cancelPendingCheckpoint = () => {
    if (checkpointTimer !== null) clearTimer(checkpointTimer);
    checkpointTimer = null;
    pendingCheckpoint = null;
  };

  const startCheckpointTimer = () => {
    if (
      !checkpoint
      || checkpointTimer !== null
      || suspendDepth <= 0
      || pendingCheckpoint == null
    ) return;
    checkpointTimer = setTimer(() => {
      checkpointTimer = null;
      const candidate = pendingCheckpoint;
      pendingCheckpoint = null;
      enqueueCheckpoint(candidate).catch(() => {});
    }, checkpointDelayMs);
  };

  const checkpointNow = (source = null, baseline = null) => {
    if (!checkpoint) return Promise.resolve();
    let candidate;
    if (source != null) {
      candidate = { source, baseline: baseline || [], revision: activityGeneration };
    } else if (pendingCheckpoint != null) {
      candidate = pendingCheckpoint;
    } else if (hasPendingSource) {
      candidate = pendingSource;
    } else {
      return checkpointQueue;
    }
    cancelPendingCheckpoint();
    return enqueueCheckpoint(candidate);
  };

  const enqueueSource = (source, revision) => {
    let value;
    try {
      value = snapshot(source);
    } catch (error) {
      retainRetryCandidate({ kind: 'source', revision, source });
      onError(error);
      if (revision === activityGeneration) commitLatestSuccessful();

      // Keep the rejected attempt observable to flush(), but attach an
      // internal handler as timer-driven snapshots have no external waiter.
      const failedTask = Promise.reject(error);
      failedTask.catch(() => {});
      latestTask = failedTask;
      return failedTask;
    }
    return enqueueValue(value, revision);
  };

  const enqueueRetry = (candidate) => {
    if (candidate.kind === 'value') {
      return enqueueValue(candidate.value, candidate.revision);
    }
    return enqueueSource(candidate.source, candidate.revision);
  };

  const cancelScheduled = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    cancelPendingCheckpoint();
    pendingSource = null;
    hasPendingSource = false;
    retryCandidate = null;
    // Invalidate failures from an in-flight snapshot that the caller has
    // explicitly discarded (for example after a storage refresh/reset).
    activityGeneration += 1;
  };

  const startTimer = () => {
    if (timer !== null || suspendDepth > 0 || !hasPendingSource) return;
    timer = setTimer(() => {
      timer = null;
      const pending = pendingSource;
      pendingSource = null;
      hasPendingSource = false;
      enqueueSource(pending.source, pending.revision).catch(() => {});
    }, delayMs);
  };

  const schedule = (source, checkpointBaseline = null) => {
    activityGeneration += 1;
    if (timer !== null) clearTimer(timer);
    timer = null;
    retryCandidate = null;
    pendingSource = {
      revision: activityGeneration,
      source,
      baseline: checkpointBaseline || [],
    };
    hasPendingSource = true;
    if (suspendDepth > 0 && checkpoint) {
      pendingCheckpoint = pendingSource;
      startCheckpointTimer();
    }
    startTimer();
  };

  const flush = async () => {
    let firstError = null;
    // Retry failures that were already known when this barrier began. A
    // failure produced by this flush remains queued for the next flush instead
    // of causing an immediate, unbounded retry loop.
    const retryCutoff = failedAttemptGeneration;

    // Keep draining until no schedule/enqueue activity occurred while the
    // previous write was in flight. The final stability check is synchronous,
    // so a caller cannot observe this promise resolving ahead of a save that
    // was scheduled before that resolution.
    while (true) {
      const observedActivity = activityGeneration;
      if (timer !== null) clearTimer(timer);
      timer = null;

      let taskToAwait = latestTask;
      if (hasPendingSource) {
        const pending = pendingSource;
        pendingSource = null;
        hasPendingSource = false;
        taskToAwait = enqueueSource(pending.source, pending.revision);
      } else if (
        retryCandidate
        && retryCandidate.failedAttemptGeneration <= retryCutoff
      ) {
        const candidate = retryCandidate;
        retryCandidate = null;
        taskToAwait = enqueueRetry(candidate);
      }

      try {
        await taskToAwait;
      } catch (error) {
        firstError ||= error;
      }

      if (
        !hasPendingSource
        && observedActivity === activityGeneration
        && taskToAwait === latestTask
      ) {
        if (firstError) throw firstError;
        return;
      }
    }
  };

  const flushCurrent = async () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    const retryCutoff = failedAttemptGeneration;

    // Capture only work that existed at the barrier boundary. Calls to
    // schedule() that arrive while this write is in flight remain pending and
    // are deliberately not persisted over files changed by the guarded
    // storage operation.
    let taskToAwait = latestTask;
    if (hasPendingSource) {
      const pending = pendingSource;
      pendingSource = null;
      hasPendingSource = false;
      taskToAwait = enqueueSource(pending.source, pending.revision);
    } else if (
      retryCandidate
      && retryCandidate.failedAttemptGeneration <= retryCutoff
    ) {
      const candidate = retryCandidate;
      retryCandidate = null;
      taskToAwait = enqueueRetry(candidate);
    }
    await taskToAwait;
  };

  const suspend = () => {
    suspendDepth += 1;
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const resume = () => {
    if (suspendDepth > 0) suspendDepth -= 1;
    if (suspendDepth === 0) cancelPendingCheckpoint();
    startTimer();
  };

  const beginBarrier = async () => {
    suspend();
    try {
      await flushCurrent();
    } catch (error) {
      resume();
      throw error;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      resume();
    };
  };

  return {
    beginBarrier,
    cancelScheduled,
    checkpoint: checkpointNow,
    flush,
    isSuspended: () => suspendDepth > 0,
    resume,
    schedule,
    suspend,
  };
}
