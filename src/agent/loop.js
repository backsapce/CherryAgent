/**
 * Agent loop powered by Vercel AI SDK.
 *
 * `streamText` owns the model -> tool -> model loop. This module is the thin
 * CherryAgent adapter that provides its tools, context packing, bounded loop
 * policy, and a UI-safe event stream derived from AI SDK's `fullStream`.
 */

import { jsonSchema, stepCountIs, streamText, tool } from 'ai';
import llm from '../models/llm.js';
import { normalizeAiUsage, toModelMessages } from '../models/ai.js';
import { getEnabledToolSchemas, registry } from './tools.js';
import { assembleApiMessages } from './context.js';
import { loadMemory } from './memory.js';
import { buildSandboxSkillFiles, buildSkillsSection } from './skills.js';
import { compactToolResultForModel } from './toolObservation.js';
import { AGENT_EVENT_VERSION, createAgentEventState, applyAgentEvent } from './events.js';
import { createToolLoopGuard } from './loopSafety.js';
import { getStaticContextWindow } from '../models/contextWindow.js';
import { readAgentAgentsFile } from '../vfs/opfs.js';
import { getAgent, getWorkspaceDirName } from '../agents/agents.js';

const DEFAULT_MAX_ROUNDS = 40;
const ABSOLUTE_MAX_ROUNDS = 80;
const DEFAULT_MODEL_MAX_RETRIES = 2;
const ABSOLUTE_MODEL_MAX_RETRIES = 5;
const DEFAULT_SANDBOX_MODEL_TIMEOUT = Object.freeze({
  stepMs: 5 * 60_000,
  chunkMs: 90_000,
});
const MAX_CONTINUATION_GUARDS = 2;
const STREAMING_TOOL_OUTPUT_MAX_CHARS = 80_000;
const WAKEUP_SCHEDULED_CONTROL_CODE = 'CHERRY_WAKEUP_SCHEDULED';
const WAKEUP_SCHEDULED_CONTROL_BRAND = Symbol('cherry-wakeup-scheduled');

const CONTINUATION_INTENT_RE =
  /\b(?:wait(?:ing)?|poll|check(?:ing)?|download(?:ing)?|compare|continue|next step|not (?:done|finished|complete)|after .*complete|once .*complete)\b|(?:等待|生成完成后|完成后|下载|对比|继续|下一步|稍后|轮生成任务)/i;

const PROMISED_TOOL_WORK_RE =
  /(?:\b(?:(?:i|we)(?:\s*(?:'|’)ll|\s+will|\s+(?:am|are)\s+going\s+to|\s+need\s+to|\s+should)|let\s+me|next(?:,?\s*(?:i|we)(?:\s*(?:'|’)ll|\s+will))?|now(?:,?\s*(?:i|we)(?:\s*(?:'|’)ll|\s+will))?|first(?:,?\s*(?:i|we)(?:\s*(?:'|’)ll|\s+will))?)\b[\s\S]{0,260}\b(?:inspect|check|read|list|open|search|scan|review|create|write|edit|modify|update|delete|move|copy|run|execute|test|build|install|generate|save|load|call|invoke|use)\b|(?:我(?:将|会|需要|应该)|先|接下来|现在)[\s\S]{0,120}(?:检查|读取|列出|搜索|创建|写入|修改|更新|运行|执行|测试|构建|保存|调用|使用))/i;

const CONTINUATION_GUARD_PROMPT =
  'You indicated the task still needs a later step, but you did not call a tool. Continue the task now. Do not describe future tool work. If a tool can inspect, read, list, create, write, run, check status, compare, or finish the work, call that tool in this response. Only provide a final answer when the requested task is actually complete.';

const FINALIZE_PROMPT =
  'The tool-use round limit has been reached. Stop using tools and provide the best final status now: what is complete, what changed, what was verified, and any remaining blockers.';

const EMPTY_RESPONSE_RETRY_PROMPT =
  'Your previous response was empty. Answer the user now with a concrete response. Use tools if needed, and do not return an empty message.';

/**
 * Run an autonomous agent turn.
 *
 * @param {Object} opts
 * @param {Array} opts.messages
 * @param {string} opts.systemPrompt
 * @param {string} [opts.agentUrl]
 * @param {string} [opts.agentId]
 * @param {Function} [opts.onEvent] Receives normalized AI SDK stream events.
 * @param {Function} [opts.onUpdate] Legacy snapshot callback.
 * @param {Function} [opts.onPermissionRequest] Optional approval callback for
 * repeated identical tool calls. It receives a doom-loop request and must
 * resolve to `true` to allow the call; without it, repeated calls are blocked.
 * @param {Function} [opts.scheduleWakeup] Persists a future continuation for
 * the current conversation. When omitted, the scheduling tool is hidden.
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.maxRounds]
 * @param {number} [opts.modelMaxRetries]
 * @param {number|{totalMs?: number, stepMs?: number, chunkMs?: number}|null} [opts.modelTimeout]
 * @returns {Promise<{ content: string, thinking: string, toolCalls: Array, usage: Object|null }>}
 */
