import { consumeTaggedReasoning, createTaggedReasoningParser } from './reasoningTags.js';

/**
 * Versioned event contract for an agent run.
 *
 * The loop translates provider-specific stream parts into these events before
 * they reach the UI. That gives the UI and debug consumers one stable protocol
 * even when providers or the underlying AI SDK change their wire format.
 */

export const AGENT_EVENT_VERSION = 1;

export const AGENT_EVENT_TYPES = Object.freeze([
  'run-start',
  'step-start',
  'text-start',
  'text-delta',
  'text-end',
  'reasoning-start',
  'reasoning-delta',
  'reasoning-end',
  'tool-input-start',
  'tool-input-delta',
  'tool-input-end',
  'tool-call',
  'tool-status',
  'tool-result',
  'tool-error',
  'tool-blocked',
  'permission-request',
  'permission-resolved',
  'context-compact',
  'step-finish',
  'run-finish',
  'run-error',
  'run-abort',
]);

export function createAgentEventState() {
  return {
    version: AGENT_EVENT_VERSION,
    status: 'idle',
    runId: null,
    sequence: 0,
    startedAt: null,
    finishedAt: null,
    finishReason: null,
    error: null,
    content: '',
    thinking: '',
    toolCalls: [],
    transcript: [],
    reasoningParsers: {},
    steps: [],
    currentStepId: null,
    permissions: [],
    compactions: [],
    usage: null,
  };
}

/**
 * Apply one normalized event to an immutable run snapshot.
 *
 * This reducer deliberately has no React dependency so a UI, log exporter, or
 * future persistent event store can replay the same run deterministically.
 */
export function applyAgentEvent(state, event) {
  if (!event?.type) return state;

  const next = withEventMetadata(state, event);

  switch (event.type) {
    case 'run-start':
      return {
        ...next,
        status: 'running',
        runId: event.runId || next.runId,
        startedAt: event.at || next.startedAt,
        finishedAt: null,
        finishReason: null,
        error: null,
      };
    case 'step-start':
      return startStep(next, event);
    case 'step-finish':
      return finishStep(next, event);
    case 'text-delta':
      return syncTranscriptText(appendTranscriptText(next, event, 'text'));
    case 'reasoning-delta':
      return appendReasoningDelta(next, event);
    case 'tool-input-start':
      return startToolInput(next, event);
    case 'tool-input-delta':
      return appendToolInput(next, event);
    case 'tool-input-end':
      return withTool(next, event, { inputComplete: true });
    case 'tool-call':
      return registerToolCall(next, event);
    case 'tool-status':
      return withTool(next, event, {
        status: event.status || 'running',
        ...(event.output !== undefined ? { result: String(event.output) } : {}),
        ...(event.terminalOutput !== undefined ? { terminalOutput: String(event.terminalOutput) } : {}),
        ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
        ...(event.platform !== undefined ? { platform: event.platform } : {}),
        ...(event.shell !== undefined ? { shell: event.shell } : {}),
        ...(event.cwd !== undefined ? { cwd: event.cwd } : {}),
        ...(event.filesRoot !== undefined ? { filesRoot: event.filesRoot } : {}),
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
      });
    case 'tool-result':
      return withTool(next, event, {
        status: event.status || 'completed',
        result: event.output == null ? '' : String(event.output),
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
      });
    case 'tool-blocked':
      return withTool(next, event, {
        status: 'blocked',
        result: event.output == null ? 'Tool execution blocked.' : String(event.output),
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
      });
    case 'tool-error':
      return withTool(next, event, {
        status: 'error',
        result: errorMessage(event.error || event.output || 'Tool failed'),
      });
    case 'permission-request':
      return upsertPermission(next, event, 'pending');
    case 'permission-resolved':
      return upsertPermission(next, event, event.approved ? 'approved' : 'rejected');
    case 'context-compact':
      return {
        ...next,
        compactions: [...next.compactions, compactEvent(event)],
      };
    case 'run-finish':
      return finishRun(next, event);
    // Compatibility for consumers that emitted the pre-v1 terminal event.
    case 'finish':
      return finishRun(next, event);
    case 'run-error':
      return {
        ...next,
        status: 'error',
        finishedAt: event.at || next.finishedAt,
        error: errorMessage(event.error),
      };
    case 'run-abort':
      return {
        ...next,
        status: 'aborted',
        finishedAt: event.at || next.finishedAt,
        finishReason: event.reason || 'aborted',
      };
    case 'text-start':
      return startTranscriptSegment(next, event, 'text');
    case 'text-end':
      return finishTranscriptSegment(next, event, 'text');
    case 'reasoning-start':
      return startReasoningStream(next, event);
    case 'reasoning-end':
      return finishReasoningSegments(next, event);
    default:
      return next;
  }
}

