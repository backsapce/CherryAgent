const CONFIRMED_REMOTE_FAILURE_STATUSES = new Set([
  'aborted',
  'error',
  'interrupted',
]);

const REMOTE_RUN_STATUSES = new Set([
  'aborted',
  'completed',
  'error',
  'interrupted',
  'running',
  'waiting',
]);

const SLOW_REMOTE_RETRY_STATUSES = new Set([
  400,
  401,
  403,
  404,
  405,
  410,
  413,
  422,
  429,
]);

function assistantPlaceholder(replyId) {
  return {
    id: replyId,
    role: 'assistant',
    content: '',
    thinking: '',
    toolCalls: [],
    transcript: [],
  };
}

/**
 * Update one assistant reply without confusing a lazily-unloaded conversation
 * with an intentionally empty one.
 *
 * A sandbox wake-up can resume while the session is metadata-only in React.
 * In that case `fallbackMessages` is the body just loaded from OPFS. Always
 * upsert the reply as well: the browser may have closed before its original
 * placeholder was durably saved.
 */
export function upsertSessionReply(currentMessages, fallbackMessages, replyId, fields = null) {
  const source = Array.isArray(currentMessages)
    ? currentMessages
    : (Array.isArray(fallbackMessages) ? fallbackMessages : []);
  let found = false;
  const messages = source.map((message) => {
    if (message?.id !== replyId) return message;
    found = true;
    return fields ? { ...message, ...fields } : message;
  });

  if (found) return messages;
  return [
    ...messages,
    {
      ...assistantPlaceholder(replyId),
      ...(fields || {}),
    },
  ];
}

export function findSessionReply(messages, replyId) {
  return Array.isArray(messages)
    ? messages.find((message) => message?.id === replyId) || null
    : null;
}

export function finishReplyRunTiming(messages, replyId, finishedAt, fallbackStartedAt = null) {
  if (!Array.isArray(messages) || !replyId || !finishedAt) return messages;
  let changed = false;
  const next = messages.map((message) => {
    if (message?.id !== replyId) return message;
    changed = true;
    const transcript = Array.isArray(message.transcript)
      ? message.transcript.map((segment) => segment?.status === 'streaming'
          ? { ...segment, status: 'finished', finishedAt }
          : segment)
      : null;
    return {
      ...message,
      runStartedAt: message.runStartedAt ?? fallbackStartedAt,
      runFinishedAt: finishedAt,
      ...(transcript ? { transcript } : {}),
    };
  });
  return changed ? next : messages;
}

/**
 * A saved reducer state is only safe to reuse when it has the matching durable
 * event cursor. Legacy replies have no cursor, so they must be rebuilt from the
 * server log instead of being seeded and then replayed again from event zero.
 */
export function prepareRemoteEventReplay(reply, resume = false) {
  const rawCursor = resume ? Number(reply?.remoteEventSequence) : 0;
  const cursor = Number.isFinite(rawCursor) && rawCursor > 0
    ? Math.floor(rawCursor)
    : 0;
  return cursor > 0
    ? { cursor, seed: reply }
    : { cursor: 0, seed: null };
}

export function shouldPersistRemoteReplayProgress({
  remoteExecution,
  hasAppliedRemoteEvents,
  savedReply,
}) {
  return !remoteExecution || hasAppliedRemoteEvents || !savedReply;
}

/** Pair rendered reply fields with the exact event checkpoint they represent. */
export function captureRemoteReplyFields(fields, cursor, reasoningParsers) {
  const sequence = Number(cursor);
  return {
    ...fields,
    ...(Number.isFinite(sequence) && sequence > 0
      ? {
          remoteEventSequence: Math.floor(sequence),
          remoteReasoningParsers: reasoningParsers || {},
        }
      : {}),
  };
}

/** Reject malformed polling responses before they can poison resumable state. */
export function assertRemoteRunSnapshot(snapshot, expectedRunId) {
  const idMatches = snapshot?.id != null
    && String(snapshot.id) === String(expectedRunId);
  if (!idMatches || !REMOTE_RUN_STATUSES.has(snapshot?.status)) {
    const error = new Error('Sandbox runtime returned an invalid run status response.');
    error.code = 'AGENT_RUN_INVALID_RESPONSE';
    throw error;
  }
  return snapshot;
}

export function isSlowRemoteRetryError(error) {
  const requestStatus = Number(error?.status);
  return ['AGENT_RUN_CONFIGURATION_ERROR', 'AGENT_RUN_PROTOCOL_OUTDATED'].includes(error?.code)
    || (Number.isFinite(requestStatus)
      && SLOW_REMOTE_RETRY_STATUSES.has(requestStatus));
}

export function shouldRetryRemoteRunFailure({
  remoteExecution,
  remoteRunId,
  recoverable,
  reachedAcceptedTerminal,
  confirmedFailureStatus,
}) {
  return Boolean(
    remoteExecution
    && remoteRunId
    && recoverable
    && !reachedAcceptedTerminal
    && !confirmedFailureStatus
  );
}

/**
 * Protocol-3 servers already provide a durable remoteSequence, but their
 * per-turn run/step/segment/tool ids can restart after every wake-up. Normalize
 * those events client-side as well so upgrading the browser does not require a
 * lockstep sandbox-server restart.
 */
export function normalizeRemoteAgentEvent(event) {
  if (!event || typeof event !== 'object') return event;
  const scope = String(event.runId || 'remote-turn');
  const prefix = `${scope}:`;
  const normalized = {
    ...event,
    sequence: Number(event.remoteSequence) || Number(event.sequence) || 0,
  };
  for (const key of ['id', 'stepId', 'segmentId', 'toolCallId', 'requestId']) {
    const value = event[key];
    if (value == null || value === '') continue;
    const text = String(value);
    normalized[key] = text.startsWith(prefix) ? text : `${prefix}${text}`;
  }
  if (event.permission && typeof event.permission === 'object') {
    const permission = { ...event.permission };
    for (const key of ['id', 'toolCallId']) {
      const value = permission[key];
      if (value == null || value === '') continue;
      const text = String(value);
      permission[key] = text.startsWith(prefix) ? text : `${prefix}${text}`;
    }
    normalized.permission = permission;
  }
  return normalized;
}

/**
 * A client-side poll/protocol/network error says nothing about the server-owned
 * run's terminal state. Preserve running/waiting so normal reattachment keeps
 * working, and record the diagnostic separately.
 */
export function markRemoteRunPollError(remoteRun, runId, error, atMs = Date.now()) {
  if (!remoteRun || remoteRun.id !== runId) return remoteRun;
  return {
    ...remoteRun,
    lastPollError: String(error?.message || error || 'Sandbox polling failed'),
    lastPollErrorAtMs: atMs,
  };
}

/** Only a status returned by the run server may terminalize local metadata. */
export function markConfirmedRemoteRunFailure(remoteRun, runId, status, error) {
  if (
    !remoteRun
    || remoteRun.id !== runId
    || !CONFIRMED_REMOTE_FAILURE_STATUSES.has(status)
  ) return remoteRun;

  return {
    ...remoteRun,
    status: 'error',
    error: String(error?.message || error || `Sandbox run ${status}`),
  };
}