export async function runAgentLoop(opts) {
  const {
    messages = [],
    systemPrompt = '',
    agentUrl = null,
    agentId = null,
    onEvent = () => {},
    onUpdate = null,
    onPermissionRequest = null,
    signal = null,
    subAgentDepth = 0,
  } = opts;

  const maxRounds = normalizeMaxRounds(opts.maxRounds);
  const modelMaxRetries = normalizeModelMaxRetries(opts.modelMaxRetries);
  const runtimeContext = opts.runtimeContext || await prepareAgentRuntimeContext(agentId, {
    runtimeMode: opts.runtimeMode,
    agentUrl,
    signal,
  });
  const workspaceDirName = runtimeContext.workspaceDirName;
  const activeAgent = runtimeContext.activeAgent;
  const memorySnapshot = runtimeContext.memorySnapshot;
  const skillsList = runtimeContext.skillsList;
  const agentIdentity = runtimeContext.agentIdentity;
  const contextWindow = opts.contextWindow || getStaticContextWindow(opts.provider, opts.model);
  const modelTimeout = opts.modelTimeout === undefined && opts.runtimeMode === 'sandbox'
    ? DEFAULT_SANDBOX_MODEL_TIMEOUT
    : opts.modelTimeout;
  const schemas = opts.toolSchemas || getEnabledToolSchemas({
    agentUrl,
    agentId,
    llmProfileId: opts.llmProfileId,
    subAgentDepth,
    scheduleWakeup: opts.scheduleWakeup,
  });
  const packed = await assembleApiMessages({
    messages,
    systemPrompt,
    memorySnapshot,
    skillsList,
    agentIdentity,
    contextWindow,
    summaryState: { content: '', coveredUntil: 0 },
    llmProfileId: opts.llmProfileId,
    signal,
    autoSummarize: opts.autoSummarize !== false,
    runtimeMode: opts.runtimeMode || 'browser',
  });

  // Sleeping ends only this model/tool turn. The caller's signal continues to
  // own the durable run so the sandbox can start a fresh turn at the deadline.
  const turn = createTurnController(
    signal,
    typeof opts.scheduleWakeup === 'function' || modelTimeout != null
  );
  const loopControl = {
    wakeupScheduled: false,
    wakeup: null,
    parentAborted: () => Boolean(signal?.aborted),
    abortTurn: () => turn.abort(createWakeupScheduledControl()),
  };
  const toolContext = {
    agentUrl,
    agentId,
    agentName: activeAgent?.name || workspaceDirName,
    agentWorkspace: workspaceDirName,
    llmProfileId: opts.llmProfileId,
    provider: opts.provider,
    model: opts.model,
    contextWindow,
    subAgentDepth,
    signal: turn.signal,
    onPermissionRequest,
    scheduleWakeup: typeof opts.scheduleWakeup === 'function'
      ? async (request) => {
        const wakeup = await opts.scheduleWakeup(request);
        if (wakeup) {
          loopControl.wakeupScheduled = true;
          loopControl.wakeup = wakeup;
        }
        return wakeup;
      }
      : undefined,
    loopControl,
    toolLoopGuard: createToolLoopGuard(),
    dispatchTool: opts.dispatchTool || ((name, input, context) => registry.dispatch(name, input, context)),
  };

  const runId = createAgentRunId();
  const lifecycle = { stepIndex: 0, currentStepId: null };
  let eventSequence = 0;
  let state = createAgentEventState();
  const emit = (event) => {
    const normalized = {
      version: AGENT_EVENT_VERSION,
      runId,
      sequence: ++eventSequence,
      at: new Date().toISOString(),
      ...event,
    };
    state = applyAgentEvent(state, normalized);
    onEvent?.(normalized);
    onUpdate?.({
      content: state.content,
      thinking: state.thinking,
      toolCalls: state.toolCalls,
    });
  };

  try {
    emit({
      type: 'run-start',
      maxRounds,
      contextWindow,
      estimatedInputTokens: packed.estimatedTokens,
    });
    const model = opts.languageModel || llm.getLanguageModel(opts.llmProfileId);
    const tools = createAgentTools(schemas, toolContext, emit);
    const initial = await consumeAgentStream({
      model,
      messages: toModelMessages(packed.apiMessages),
      system: packed.systemPrompt,
      tools,
      maxRounds,
      modelMaxRetries,
      modelTimeout,
      contextWindow,
      signal: turn.signal,
      emit,
      lifecycle,
      loopControl,
    });

    let latestRun = initial;
    let responseMessages = [...initial.responseMessages];
    let latestUsage = initial.usage;
    let totalUsage = initial.totalUsage;
    let modelCallCount = initial.modelCallCount ?? initial.steps.length;
    let continuationGuardCount = 0;

    // A syntactically successful but empty completion is common with broken
    // OpenAI-compatible gateways. Retry it once; otherwise the UI used to
    // accept a completed run and render a permanently blank assistant card.
    if (!hasMeaningfulAgentOutput(state) && modelCallCount < maxRounds) {
      const recovery = await consumeAgentStream({
        model,
        messages: [
          ...toModelMessages(packed.apiMessages),
          { role: 'user', content: EMPTY_RESPONSE_RETRY_PROMPT },
        ],
        system: packed.systemPrompt,
        tools,
        maxRounds: Math.max(1, maxRounds - modelCallCount),
        modelMaxRetries,
        modelTimeout,
        contextWindow,
        signal: turn.signal,
        emit,
        lifecycle,
        loopControl,
      });
      latestRun = recovery;
      responseMessages.push(...recovery.responseMessages);
      latestUsage = recovery.usage || latestUsage;
      totalUsage = addUsage(totalUsage, recovery.totalUsage);
      modelCallCount += recovery.modelCallCount ?? recovery.steps.length;
    }

    while (modelCallCount < maxRounds && shouldContinueWithoutToolCall(latestRun, schemas, continuationGuardCount)) {
      continuationGuardCount += 1;
      const continuation = await consumeAgentStream({
        model,
        messages: [
          ...toModelMessages(packed.apiMessages),
          ...responseMessages,
          { role: 'user', content: CONTINUATION_GUARD_PROMPT },
        ],
        system: packed.systemPrompt,
        tools,
        maxRounds: Math.max(1, maxRounds - modelCallCount),
        modelMaxRetries,
        modelTimeout,
        contextWindow,
        signal: turn.signal,
        emit,
        lifecycle,
        loopControl,
      });
      latestRun = continuation;
      responseMessages.push(...continuation.responseMessages);
      latestUsage = continuation.usage || latestUsage;
      totalUsage = addUsage(totalUsage, continuation.totalUsage);
      modelCallCount += continuation.modelCallCount ?? continuation.steps.length;
    }

    // `stepCountIs` ends on a tool-call step. Give the model one tool-free turn
    // to report a useful status, matching the old loop's bounded finalizer.
    if (latestRun.finishReason === 'tool-calls' && !loopControl.wakeupScheduled && !signal?.aborted) {
      const finalizer = await consumeAgentStream({
        model,
        messages: [
          ...toModelMessages(packed.apiMessages),
          ...responseMessages,
          { role: 'user', content: FINALIZE_PROMPT },
        ],
        system: packed.systemPrompt,
        tools: {},
        maxRounds: 1,
        modelMaxRetries,
        modelTimeout,
        contextWindow,
        signal: turn.signal,
        emit,
        lifecycle,
        loopControl,
      });
      latestRun = finalizer;
      latestUsage = finalizer.usage || latestUsage;
      totalUsage = addUsage(totalUsage, finalizer.totalUsage);
      modelCallCount += finalizer.modelCallCount ?? finalizer.steps.length;
    }

    throwIfAborted(signal);
    if (!hasMeaningfulAgentOutput(state)) {
      const error = new Error(
        `Model returned an empty response after retrying. Verify that ${opts.model || 'the selected model'} supports chat-completion streaming, or select another model.`
      );
      error.name = 'EmptyModelResponseError';
      error.code = 'EMPTY_MODEL_RESPONSE';
      throw error;
    }
    const usage = buildUsageReport(latestUsage, totalUsage, contextWindow, modelCallCount);
    emit({
      type: 'run-finish',
      usage,
      finishReason: latestRun.finishReason,
      modelCallCount,
    });

    return buildAgentLoopResult({ state, runId, usage });
  } catch (caughtError) {
    const err = enrichEmptyCauseMessage(asError(caughtError));
    if (err?.code === 'MODEL_TIMEOUT') {
      // Reader cancellation is best effort. Abort the turn as well so the AI
      // SDK, provider request, and any in-flight tool all receive the timeout.
      turn.abort(err);
    }
    if (loopControl.wakeupScheduled && !signal?.aborted) {
      loopControl.abortTurn();
      if (lifecycle.currentStepId) {
        emit({
          type: 'step-finish',
          stepId: lifecycle.currentStepId,
          finishReason: 'tool-calls',
        });
        lifecycle.currentStepId = null;
      }
      const usage = state.usage || null;
      emit({
        type: 'run-finish',
        usage,
        finishReason: 'tool-calls',
        modelCallCount: Math.max(1, lifecycle.stepIndex),
      });
      return buildAgentLoopResult({ state, runId, usage });
    }
    if (signal?.aborted) {
      emit({ type: 'run-abort', reason: err?.message || 'aborted' });
    } else {
      emit({ type: 'run-error', error: err });
    }
    throw err;
  } finally {
    turn.dispose();
  }
}