function withEventMetadata(state, event) {
  const sequence = Number.isFinite(event.sequence)
    ? Math.max(state.sequence || 0, event.sequence)
    : state.sequence || 0;
  return {
    ...state,
    sequence,
    ...(event.runId ? { runId: event.runId } : {}),
  };
}

function startStep(state, event) {
  const id = event.stepId || `step-${state.steps.length + 1}`;
  const index = Number.isFinite(event.stepIndex) ? event.stepIndex : state.steps.length + 1;
  const step = {
    id,
    index,
    status: 'running',
    startedAt: event.at || null,
  };
  const existingIndex = state.steps.findIndex((item) => item.id === id);
  const steps = [...state.steps];
  if (existingIndex >= 0) steps[existingIndex] = { ...steps[existingIndex], ...step };
  else steps.push(step);
  return { ...state, steps, currentStepId: id };
}

function finishStep(state, event) {
  const id = event.stepId || state.currentStepId;
  if (!id) return state;
  const existingIndex = state.steps.findIndex((item) => item.id === id);
  const patch = {
    status: 'finished',
    finishedAt: event.at || null,
    ...(event.finishReason ? { finishReason: event.finishReason } : {}),
    ...(event.usage ? { usage: event.usage } : {}),
  };
  const steps = [...state.steps];
  if (existingIndex >= 0) steps[existingIndex] = { ...steps[existingIndex], ...patch };
  else steps.push({ id, index: steps.length + 1, ...patch });
  return {
    ...state,
    steps,
    currentStepId: state.currentStepId === id ? null : state.currentStepId,
    ...(event.usage ? { usage: event.usage } : {}),
  };
}

function finishRun(state, event) {
  return {
    ...state,
    status: 'finished',
    finishedAt: event.at || state.finishedAt,
    finishReason: event.finishReason || state.finishReason,
    ...(event.usage ? { usage: event.usage } : {}),
  };
}

function appendToolInput(state, event) {
  const toolCallId = event.toolCallId || event.id;
  if (!toolCallId) return state;
  const existing = findTool(state, event);
  return withTool(state, event, {
    status: existing?.status || 'pending',
    rawArgs: `${existing?.rawArgs || ''}${event.delta || ''}`,
    inputComplete: false,
  });
}

function startToolInput(state, event) {
  const existing = findTool(state, event);
  return withTool(state, event, {
    status: existing?.status || 'pending',
    rawArgs: existing?.rawArgs || '',
    inputComplete: existing?.inputComplete || false,
  });
}

function registerToolCall(state, event) {
  const existing = findTool(state, event);
  return withTool(state, event, {
    parsedArgs: event.input ?? {},
    rawArgs: serializeInput(event.input),
    command: commandFor(event.toolName, event.input),
    summary: event.summary,
    inputComplete: true,
    status: existing?.status || 'pending',
  });
}

function findTool(state, event) {
  const toolCallId = event.toolCallId || event.id;
  return state.toolCalls.find((toolCall) => toolCall.id === toolCallId);
}

function withTool(state, event, patch) {
  const toolCallId = event.toolCallId || event.id;
  if (!toolCallId) return state;
  const existingIndex = state.toolCalls.findIndex((toolCall) => toolCall.id === toolCallId);
  const base = {
    id: toolCallId,
    name: event.toolName || 'unknown_tool',
    status: 'pending',
  };
  const next = { ...(existingIndex >= 0 ? state.toolCalls[existingIndex] : base), ...patch };
  const toolCalls = [...state.toolCalls];
  if (existingIndex >= 0) toolCalls[existingIndex] = next;
  else toolCalls.push(next);
  return ensureToolTranscriptSegment({ ...state, toolCalls }, event, toolCallId);
}

