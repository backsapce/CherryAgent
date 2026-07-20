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
  assert.deepEqual(state.transcript.map(({ type, content, toolCallId }) => ({ type, content, toolCallId })), [
    { type: 'text', content: 'Inspecting files.', toolCallId: undefined },
    { type: 'reasoning', content: 'Need the project layout.', toolCallId: undefined },
    { type: 'tool', content: undefined, toolCallId: 'call-1' },
  ]);
});

test('agent events preserve separate model-step segments', () => {
  let state = createAgentEventState();
  state = applyAgentEvent(state, { type: 'text-delta', text: 'First step.' });
  state = applyAgentEvent(state, { type: 'text-delta', text: 'Final step.', newSegment: true });
  state = applyAgentEvent(state, { type: 'reasoning-delta', text: 'First reason.' });
  state = applyAgentEvent(state, { type: 'reasoning-delta', text: 'Second reason.', newSegment: true });

  assert.equal(state.content, 'First step.\n\nFinal step.');
  assert.equal(state.thinking, 'First reason.\n\nSecond reason.');
  assert.deepEqual(state.transcript.map((segment) => [segment.type, segment.content]), [
    ['text', 'First step.'],
    ['text', 'Final step.'],
    ['reasoning', 'First reason.'],
    ['reasoning', 'Second reason.'],
  ]);
});

test('agent transcript preserves reasoning, text, and tool order across steps', () => {
  let state = createAgentEventState();
  const apply = (event) => { state = applyAgentEvent(state, event); };

  apply({ type: 'reasoning-start', segmentId: 'r1', stepId: 'step-1', at: '2026-01-01T00:00:00.000Z' });
  apply({ type: 'reasoning-delta', segmentId: 'r1', text: 'Plan.' });
  apply({ type: 'reasoning-end', segmentId: 'r1', at: '2026-01-01T00:00:01.000Z' });
  apply({ type: 'text-delta', segmentId: 't1', text: 'I will inspect it.' });
  apply({ type: 'tool-call', toolCallId: 'call-1', toolName: 'read_file', input: { path: 'a.js' } });
  apply({ type: 'reasoning-delta', segmentId: 'r2', stepId: 'step-2', text: 'Now verify.', newSegment: true });
  apply({ type: 'tool-call', toolCallId: 'call-2', toolName: 'execute_command', input: { command: 'npm test' } });
  apply({ type: 'text-delta', segmentId: 't2', stepId: 'step-3', text: 'Done.', newSegment: true });

  assert.deepEqual(state.transcript.map((segment) => segment.type === 'tool'
    ? `tool:${segment.toolCallId}`
    : `${segment.type}:${segment.content}`), [
    'reasoning:Plan.',
    'text:I will inspect it.',
    'tool:call-1',
    'reasoning:Now verify.',
    'tool:call-2',
    'text:Done.',
  ]);
  assert.equal(state.transcript[0].status, 'finished');
});

test('agent transcript does not lose text deltas interleaved with a tool call', () => {
  let state = createAgentEventState();
  const apply = (event) => { state = applyAgentEvent(state, event); };

  apply({ type: 'text-start', segmentId: 't1', sequence: 1 });
  apply({ type: 'text-delta', segmentId: 't1', text: 'Before tool.', sequence: 2 });
  apply({ type: 'tool-input-start', toolCallId: 'call-1', toolName: 'read_file', sequence: 3 });
  apply({ type: 'text-delta', segmentId: 't1', text: 'After tool.', sequence: 4 });
  apply({ type: 'text-end', segmentId: 't1', sequence: 5 });

  assert.deepEqual(state.transcript.map((segment) => segment.type === 'tool'
    ? `tool:${segment.toolCallId}`
    : `${segment.type}:${segment.content}`), [
    'text:Before tool.',
    'tool:call-1',
    'text:After tool.',
  ]);
  assert.equal(state.transcript[2].status, 'finished');
});

test('tagged reasoning redirects text after the closing thinking tag', () => {
  let state = createAgentEventState();
  const apply = (event) => { state = applyAgentEvent(state, event); };

  apply({ type: 'reasoning-start', segmentId: 'r1', sequence: 1 });
  apply({ type: 'reasoning-delta', segmentId: 'r1', text: '<think', sequence: 2 });
  apply({ type: 'reasoning-delta', segmentId: 'r1', text: 'ing>Inspect files.', sequence: 3 });
  apply({ type: 'reasoning-delta', segmentId: 'r1', text: '</thinking>正常回答。', sequence: 4 });
  apply({ type: 'reasoning-delta', segmentId: 'r1', text: '继续回答。', sequence: 5 });
  apply({ type: 'reasoning-end', segmentId: 'r1', sequence: 6 });

  assert.equal(state.thinking, 'Inspect files.');
  assert.equal(state.content, '正常回答。继续回答。');
  assert.deepEqual(state.transcript.map((segment) => [segment.type, segment.content]), [
    ['reasoning', 'Inspect files.'],
    ['text', '正常回答。继续回答。'],
  ]);
  assert.equal(state.transcript[1].status, 'finished');
});

test('repeated thinking tags keep the final answer out of the thinking block', () => {
  let state = createAgentEventState();
  const apply = (event) => { state = applyAgentEvent(state, event); };

  apply({ type: 'reasoning-start', stepId: 'step-10', segmentId: 'r1', sequence: 1 });
  apply({
    type: 'reasoning-delta',
    stepId: 'step-10',
    segmentId: 'r1',
    text: 'First kill the existing training process.\n</thinking>\n',
    sequence: 2,
  });
  apply({
    type: 'reasoning-delta',
    stepId: 'step-10',
    segmentId: 'r1',
    text: '<thinking>\nThe instance is already running.\n</thinking>\n\n实例上已经有一个训练在运行中。',
    sequence: 3,
  });
  apply({ type: 'reasoning-end', stepId: 'step-10', segmentId: 'r1', sequence: 4 });

  assert.equal(state.thinking.includes('实例上已经'), false);
  assert.equal(state.thinking.includes('<thinking>'), false);
  assert.equal(state.content.trim(), '实例上已经有一个训练在运行中。');
  assert.deepEqual(state.transcript.map((segment) => segment.type), [
    'reasoning',
    'text',
  ]);
});

test('agent events retain streamed terminal output and exit metadata', () => {
  let state = createAgentEventState();
  state = applyAgentEvent(state, {
    type: 'tool-call',
    toolCallId: 'call-terminal',
    toolName: 'execute_command',
    input: { command: 'build' },
  });
  state = applyAgentEvent(state, {
    type: 'tool-status',
    toolCallId: 'call-terminal',
    toolName: 'execute_command',
    status: 'running',
    terminalOutput: 'compiling...\n',
  });
  state = applyAgentEvent(state, {
    type: 'tool-status',
    toolCallId: 'call-terminal',
    toolName: 'execute_command',
    status: 'running',
    terminalOutput: 'compiling...\ndone\n',
    exitCode: 0,
    cwd: 'workspace',
  });
  state = applyAgentEvent(state, {
    type: 'tool-result',
    toolCallId: 'call-terminal',
    toolName: 'execute_command',
    output: 'Exit code: 0\nStdout:\ncompiling...\ndone\n',
  });

  assert.equal(state.toolCalls[0].terminalOutput, 'compiling...\ndone\n');
  assert.equal(state.toolCalls[0].exitCode, 0);
  assert.equal(state.toolCalls[0].cwd, 'workspace');
  assert.equal(state.toolCalls[0].status, 'completed');
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
  assert.deepEqual(state.usage, { total_tokens: 44 });
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