/**
 * Snapshot browser-owned prompt state before a run is handed to a different
 * runtime. Sandbox mode also includes bounded identity and skill files.
 */
export async function prepareAgentRuntimeContext(agentId, options = {}) {
  const workspaceDirName = agentId ? await getWorkspaceDirName(agentId) : null;
  const activeAgent = agentId ? await getAgent(agentId) : null;
  const runtimeMode = options.runtimeMode === 'sandbox' ? 'sandbox' : 'browser';
  const [memorySnapshot, agentIdentity] = await Promise.all([
    loadMemory(agentId),
    agentId ? readAgentAgentsFile(agentId) : null,
  ]);
  const skillsList = await buildSkillsSection(agentId, {
    runtimeMode,
    agentUrl: options.agentUrl,
    signal: options.signal,
  });
  const skillFiles = runtimeMode === 'sandbox'
    ? await buildSandboxSkillFiles(agentId, { signal: options.signal })
    : [];
  const sandboxFiles = runtimeMode === 'sandbox'
    ? [
      ...(agentIdentity ? [{ path: 'AGENTS.md', content: agentIdentity }] : []),
      ...skillFiles,
    ]
    : [];
  return {
    workspaceDirName,
    activeAgent: activeAgent ? { id: activeAgent.id, name: activeAgent.name } : null,
    memorySnapshot,
    skillsList,
    agentIdentity,
    sandboxFiles,
  };
}

