import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_EVENT_VERSION, applyAgentEvent, createAgentEventState } from './events.js';

test('agent events assemble text, reasoning, tool state, and usage', () => {
  let state = createAgentEventState();
  const apply = (event) => {
    state = applyAgentEvent(state, event);
  };

  apply({ type: 'text-delta', text: 'Inspecting' });
  apply({ type: 'text-delta', text: ' files.' });
  apply({ type: 'reasoning-delta', text: 'Need the project layout.' });
  apply({ type: 'tool-input-start', toolCallId: 'call-1', toolName: 'execute_command' });
  apply({
    type: 'tool-call',
    toolCallId: 'call-1',
    toolName: 'execute_command',
    input: { command: 'rg --files' },
  });
  apply({ type: 'tool-status', toolCallId: 'call-1', toolName: 'execute_command', output: 'Running...' });
  apply({ type: 'tool-result', toolCallId: 'call-1', toolName: 'execute_command', output: 'src/App.jsx' });
  apply({ type: 'finish', usage: { total_tokens: 42 } });

  assert.equal(state.content, 'Inspecting files.');
  assert.equal(state.thinking, 'Need the project layout.');
  assert.deepEqual(state.toolCalls, [{
    id: 'call-1',
    name: 'execute_command',
    status: 'completed',
    parsedArgs: { command: 'rg --files' },
    rawArgs: '{"command":"rg --files"}',
    command: 'rg --files',
    summary: undefined,
    inputComplete: true,
    result: 'src/App.jsx',
  }]);
  assert.deepEqual(state.usage, { total_tokens: 42 });
});

test('agent events preserve separate model-step segments', () => {
  let state = createAgentEventState();
  state = applyAgentEvent(state, { type: 'text-delta', text: 'First step.' });
  state = applyAgentEvent(state, { type: 'text-delta', text: 'Final step.', newSegment: true });
  state = applyAgentEvent(state, { type: 'reasoning-delta', text: 'First reason.' });
  state = applyAgentEvent(state, { type: 'reasoning-delta', text: 'Second reason.', newSegment: true });

  assert.equal(state.content, 'First step.\n\nFinal step.');
  assert.equal(state.thinking, 'First reason.\n\nSecond reason.');
});

test('agent events record a replayable run lifecycle and streamed tool input', () => {
  let state = createAgentEventState();
  const apply = (event) => {
    state = applyAgentEvent(state, event);
  };

  apply({ type: 'run-start', runId: 'run-1', sequence: 1, at: '2026-01-01T00:00:00.000Z' });
  apply({ type: 'step-start', stepId: 'step-1', stepIndex: 1, sequence: 2, at: '2026-01-01T00:00:01.000Z' });
  apply({ type: 'tool-input-start', toolCallId: 'call-1', toolName: 'execute_command', sequence: 3 });
  apply({ type: 'tool-input-delta', toolCallId: 'call-1', delta: '{"command":"pwd"', sequence: 4 });
  apply({ type: 'tool-input-delta', toolCallId: 'call-1', delta: '}', sequence: 5 });
  apply({ type: 'tool-input-end', toolCallId: 'call-1', sequence: 6 });
  apply({
    type: 'tool-call',
    toolCallId: 'call-1',
    toolName: 'execute_command',
    input: { command: 'pwd' },
    sequence: 7,
  });
  apply({ type: 'tool-status', toolCallId: 'call-1', status: 'running', sequence: 8 });
  apply({ type: 'tool-blocked', toolCallId: 'call-1', output: 'Repeated input blocked.', sequence: 9 });
  apply({ type: 'permission-request', requestId: 'call-1', toolCallId: 'call-1', kind: 'doom-loop', sequence: 10 });
  apply({ type: 'permission-resolved', requestId: 'call-1', toolCallId: 'call-1', kind: 'doom-loop', approved: false, sequence: 11 });
  apply({ type: 'context-compact', beforeTokens: 4000, afterTokens: 1800, beforeMessages: 24, afterMessages: 12, sequence: 12 });
  apply({ type: 'step-finish', stepId: 'step-1', finishReason: 'tool-calls', usage: { total_tokens: 44 }, sequence: 13, at: '2026-01-01T00:00:02.000Z' });
  apply({ type: 'run-finish', finishReason: 'stop', usage: { total_tokens: 53 }, sequence: 14, at: '2026-01-01T00:00:03.000Z' });

  assert.equal(state.version, AGENT_EVENT_VERSION);
  assert.equal(state.status, 'finished');
  assert.equal(state.runId, 'run-1');
  assert.equal(state.sequence, 14);
  assert.equal(state.finishReason, 'stop');
  assert.equal(state.currentStepId, null);
  assert.deepEqual(state.steps, [{
    id: 'step-1',
    index: 1,
    status: 'finished',
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:00:02.000Z',
    finishReason: 'tool-calls',
    usage: { total_tokens: 44 },
  }]);
  assert.deepEqual(state.toolCalls, [{
    id: 'call-1',
    name: 'execute_command',
    status: 'blocked',
    rawArgs: '{"command":"pwd"}',
    inputComplete: true,
    parsedArgs: { command: 'pwd' },
    command: 'pwd',
    summary: undefined,
    result: 'Repeated input blocked.',
  }]);
  assert.deepEqual(state.permissions, [{
    id: 'call-1',
    kind: 'doom-loop',
    toolCallId: 'call-1',
    status: 'rejected',
  }]);
  assert.deepEqual(state.compactions, [{
    stepId: null,
    beforeTokens: 4000,
    afterTokens: 1800,
    beforeMessages: 24,
    afterMessages: 12,
    at: null,
  }]);
  assert.deepEqual(state.usage, { total_tokens: 53 });
});
