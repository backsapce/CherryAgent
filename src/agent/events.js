/**
 * UI-facing event contract for agent runs.
 *
 * Events mirror AI SDK `streamText().fullStream` names wherever possible.
 * VertexAgent adds `tool-status` so long-running local tools can expose
 * stdout/stderr before their AI SDK `tool-result` is available.
 */

export const AGENT_EVENT_TYPES = Object.freeze([
  'text-delta',
  'reasoning-delta',
  'tool-input-start',
  'tool-input-delta',
  'tool-call',
  'tool-status',
  'tool-result',
  'tool-error',
  'finish',
]);

export function createAgentEventState() {
  return {
    content: '',
    thinking: '',
    toolCalls: [],
    usage: null,
  };
}

/**
 * Apply one normalized agent event. Keeping this reducer independent from
 * React makes streaming UI updates deterministic and straightforward to test.
 */
export function applyAgentEvent(state, event) {
  if (!event?.type) return state;

  switch (event.type) {
    case 'text-delta':
      return {
        ...state,
        content: appendSegment(state.content, event.text, event.newSegment),
      };
    case 'reasoning-delta':
      return {
        ...state,
        thinking: appendSegment(state.thinking, event.text, event.newSegment),
      };
    case 'tool-input-start':
      return withTool(state, event, {
        status: initialToolStatus(event.toolName),
      });
    case 'tool-call':
      return withTool(state, event, {
        parsedArgs: event.input ?? {},
        rawArgs: serializeInput(event.input),
        command: commandFor(event.toolName, event.input),
        summary: event.summary,
        status: initialToolStatus(event.toolName),
      });
    case 'tool-status':
      return withTool(state, event, {
        status: event.status || 'running',
        ...(event.output !== undefined ? { result: event.output } : {}),
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
      });
    case 'tool-result':
      return withTool(state, event, {
        status: event.status || 'completed',
        result: event.output == null ? '' : String(event.output),
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
      });
    case 'tool-error':
      return withTool(state, event, {
        status: 'error',
        result: event.error instanceof Error ? event.error.message : String(event.error || 'Tool failed'),
      });
    case 'finish':
      return { ...state, ...(event.usage ? { usage: event.usage } : {}) };
    default:
      return state;
  }
}

function withTool(state, event, patch) {
  const toolCallId = event.toolCallId || event.id;
  if (!toolCallId) return state;
  const existingIndex = state.toolCalls.findIndex((toolCall) => toolCall.id === toolCallId);
  const base = {
    id: toolCallId,
    name: event.toolName || 'unknown_tool',
    status: initialToolStatus(event.toolName),
  };
  const next = { ...(existingIndex >= 0 ? state.toolCalls[existingIndex] : base), ...patch };
  const toolCalls = [...state.toolCalls];
  if (existingIndex >= 0) toolCalls[existingIndex] = next;
  else toolCalls.push(next);
  return { ...state, toolCalls };
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

function initialToolStatus(name) {
  return name === 'write_browser_file' || name === 'write_sandbox_file' || name === 'write_skill_file'
    ? 'writing'
    : 'running';
}