function transcriptSegmentId(state, event, type) {
  if (event.segmentId) return `${type}:${event.segmentId}`;
  const stepPart = event.stepId ? `:${event.stepId}` : '';
  return `${type}${stepPart}:${event.sequence || state.transcript.length + 1}`;
}

function startTranscriptSegment(state, event, type, forcedId) {
  const id = forcedId || transcriptSegmentId(state, event, type);
  if (state.transcript.some((segment) => segment.id === id)) return state;
  const transcript = finishOpenTranscriptSegments(state.transcript, event.at);
  return {
    ...state,
    transcript: [...transcript, {
      id,
      type,
      sourceSegmentId: event.segmentId || null,
      ...(event.reasoningSourceKey ? { reasoningSourceKey: event.reasoningSourceKey } : {}),
      stepId: event.stepId || state.currentStepId || null,
      content: '',
      status: 'streaming',
      startedAt: event.at || null,
    }],
  };
}

function appendTranscriptText(state, event, type) {
  let transcript = state.transcript;
  const explicitId = event.segmentId ? `${type}:${event.segmentId}` : null;
  let index = explicitId
    ? transcript.findLastIndex((segment) => segment.id === explicitId || segment.sourceSegmentId === event.segmentId)
    : transcript.length - 1;
  const existing = transcript[index];
  const interrupted = explicitId && index >= 0 && index !== transcript.length - 1;
  if ((event.newSegment && !explicitId) || index < 0 || existing?.type !== type || interrupted || existing?.status === 'finished') {
    const continuationId = interrupted || (explicitId && existing?.status === 'finished')
      ? `${explicitId}:${event.sequence || transcript.length + 1}`
      : undefined;
    const started = startTranscriptSegment(state, event, type, continuationId);
    transcript = started.transcript;
    index = transcript.length - 1;
  }
  const segments = [...transcript];
  segments[index] = {
    ...segments[index],
    content: `${segments[index].content || ''}${event.text || ''}`,
  };
  return { ...state, transcript: segments };
}

function appendReasoningDelta(state, event) {
  const sourceKey = reasoningSourceKey(state, event);
  const currentParser = state.reasoningParsers[sourceKey] || createTaggedReasoningParser();
  const { parser, emissions } = consumeTaggedReasoning(currentParser, event.text);
  let next = {
    ...state,
    reasoningParsers: { ...state.reasoningParsers, [sourceKey]: parser },
  };

  for (const emission of emissions) {
    // Whitespace between a closing and the next opening tag is structural,
    // rather than user-facing answer text.
    if (emission.type === 'text' && !emission.text.trim()) continue;
    next = appendTranscriptText(next, {
      ...event,
      text: emission.text,
      segmentId: reasoningEmissionSegmentId(sourceKey, emission),
      reasoningSourceKey: sourceKey,
      newSegment: false,
    }, emission.type);
  }

  return syncTranscriptText(next);
}

function reasoningSourceKey(state, event) {
  if (event.stepId) return `${event.stepId}:${event.segmentId || 'reasoning'}`;
  if (event.segmentId) {
    const suffix = `:${event.segmentId}`;
    const existing = Object.keys(state.reasoningParsers).findLast((key) => key.endsWith(suffix));
    return existing || `${state.currentStepId || 'unstepped'}:${event.segmentId}`;
  }
  if (event.newSegment) {
    return `${state.currentStepId || 'unstepped'}:reasoning:${event.sequence || state.transcript.length + 1}`;
  }
  return `${state.currentStepId || 'unstepped'}:reasoning`;
}

function reasoningEmissionSegmentId(sourceKey, emission) {
  return emission.type === 'reasoning'
    ? `tagged-reasoning:${sourceKey}`
    : `tagged-reasoning:${sourceKey}:text:${emission.part}`;
}

function startReasoningStream(state, event) {
  const sourceKey = reasoningSourceKey(state, event);
  const reasoningParsers = state.reasoningParsers[sourceKey]
    ? state.reasoningParsers
    : { ...state.reasoningParsers, [sourceKey]: createTaggedReasoningParser() };
  return startTranscriptSegment({ ...state, reasoningParsers }, {
    ...event,
    segmentId: reasoningEmissionSegmentId(sourceKey, { type: 'reasoning', part: 0 }),
    reasoningSourceKey: sourceKey,
  }, 'reasoning');
}