function shouldContinueWithoutToolCall(run, schemas, continuationGuardCount) {
  if (!schemas?.length || continuationGuardCount >= MAX_CONTINUATION_GUARDS) return false;
  if (run.finishReason === 'tool-calls') return false;
  const finalStep = run.steps.at(-1);
  if (!finalStep) return false;
  const text = `${finalStep.text || ''}\n${finalStep.reasoningText || ''}`;
  const toolCallsSoFar = run.steps.reduce((count, step) => count + step.toolCalls.length, 0);
  return (toolCallsSoFar > 0 && CONTINUATION_INTENT_RE.test(text)) || PROMISED_TOOL_WORK_RE.test(text);
}

function hasMeaningfulAgentOutput(state) {
  return Boolean(
    String(state?.content || '').trim()
    || String(state?.thinking || '').trim()
    || state?.toolCalls?.length
  );
}

function createAgentTools(schemas, toolContext, emit) {
  // AI SDK may start multiple execute functions at once. Serializing here
  // protects mutating workspace tools while still letting the SDK preserve its
  // native multi-step tool protocol.
  let executionTail = Promise.resolve();

  return Object.fromEntries((schemas || []).map((schema) => [
    schema.name,
    tool({
      description: schema.description,
      inputSchema: jsonSchema(schema.parameters || { type: 'object', properties: {} }),
      execute: (input, execution) => {
        const execute = () => executeAgentTool({
          toolCallId: execution.toolCallId,
          toolName: schema.name,
          input,
          signal: execution.abortSignal || toolContext.signal,
          toolContext,
          emit,
        });
        // A wake-up is a terminal control action, not a workspace mutation. It
        // must not wait behind a command that may itself be blocked for hours.
        if (schema.name === 'schedule_wakeup') return execute();

        const scheduled = executionTail.then(execute);
        executionTail = scheduled.catch(() => {});
        return scheduled;
      },
    }),
  ]));
}

async function executeAgentTool({ toolCallId, toolName, input, signal, toolContext, emit }) {
  let streamingStdout = '';
  let streamingStderr = '';
  let terminalOutput = '';
  const baseEvent = { toolCallId, toolName, input };

  const updateRunningOutput = (chunk) => {
    if (chunk?.stdout) streamingStdout = appendStreamingOutput(streamingStdout, chunk.stdout, 'stdout');
    if (chunk?.stderr) streamingStderr = appendStreamingOutput(streamingStderr, chunk.stderr, 'stderr');
    if (chunk?.stdout) terminalOutput = appendStreamingOutput(terminalOutput, chunk.stdout, 'terminal');
    if (chunk?.stderr) terminalOutput = appendStreamingOutput(terminalOutput, chunk.stderr, 'terminal');
    emit({
      type: 'tool-status',
      ...baseEvent,
      status: runningToolStatus(toolName, input),
      ...(terminalOutput ? { terminalOutput } : {}),
      ...(chunk?.exitCode !== undefined ? { exitCode: chunk.exitCode } : {}),
      ...(chunk?.platform ? { platform: chunk.platform } : {}),
      ...(chunk?.shell ? { shell: chunk.shell } : {}),
      ...(chunk?.cwd ? { cwd: chunk.cwd } : {}),
      ...(chunk?.filesRoot ? { filesRoot: chunk.filesRoot } : {}),
    });
  };

  try {
    throwIfAborted(signal);
    const guardResult = toolContext.toolLoopGuard?.check({ toolName, input });
    if (guardResult?.repeated) {
      const permission = {
        id: toolCallId,
        kind: 'doom-loop',
        toolCallId,
        toolName,
        input,
        threshold: guardResult.threshold,
        occurrences: guardResult.occurrences,
      };
      emit({ type: 'permission-request', requestId: toolCallId, toolCallId, kind: permission.kind, permission });
      const approved = await requestToolApproval(toolContext.onPermissionRequest, permission);
      emit({ type: 'permission-resolved', requestId: toolCallId, toolCallId, kind: permission.kind, approved });
      throwIfAborted(signal);
      if (!approved) {
        const output = formatDoomLoopBlock(toolName, guardResult.threshold);
        const summary = formatToolCallSummary(toolName, input);
        emit({ type: 'tool-blocked', ...baseEvent, output, summary });
        return compactToolResultForModel({ name: toolName, parsedArgs: input }, output, {
          contextWindow: toolContext.contextWindow,
        });
      }
    }

    emit({ type: 'tool-status', ...baseEvent, status: runningToolStatus(toolName, input) });
    const result = await toolContext.dispatchTool(toolName, input, {
      ...toolContext,
      signal,
      onToolUpdate: updateRunningOutput,
    });
    // A tool implementation may resolve after ignoring cancellation. Never
    // publish that stale result into a later wake-up turn.
    throwIfAborted(signal);
    const output = String(result);
    const summary = formatToolCallSummary(toolName, input, output);
    emit({ type: 'tool-result', ...baseEvent, status: 'completed', output, summary });
    if (toolName === 'schedule_wakeup' && toolContext.loopControl?.wakeupScheduled) {
      // AI SDK publishes rejected tool executions immediately. This private
      // control signal therefore ends the turn even if the provider never
      // sends a finish chunk or closes its stream. The completed UI event has
      // already been emitted above and is deliberately kept successful.
      throw createWakeupScheduledControl(toolContext.loopControl.wakeup);
    }
    return compactToolResultForModel({ name: toolName, parsedArgs: input }, output, {
      contextWindow: toolContext.contextWindow,
    });
  } catch (err) {
    if (isWakeupScheduledControl(err)) throw err;
    if (signal?.aborted) {
      emit({
        type: 'tool-status',
        ...baseEvent,
        status: 'aborted',
        output: formatAbortResult(streamingStdout, streamingStderr),
      });
      throw err;
    }
    const output = `Error: ${err?.message || String(err)}`;
    emit({
      type: 'tool-result',
      ...baseEvent,
      status: 'error',
      output,
      summary: formatToolCallSummary(toolName, input),
    });
    return compactToolResultForModel({ name: toolName, parsedArgs: input }, output, {
      contextWindow: toolContext.contextWindow,
    });
  }
}

