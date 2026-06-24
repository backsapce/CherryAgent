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
      return {
        ...next,
        content: appendSegment(next.content, event.text, event.newSegment),
      };
    case 'reasoning-delta':
      return {
        ...next,
        thinking: appendSegment(next.thinking, event.text, event.newSegment),
      };
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
    // Boundary events deliberately do not alter the rendered transcript. They
    // still flow to observers and make segment timing available to future UIs.
    case 'text-start':
    case 'text-end':
    case 'reasoning-start':
    case 'reasoning-end':
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
  return { ...state, toolCalls };
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

function appendSegment(existing, value, newSegment) {
  const text = String(value || '');
  if (!text) return existing;
  if (!existing || !newSegment) return `${existing}${text}`;
  return `${existing}${existing.endsWith('\n') || text.startsWith('\n') ? '' : '\n\n'}${text}`;
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