function finishReasoningSegments(state, event) {
  const sourceKey = reasoningSourceKey(state, event);
  const currentParser = state.reasoningParsers[sourceKey];
  let next = state;
  if (currentParser?.pending) {
    const { parser, emissions } = consumeTaggedReasoning(currentParser, '', { final: true });
    next = {
      ...next,
      reasoningParsers: { ...next.reasoningParsers, [sourceKey]: parser },
    };
    for (const emission of emissions) {
      if (emission.type === 'text' && !emission.text.trim()) continue;
      next = appendTranscriptText(next, {
        ...event,
        text: emission.text,
        segmentId: reasoningEmissionSegmentId(sourceKey, emission),
        reasoningSourceKey: sourceKey,
      }, emission.type);
    }
  }
  const transcript = next.transcript.map((segment) => (
    segment.reasoningSourceKey === sourceKey && segment.status === 'streaming'
      ? { ...segment, status: 'finished', finishedAt: event.at || null }
      : segment
  ));
  return syncTranscriptText({ ...next, transcript });
}

function finishTranscriptSegment(state, event, type) {
  const explicitId = event.segmentId ? `${type}:${event.segmentId}` : null;
  let index = explicitId
    ? state.transcript.findLastIndex((segment) => (
        segment.id === explicitId || segment.sourceSegmentId === event.segmentId
      ) && segment.status !== 'finished')
    : state.transcript.findLastIndex((segment) => segment.type === type && segment.status !== 'finished');
  if (index < 0) return state;
  const transcript = [...state.transcript];
  transcript[index] = {
    ...transcript[index],
    status: 'finished',
    finishedAt: event.at || null,
  };
  return { ...state, transcript };
}

function ensureToolTranscriptSegment(state, event, toolCallId) {
  const id = `tool:${toolCallId}`;
  if (state.transcript.some((segment) => segment.id === id)) return state;
  const transcript = finishOpenTranscriptSegments(state.transcript, event.at);
  return {
    ...state,
    transcript: [...transcript, {
      id,
      type: 'tool',
      stepId: event.stepId || state.currentStepId || null,
      toolCallId,
      startedAt: event.at || null,
    }],
  };
}

function finishOpenTranscriptSegments(transcript, finishedAt) {
  return transcript.map((segment) => segment.status === 'streaming'
    ? { ...segment, status: 'finished', finishedAt: finishedAt || null }
    : segment);
}

function syncTranscriptText(state) {
  return {
    ...state,
    content: transcriptText(state.transcript, 'text'),
    thinking: transcriptText(state.transcript, 'reasoning'),
  };
}

function transcriptText(transcript, type) {
  return transcript
    .filter((segment) => segment.type === type && segment.content)
    .map((segment) => segment.content)
    .join('\n\n');
}

function upsertPermission(state, event, status) {
  const id = event.requestId || event.toolCallId || event.id;
  if (!id) return state;
  const existingIndex = state.permissions.findIndex((permission) => permission.id === id);
  const permission = {
    ...(existingIndex >= 0 ? state.permissions[existingIndex] : { id }),
    kind: event.kind || event.permission?.kind || 'tool',
    toolCallId: event.toolCallId || event.permission?.toolCallId || null,
    status,
    ...(event.at ? { updatedAt: event.at } : {}),
  };
  const permissions = [...state.permissions];
  if (existingIndex >= 0) permissions[existingIndex] = permission;
  else permissions.push(permission);
  return { ...state, permissions };
}

function compactEvent(event) {
  return {
    stepId: event.stepId || null,
    beforeTokens: event.beforeTokens ?? null,
    afterTokens: event.afterTokens ?? null,
    beforeMessages: event.beforeMessages ?? null,
    afterMessages: event.afterMessages ?? null,
    at: event.at || null,
  };
}

function serializeInput(input) {
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return '{}';
  }
}

function commandFor(name, input) {
  return name === 'execute_command' && typeof input?.command === 'string' && input.command.trim()
    ? input.command
    : undefined;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Agent run failed');
}