async function consumeAgentStream({
  model,
  messages,
  system,
  tools,
  maxRounds,
  modelMaxRetries,
  modelTimeout,
  contextWindow,
  signal,
  emit,
  lifecycle,
  loopControl,
}) {
  const result = streamText({
    model,
    messages,
    ...(system ? { system } : {}),
    ...(Object.keys(tools).length ? {
      tools,
      stopWhen: [
        stepCountIs(maxRounds),
        () => loopControl?.wakeupScheduled === true,
      ],
    } : {}),
    ...(signal ? { abortSignal: signal } : {}),
    prepareStep: ({ messages: stepMessages }) => {
      const compacted = compactAiMessages(stepMessages, contextWindow);
      if (compacted !== stepMessages) {
        emit({
          type: 'context-compact',
          stepId: lifecycle?.currentStepId || null,
          beforeTokens: estimateAiMessageTokens(stepMessages),
          afterTokens: estimateAiMessageTokens(compacted),
          beforeMessages: stepMessages.length,
          afterMessages: compacted.length,
        });
      }
      return compacted === stepMessages ? undefined : { messages: compacted };
    },
    maxRetries: modelMaxRetries,
  });

  let finishReason = null;
  let currentStepHasText = false;
  let currentStepHasReasoning = false;

  const fullStream = modelTimeout == null && !signal
    ? result.fullStream
    : modelStreamWithTimeout(result.fullStream, modelTimeout, signal);

  for await (const part of fullStream) {
    throwIfAborted(signal);
    switch (part.type) {
      case 'start-step':
        currentStepHasText = false;
        currentStepHasReasoning = false;
        if (lifecycle) {
          lifecycle.stepIndex += 1;
          lifecycle.currentStepId = `step-${lifecycle.stepIndex}`;
        }
        emit({
          type: 'step-start',
          stepId: lifecycle?.currentStepId,
          stepIndex: lifecycle?.stepIndex,
        });
        break;
      case 'text-start':
        emit({ type: 'text-start', segmentId: part.id, stepId: lifecycle?.currentStepId });
        break;
      case 'text-delta':
        emit({
          type: 'text-delta',
          text: part.text,
          newSegment: !currentStepHasText,
          segmentId: part.id,
          stepId: lifecycle?.currentStepId,
        });
        currentStepHasText = true;
        break;
      case 'text-end':
        emit({ type: 'text-end', segmentId: part.id, stepId: lifecycle?.currentStepId });
        break;
      case 'reasoning-start':
        emit({ type: 'reasoning-start', segmentId: part.id, stepId: lifecycle?.currentStepId });
        break;
      case 'reasoning-delta':
        emit({
          type: 'reasoning-delta',
          text: part.text,
          newSegment: !currentStepHasReasoning,
          segmentId: part.id,
          stepId: lifecycle?.currentStepId,
        });
        currentStepHasReasoning = true;
        break;
      case 'reasoning-end':
        emit({ type: 'reasoning-end', segmentId: part.id, stepId: lifecycle?.currentStepId });
        break;
      case 'tool-input-start':
        emit({ type: 'tool-input-start', toolCallId: part.id, toolName: part.toolName, stepId: lifecycle?.currentStepId });
        break;
      case 'tool-input-delta':
        emit({ type: 'tool-input-delta', toolCallId: part.id, delta: part.delta, stepId: lifecycle?.currentStepId });
        break;
      case 'tool-input-end':
        emit({ type: 'tool-input-end', toolCallId: part.id, stepId: lifecycle?.currentStepId });
        break;
      case 'tool-call':
        emit({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
          summary: formatToolCallSummary(part.toolName, part.input),
          stepId: lifecycle?.currentStepId,
        });
        break;
      case 'tool-error':
        if (
          part.toolName === 'schedule_wakeup'
          && loopControl?.wakeupScheduled
        ) {
          return finishStreamForWakeup({ loopControl, lifecycle, emit });
        }
        emit({
          type: 'tool-error',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          error: part.error,
          stepId: lifecycle?.currentStepId,
        });
        break;
      case 'finish-step':
        emit({
          type: 'step-finish',
          stepId: lifecycle?.currentStepId,
          usage: normalizeAiUsage(part.usage),
          finishReason: part.finishReason,
        });
        if (lifecycle) lifecycle.currentStepId = null;
        break;
      case 'finish':
        finishReason = part.finishReason;
        break;
      case 'abort':
        if (loopControl?.wakeupScheduled && !loopControl.parentAborted?.()) {
          return finishStreamForWakeup({ loopControl, lifecycle, emit });
        }
        throw createAbortError(part.reason);
      case 'error':
        if (loopControl?.wakeupScheduled && !loopControl.parentAborted?.()) {
          return finishStreamForWakeup({ loopControl, lifecycle, emit });
        }
        throw asError(part.error);
      default:
        break;
    }
  }

  const [steps, usage, totalUsage] = await Promise.all([
    result.steps,
    result.usage,
    result.totalUsage,
  ]);
  return {
    finishReason: finishReason || await result.finishReason,
    steps,
    usage: normalizeAiUsage(usage),
    totalUsage: normalizeAiUsage(totalUsage),
    responseMessages: steps.flatMap((step) => step.response.messages),
    modelCallCount: steps.length,
  };
}

