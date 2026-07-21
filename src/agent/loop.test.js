import assert from 'node:assert/strict';
import test from 'node:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { APICallError } from '@ai-sdk/provider';
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

const WAKEUP_TOOL_SCHEMA = {
  name: 'schedule_wakeup',
  description: 'Schedule a future continuation.',
  parameters: {
    type: 'object',
    properties: {
      delay: { type: 'integer' },
      unit: { type: 'string', enum: ['seconds', 'minutes', 'hours', 'days'] },
      prompt: { type: 'string' },
    },
    required: ['delay', 'unit', 'prompt'],
    additionalProperties: false,
  },
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

test('a successful wake-up ends the current model loop immediately', async () => {
  let modelCallCount = 0;
  const scheduled = [];
  const model = new MockLanguageModelV3({
    doStream: async () => {
      modelCallCount += 1;
      if (modelCallCount > 1) throw new Error('model was called again after scheduling a wake-up');
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'call-wakeup',
              toolName: 'schedule_wakeup',
              input: JSON.stringify({ delay: 10, unit: 'minutes', prompt: 'check the build' }),
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
    },
  });

  const result = await runAgentLoop({
    ...createConcurrentRunOptions('wakeup'),
    maxRounds: 4,
    toolSchemas: [WAKEUP_TOOL_SCHEMA],
    languageModel: model,
    scheduleWakeup: async (request) => {
      scheduled.push(request);
      return { id: 'wake-one', runAtMs: Date.now() + request.delaySeconds * 1_000, prompt: request.prompt };
    },
  });

  assert.equal(modelCallCount, 1);
  assert.deepEqual(scheduled, [{ delaySeconds: 600, prompt: 'check the build' }]);
  assert.equal(result.content, '');
  assert.equal(result.run.finishReason, 'tool-calls');
  assert.equal(result.toolCalls.at(-1)?.name, 'schedule_wakeup');
  assert.equal(result.toolCalls.at(-1)?.status, 'completed');
});

test('a successful wake-up does not wait for the provider stream to finish', async () => {
  let scheduled = null;
  let providerAbortSignal = null;
  const events = [];
  const controller = new AbortController();
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      providerAbortSignal = options.abortSignal;
      return {
        // Deliberately omit both a finish chunk and controller.close(). Some
        // OpenAI-compatible providers leave the SSE open after a tool call.
        stream: new ReadableStream({
          start(streamController) {
            streamController.enqueue({ type: 'stream-start', warnings: [] });
            streamController.enqueue({
              type: 'tool-call',
              toolCallId: 'call-stalled-wakeup',
              toolName: 'schedule_wakeup',
              input: JSON.stringify({ delay: 5, unit: 'seconds', prompt: 'resume after the stall' }),
            });
          },
        }),
      };
    },
  });

  let timeoutId;
  try {
    const result = await Promise.race([
      runAgentLoop({
        ...createConcurrentRunOptions('stalled-wakeup'),
        toolSchemas: [WAKEUP_TOOL_SCHEMA],
        languageModel: model,
        signal: controller.signal,
        scheduleWakeup: async (request) => {
          scheduled = request;
          return { id: 'wake-stalled', runAtMs: Date.now() + 5_000, prompt: request.prompt };
        },
        onEvent: (event) => events.push(event),
      }),
      new Promise((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error('wake-up turn did not terminate')), 1_500);
      }),
    ]);

    assert.deepEqual(scheduled, { delaySeconds: 5, prompt: 'resume after the stall' });
    assert.equal(result.run.finishReason, 'tool-calls');
    assert.equal(result.toolCalls.at(-1)?.status, 'completed');
    assert.equal(providerAbortSignal?.aborted, true);
    assert.ok(events.some((event) => event.type === 'run-finish'));
    assert.equal(events.some((event) => event.type === 'run-error' || event.type === 'run-abort'), false);
  } finally {
    clearTimeout(timeoutId);
    controller.abort();
  }
});

test('a provider error racing a successful wake-up cannot discard the schedule', async () => {
  let providerController;
  const events = [];
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          providerController = controller;
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({
            type: 'tool-call',
            toolCallId: 'call-error-race-wakeup',
            toolName: 'schedule_wakeup',
            input: JSON.stringify({ delay: 5, unit: 'seconds', prompt: 'keep the successful schedule' }),
          });
        },
      }),
    }),
  });

  const result = await runAgentLoop({
    ...createConcurrentRunOptions('error-race-wakeup'),
    toolSchemas: [WAKEUP_TOOL_SCHEMA],
    languageModel: model,
    scheduleWakeup: async (request) => ({
      id: 'wake-error-race',
      runAtMs: Date.now() + request.delaySeconds * 1_000,
      prompt: request.prompt,
    }),
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'tool-result' && event.toolName === 'schedule_wakeup') {
        providerController.enqueue({
          type: 'error',
          error: new Error('PROVIDER_BROKE_AFTER_TOOL_CALL'),
        });
      }
    },
  });

  assert.equal(result.run.finishReason, 'tool-calls');
  assert.equal(result.toolCalls.at(-1)?.status, 'completed');
  assert.equal(events.some((event) => event.type === 'run-error'), false);
});

test('a retryable model connection failure is retried before failing the run', async () => {
  let modelCallCount = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        throw new APICallError({
          message: 'Cannot connect to API: ETIMEDOUT',
          url: 'https://model.example/v1/chat/completions',
          requestBodyValues: {},
          cause: Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }),
          isRetryable: true,
        });
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'answer' },
            { type: 'text-delta', id: 'answer', delta: 'recovered' },
            { type: 'text-end', id: 'answer' },
            { type: 'finish', finishReason: { unified: 'stop' }, usage: TEST_USAGE },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });

  const result = await runAgentLoop({
    ...createConcurrentRunOptions('retry'),
    languageModel: model,
    modelMaxRetries: 1,
  });

  assert.equal(modelCallCount, 2);
  assert.equal(result.content, 'recovered');
});

test('an empty API connection error includes its nested network code', async () => {
  const model = new MockLanguageModelV3({
    doStream: async () => {
      const cause = Object.assign(new Error(''), { code: 'ETIMEDOUT', errors: [] });
      throw new APICallError({
        message: 'Cannot connect to API: ',
        url: 'https://model.example/v1/chat/completions',
        requestBodyValues: {},
        cause,
        isRetryable: true,
      });
    },
  });

  await assert.rejects(
    runAgentLoop({
      ...createConcurrentRunOptions('network-error'),
      languageModel: model,
      modelMaxRetries: 0,
    }),
    /Cannot connect to API: ETIMEDOUT/
  );
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
