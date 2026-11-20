import { compactToolResultForModel } from './toolObservation.js';

const TERMINAL_TOOL_STATUSES = new Set(['completed', 'blocked', 'error', 'aborted']);
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function replayInput(call) {
  if (call.parsedArgs !== undefined) return call.parsedArgs;
  if (call.rawArgs) {
    try { return JSON.parse(call.rawArgs); } catch { return undefined; }
  }
  // Old command cards sometimes stored only their command or summary.
  return call.command ? { command: call.command } : undefined;
}

// Store/transport the model-facing subset of the existing session transcript.
// In particular, don't copy streamed terminal logs or private reasoning.
export function assistantReplayFields(message) {
  const toolCalls = [];
  for (const call of Array.isArray(message?.toolCalls) ? message.toolCalls : []) {
    if (!call || typeof call.id !== 'string' || !call.id || !TOOL_NAME.test(call.name || '')) continue;
    if (!TERMINAL_TOOL_STATUSES.has(call.status) || typeof call.result !== 'string') continue;
    const parsedArgs = replayInput(call);
    if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) continue;
    toolCalls.push({
      id: call.id,
      name: call.name,
      status: call.status,
      parsedArgs,
      result: call.result,
      ...(typeof call.googleThoughtSignature === 'string' && call.googleThoughtSignature
        ? { googleThoughtSignature: call.googleThoughtSignature }
        : {}),
    });
  }
  if (!toolCalls.length) return {};
  const ids = new Set(toolCalls.map((call) => call.id));
  const transcript = (Array.isArray(message.transcript) ? message.transcript : []).flatMap((segment) => {
    const stepId = typeof segment?.stepId === 'string' ? segment.stepId : null;
    if (segment?.type === 'text' && typeof segment.content === 'string' && segment.content) {
      return [{ type: 'text', stepId, content: segment.content }];
    }
    if (segment?.type === 'tool' && ids.has(segment.toolCallId)) {
      return [{ type: 'tool', stepId, toolCallId: segment.toolCallId }];
    }
    return [];
  });
  return { toolCalls, ...(transcript.length ? { transcript } : {}) };
}

// Native call IDs must be unique in the request and portable across providers
// (e.g. Anthropic doesn't accept the ':' in namespaced sandbox event IDs).
function claimCallId(rawId, used) {
  const base = rawId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-48);
  let id = base;
  for (let suffix = 1; used.has(id); suffix += 1) id = `${base}_${suffix}`;
  used.add(id);
  return id;
}

/** Expand an assistant reply into ordered, complete AI SDK message blocks. */
export function projectAssistantHistory(message, { contextWindow, usedCallIds = new Set() } = {}) {
  const { toolCalls = [], transcript = [] } = assistantReplayFields(message);
  const text = String(message.content || '');
  if (!toolCalls.length) return [{ role: 'assistant', content: text }];

  const byId = new Map(toolCalls.map((call) => [call.id, call]));
  const placed = new Set(transcript.filter((segment) => segment.type === 'tool').map((segment) => segment.toolCallId));
  const segments = [
    // Pre-transcript sessions have no reliable interleaving. Put those calls
    // in a complete batch before the visible reply rather than invent order.
    ...toolCalls.filter((call) => !placed.has(call.id)).map((call) => ({ type: 'tool', toolCallId: call.id })),
    ...transcript,
  ];
  if (!transcript.some((segment) => segment.type === 'text') && text) segments.push({ type: 'text', content: text });

  const messages = [];
  let parts = [];
  let results = [];
  let stepId;
  const flush = () => {
    if (parts.length) messages.push({ role: 'assistant', content: parts });
    if (results.length) messages.push({ role: 'tool', content: results });
    parts = [];
    results = [];
  };
  for (const segment of segments) {
    const nextStep = segment.stepId ?? null;
    if (stepId !== nextStep || (nextStep === null && results.length && segment.type === 'text')) flush();
    stepId = nextStep;
    if (segment.type === 'text') {
      parts.push({ type: 'text', text: segment.content });
      continue;
    }
    const call = byId.get(segment.toolCallId);
    if (!call) continue;
    byId.delete(call.id);
    const toolCallId = claimCallId(call.id, usedCallIds);
    parts.push({
      type: 'tool-call', toolCallId, toolName: call.name, input: call.parsedArgs,
      ...(call.googleThoughtSignature ? { providerOptions: { google: { thoughtSignature: call.googleThoughtSignature } } } : {}),
    });
    results.push({
      type: 'tool-result', toolCallId, toolName: call.name,
      output: {
        type: call.status === 'completed' ? 'text' : 'error-text',
        value: compactToolResultForModel(call, call.result, { contextWindow }),
      },
    });
  }
  flush();
  return messages;
}