async function* modelStreamWithTimeout(stream, timeout, signal) {
  const limits = normalizeModelTimeout(timeout);
  if (!limits.totalMs && !limits.stepMs && !limits.chunkMs && !signal) {
    yield* stream;
    return;
  }

  const reader = stream.getReader();
  const totalStartedAt = Date.now();
  let stepStartedAt = totalStartedAt;
  let lastChunkAt = null;
  let completed = false;
  let cancellationReason = null;

  try {
    while (true) {
      if (stepStartedAt == null) stepStartedAt = Date.now();
      const deadlines = [
        modelDeadline('total', totalStartedAt, limits.totalMs),
        modelDeadline('step', stepStartedAt, limits.stepMs),
        modelDeadline('chunk', lastChunkAt, limits.chunkMs),
      ].filter(Boolean);
      const nearest = deadlines.sort((left, right) => left.at - right.at)[0] || null;

      let next;
      try {
        next = await readModelStreamPart(reader, nearest, signal);
      } catch (error) {
        cancellationReason = error;
        throw error;
      }

      if (next.done) {
        completed = true;
        return;
      }

      yield next.value;
      if (next.value?.type === 'finish-step') {
        // AI SDK starts a fresh per-step timeout for the next model request and
        // clears its inter-chunk timer while tools/stop conditions are handled.
        stepStartedAt = null;
        lastChunkAt = null;
      } else {
        lastChunkAt = Date.now();
      }
    }
  } finally {
    if (!completed) {
      Promise.resolve(reader.cancel(cancellationReason || createAbortError()))
        .catch(() => {});
    }
    try {
      reader.releaseLock();
    } catch {
      // A provider that ignores cancellation may keep its read request pending.
      // Cancelling above is best effort; the timed caller has already detached.
    }
  }
}

function normalizeModelTimeout(timeout) {
  if (typeof timeout === 'number') {
    return { totalMs: positiveTimeout(timeout), stepMs: null, chunkMs: null };
  }
  return {
    totalMs: positiveTimeout(timeout?.totalMs),
    stepMs: positiveTimeout(timeout?.stepMs),
    chunkMs: positiveTimeout(timeout?.chunkMs),
  };
}

