import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAgentEvent, createAgentEventState } from './events.js';

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
