import assert from 'node:assert/strict';
import test from 'node:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { runAgentLoop } from './loop.js';
import { compactToolResultForModel } from './toolObservation.js';

const TEST_TOOL_SCHEMA = {
  name: 'test_concurrent_run',
  description: 'Test concurrent agent run isolation.',
  parameters: {
    type: 'object',
    properties: {
      run: { type: 'string' },
    },
    required: ['run'],
    additionalProperties: false,
  },
};

const TEST_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

test('compactToolResultForModel leaves short tool results unchanged', () => {
  const result = 'Exit code: 0\nStdout:\nok';

  assert.equal(
    compactToolResultForModel({ name: 'execute_command' }, result, { contextWindow: 100_000 }),
    result
  );
});

test('compactToolResultForModel bounds long tool results and preserves head and tail', () => {
  const result = `Exit code: 1\nStdout:\nSTART\n${'x'.repeat(12_000)}\nStderr:\nEND_MARKER`;
  const compacted = compactToolResultForModel(
    { name: 'execute_command' },
    result,
    { contextWindow: 100_000 }
  );

  assert.ok(compacted.length <= 4_000);
  assert.match(compacted, /tool result compacted/);
  assert.match(compacted, /Tool: execute_command/);
  assert.match(compacted, /START/);
  assert.match(compacted, /END_MARKER/);
  assert.match(compacted, /omitted \d+ chars from middle/);
});

test('concurrent agent loops isolate events, abort signals, and tool contexts', async () => {
  const controllerA = new AbortController();
  const controllerB = new AbortController();
  const toolStartedA = deferred();
  const toolStartedB = deferred();
  const releaseToolB = deferred();
  const eventsA = [];
  const eventsB = [];
  const toolContextsA = [];
  const toolContextsB = [];

  const runA = runAgentLoop({
    ...createConcurrentRunOptions('a'),
    languageModel: createToolCallingModel('a'),
    signal: controllerA.signal,
    onEvent: (event) => eventsA.push(event),
    dispatchTool: async (name, input, context) => {
      toolContextsA.push({ name, input, context });
      toolStartedA.resolve();
      await waitForAbort(context.signal);
    },
  });
  const runB = runAgentLoop({
    ...createConcurrentRunOptions('b'),
    languageModel: createToolCallingModel('b'),
    signal: controllerB.signal,
    onEvent: (event) => eventsB.push(event),
    dispatchTool: async (name, input, context) => {
      toolContextsB.push({ name, input, context });
      toolStartedB.resolve();
      await releaseToolB.promise;
      return 'tool-b-complete';
    },
  });

  await Promise.all([toolStartedA.promise, toolStartedB.promise]);
  controllerA.abort();
  releaseToolB.resolve();

  await assert.rejects(runA, (error) => error?.name === 'AbortError');
  const resultB = await runB;

  assert.equal(resultB.content, 'done-b');
  assert.equal(controllerB.signal.aborted, false);
  assert.deepEqual(toolContextsA.map(({ name, input }) => ({ name, input })), [
    { name: TEST_TOOL_SCHEMA.name, input: { run: 'a' } },
  ]);
  assert.deepEqual(toolContextsB.map(({ name, input }) => ({ name, input })), [
    { name: TEST_TOOL_SCHEMA.name, input: { run: 'b' } },
  ]);
  assert.equal(toolContextsA[0].context.signal, controllerA.signal);
  assert.equal(toolContextsB[0].context.signal, controllerB.signal);
  assert.equal(toolContextsA[0].context.agentId, 'agent-a');
  assert.equal(toolContextsA[0].context.agentWorkspace, 'workspace-a');
  assert.equal(toolContextsB[0].context.agentId, 'agent-b');
  assert.equal(toolContextsB[0].context.agentWorkspace, 'workspace-b');

  const runIdA = eventsA[0].runId;
  const runIdB = eventsB[0].runId;
  assert.notEqual(runIdA, runIdB);
  assert.ok(eventsA.every((event) => event.runId === runIdA));
  assert.ok(eventsB.every((event) => event.runId === runIdB));
  assert.deepEqual(eventsA.map((event) => event.sequence), sequenceThrough(eventsA.length));
  assert.deepEqual(eventsB.map((event) => event.sequence), sequenceThrough(eventsB.length));
  assert.equal(eventsA.at(-1).type, 'run-abort');
  assert.equal(eventsB.at(-1).type, 'run-finish');
  assert.ok(eventsA.some((event) => event.toolCallId === 'call-a'));
  assert.ok(eventsB.some((event) => event.toolCallId === 'call-b'));
  assert.equal(eventsA.some((event) => event.toolCallId === 'call-b'), false);
  assert.equal(eventsB.some((event) => event.toolCallId === 'call-a'), false);
});

function createConcurrentRunOptions(run) {
  return {
    messages: [{ role: 'user', content: `run ${run}` }],
    maxRounds: 2,
    autoSummarize: false,
    toolSchemas: [TEST_TOOL_SCHEMA],
    runtimeContext: {
      workspaceDirName: `workspace-${run}`,
      activeAgent: { id: `agent-${run}`, name: `Agent ${run.toUpperCase()}` },
      memorySnapshot: { memory: null, user: null },
      skillsList: '',
      agentIdentity: null,
    },
    agentId: `agent-${run}`,
  };
}

function createToolCallingModel(run) {
  let callCount = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: `call-${run}`,
                toolName: TEST_TOOL_SCHEMA.name,
                input: JSON.stringify({ run }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage: TEST_USAGE,
              },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        };
      }

      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: `text-${run}` },
            { type: 'text-delta', id: `text-${run}`, delta: `done-${run}` },
            { type: 'text-end', id: `text-${run}` },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: TEST_USAGE,
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}

function waitForAbort(signal) {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function sequenceThrough(length) {
  return Array.from({ length }, (_value, index) => index + 1);
}