function positiveTimeout(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function modelDeadline(kind, startedAt, timeoutMs) {
  return startedAt != null && timeoutMs
    ? { kind, timeoutMs, at: startedAt + timeoutMs }
    : null;
}

async function readModelStreamPart(reader, deadline, signal) {
  if (signal?.aborted) throw modelAbortError(signal);
  let timerId;
  let onAbort;
  try {
    const racers = [reader.read()];
    if (deadline) {
      racers.push(new Promise((_resolve, reject) => {
        timerId = setTimeout(() => {
          const error = new Error(
            `Model stream ${deadline.kind} timed out after ${deadline.timeoutMs} ms. Verify that the configured LLM endpoint is reachable from this runtime.`
          );
          error.name = 'ModelTimeoutError';
          error.code = 'MODEL_TIMEOUT';
          reject(error);
        }, Math.max(0, deadline.at - Date.now()));
      }));
    }
    if (signal) {
      racers.push(new Promise((_resolve, reject) => {
        onAbort = () => reject(modelAbortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
      }));
    }
    return await Promise.race(racers);
  } finally {
    clearTimeout(timerId);
    signal?.removeEventListener('abort', onAbort);
  }
}

function modelAbortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : createAbortError(signal?.reason);
}

function finishStreamForWakeup({ loopControl, lifecycle, emit }) {
  loopControl?.abortTurn?.();
  if (lifecycle?.currentStepId) {
    emit({
      type: 'step-finish',
      stepId: lifecycle.currentStepId,
      finishReason: 'tool-calls',
    });
    lifecycle.currentStepId = null;
  }
  return {
    finishReason: 'tool-calls',
    steps: [],
    usage: null,
    totalUsage: null,
    responseMessages: [],
    modelCallCount: 1,
  };
}

function createWakeupScheduledControl(wakeup = null) {
  const error = new Error('Wake-up scheduled');
  error.name = 'WakeupScheduledControl';
  error.code = WAKEUP_SCHEDULED_CONTROL_CODE;
  error[WAKEUP_SCHEDULED_CONTROL_BRAND] = true;
  error.wakeup = wakeup;
  return error;
}

function isWakeupScheduledControl(error) {
  return error?.[WAKEUP_SCHEDULED_CONTROL_BRAND] === true;
}

function buildAgentLoopResult({ state, runId, usage }) {
  return {
    content: state.content,
    thinking: state.thinking,
    toolCalls: state.toolCalls,
    usage,
    run: {
      id: runId,
      status: state.status,
      finishReason: state.finishReason,
      steps: state.steps,
      compactions: state.compactions,
    },
  };
}

function createTurnController(parentSignal, enabled) {
  if (!enabled) {
    return {
      signal: parentSignal,
      abort() {},
      dispose() {},
    };
  }
  const controller = new AbortController();
  const relayAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) relayAbort();
  else parentSignal?.addEventListener('abort', relayAbort, { once: true });

  return {
    signal: controller.signal,
    abort(reason) {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    dispose() {
      parentSignal?.removeEventListener('abort', relayAbort);
    },
  };
}

/**
 * Bound multi-step history without separating native assistant tool calls from
 * their tool-result messages. Initial user history is already summarized by
 * assembleApiMessages(); this protects the additional AI SDK loop history.
 */
function compactAiMessages(messages, contextWindow) {
  const threshold = Math.floor(Math.max(contextWindow || 0, 8_000) * 0.72);
  if (estimateAiMessageTokens(messages) <= threshold) return messages;

  const blocks = groupAiMessageBlocks(messages);
  const headBlocks = blocks.slice(0, Math.min(4, blocks.length));
  const headCount = headBlocks.length;
  const headTokens = estimateAiMessageTokens(headBlocks.flat());
  const tailBudget = Math.max(2_048, threshold - headTokens);
  const tail = [];
  let tailTokens = 0;

  for (let index = blocks.length - 1; index >= headCount; index -= 1) {
    const block = blocks[index];
    const blockTokens = estimateAiMessageTokens(block);
    const mustKeep = tail.length < 8;
    if (!mustKeep && tailTokens + blockTokens > tailBudget) break;
    tail.unshift(block);
    tailTokens += blockTokens;
  }

  return [...headBlocks.flat(), ...tail.flat()];
}

function groupAiMessageBlocks(messages) {
  const blocks = [];
  for (let index = 0; index < messages.length; index += 1) {
    const block = [messages[index]];
    if (hasNativeToolCall(messages[index]) && messages[index + 1]?.role === 'tool') {
      block.push(messages[index + 1]);
      index += 1;
    }
    blocks.push(block);
  }
  return blocks;
}

function hasNativeToolCall(message) {
  return message?.role === 'assistant'
    && Array.isArray(message.content)
    && message.content.some((part) => part?.type === 'tool-call');
}

function estimateAiMessageTokens(messages) {
  return Math.max(1, Math.floor((messages || []).reduce((total, message) => {
    try {
      return total + JSON.stringify(message).length;
    } catch {
      return total + 256;
    }
  }, 0) / 4));
}

function formatToolCallSummary(name, args = {}, result = '') {
  if (name === 'write_browser_file' || name === 'write_sandbox_file') {
    const path = typeof args.path === 'string' && args.path.trim() ? args.path : 'file';
    const contentSize = typeof args.content === 'string' ? ` (${formatBytes(args.content.length)})` : '';
    const target = name === 'write_browser_file' ? 'browser' : 'sandbox';
    return `${target}: ${path}${contentSize}`;
  }
  if (name === 'memory') return [args.action, args.type, args.id].filter(Boolean).join(' ');
  if (name === 'skill') {
    const target = [args.name, args.reference_name].filter(Boolean).join('/');
    const contentSize = args.action === 'write' && typeof args.content === 'string'
      ? ` (${formatBytes(args.content.length)})`
      : '';
    return [args.action, target || args.query].filter(Boolean).join(' ') + contentSize;
  }
  if (name !== 'spawn_agent') return undefined;

  const completedAgents = [];
  for (const match of String(result).matchAll(/(?:Sub-agent|Agent)\s+(.+?)\s+\(agent-[^)]+\)\s+completed/g)) {
    completedAgents.push(match[1]);
  }
  if (completedAgents.length) return completedAgents.join(', ');

  const tasks = Array.isArray(args.tasks) && args.tasks.length ? args.tasks : [args];
  return tasks.map((task, index) => {
    if (task.agent_id && task.agent_name) return `${task.agent_name} (${task.agent_id})`;
    if (task.agent_id) return task.agent_id;
    if (task.agent_name) return task.agent_name;
    return tasks.length > 1 ? `current agent task ${index + 1}` : 'current agent';
  }).join(', ');
}

function appendStreamingOutput(existing, chunk, streamName) {
  const combined = `${existing || ''}${chunk || ''}`;
  if (combined.length <= STREAMING_TOOL_OUTPUT_MAX_CHARS) return combined;
  const notice = `[${streamName} streaming output trimmed to latest ${STREAMING_TOOL_OUTPUT_MAX_CHARS} chars]\n`;
  const tailBudget = Math.max(1, STREAMING_TOOL_OUTPUT_MAX_CHARS - notice.length);
  return `${notice}${combined.slice(-tailBudget)}`;
}

function formatAbortResult(stdout, stderr) {
  let output = '';
  if (stdout) output += `Stdout:\n${stdout}`;
  if (stderr) output += `${output ? '\n' : ''}Stderr:\n${stderr}`;
  return `${output ? `${output}\n` : ''}Aborted`;
}

function runningToolStatus(name, args = {}) {
  return name === 'write_browser_file' || name === 'write_sandbox_file' || (name === 'skill' && args.action === 'write')
    ? 'writing'
    : 'running';
}

function formatDoomLoopBlock(toolName, threshold) {
  return [
    `Tool execution blocked: ${toolName} was requested ${threshold} consecutive times with identical input.`,
    'This call was not run to prevent a doom loop. Change the approach, inspect the prior result, or request explicit user approval before retrying.',
  ].join('\n');
}

async function requestToolApproval(handler, permission) {
  if (typeof handler !== 'function') return false;
  try {
    return (await handler(permission)) === true;
  } catch (err) {
    console.warn('Tool permission callback failed:', err?.message || err);
    return false;
  }
}

function createAgentRunId() {
  const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8)
    || Math.random().toString(36).slice(2, 10);
  return `run-${Date.now()}-${suffix}`;
}

function createAbortError(reason = 'aborted') {
  const error = new Error(String(reason || 'aborted'));
  error.name = 'AbortError';
  return error;
}

function asError(value) {
  return value instanceof Error ? value : new Error(String(value || 'Agent stream failed'));
}

function normalizeMaxRounds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_ROUNDS;
  return Math.min(Math.max(Math.floor(parsed), 1), ABSOLUTE_MAX_ROUNDS);
}

function normalizeModelMaxRetries(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_MODEL_MAX_RETRIES;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MODEL_MAX_RETRIES;
  return Math.min(Math.floor(parsed), ABSOLUTE_MODEL_MAX_RETRIES);
}

function enrichEmptyCauseMessage(error) {
  if (!error?.message || !/:\s*$/.test(error.message)) return error;
  const cause = error.cause;
  const detail = cause?.code
    || String(cause?.message || '').trim()
    || cause?.errors?.map((item) => item?.code || item?.message).find(Boolean);
  if (!detail) return error;
  try {
    error.message = `${error.message.trimEnd()} ${detail}`;
    return error;
  } catch {
    const enriched = new Error(`${error.message.trimEnd()} ${detail}`, { cause: error });
    enriched.name = error.name;
    return enriched;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

function addUsage(left, right) {
  const first = left || emptyUsage();
  const second = right || emptyUsage();
  return {
    prompt_tokens: first.prompt_tokens + second.prompt_tokens,
    completion_tokens: first.completion_tokens + second.completion_tokens,
    total_tokens: first.total_tokens + second.total_tokens,
  };
}

function buildUsageReport(latestUsage, totalUsage, contextWindow, modelCallCount) {
  const latest = latestUsage || totalUsage;
  if (!hasUsageTokens(latest)) return null;
  const total = totalUsage || latest;
  return {
    ...latest,
    content_len: contextWindow,
    turn_prompt_tokens: total.prompt_tokens,
    turn_completion_tokens: total.completion_tokens,
    turn_total_tokens: total.total_tokens,
    model_call_count: modelCallCount || 1,
  };
}

function emptyUsage() {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

function hasUsageTokens(usage) {
  return !!usage && (usage.prompt_tokens > 0 || usage.completion_tokens > 0 || usage.total_tokens > 0);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}
