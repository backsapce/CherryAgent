/**
 * Agent loop powered by Vercel AI SDK.
 *
 * `streamText` owns the model -> tool -> model loop. This module is the thin
 * VertexAgent adapter that provides its tools, context packing, bounded loop
 * policy, and a UI-safe event stream derived from AI SDK's `fullStream`.
 */

import { jsonSchema, stepCountIs, streamText, tool } from 'ai';
import llm from '../models/llm';
import { normalizeAiUsage, toModelMessages } from '../models/ai.js';
import { getEnabledToolSchemas, registry } from './tools.js';
import { assembleApiMessages } from './context.js';
import { loadMemory } from './memory.js';
import { buildSkillsSection } from './skills.js';
import { compactToolResultForModel } from './toolObservation.js';
import { createAgentEventState, applyAgentEvent } from './events.js';
import { getStaticContextWindow } from '../models/contextWindow.js';
import { readAgentAgentsFile } from '../vfs/opfs.js';
import { getAgent, getWorkspaceDirName } from '../agents/agents.js';

const DEFAULT_MAX_ROUNDS = 40;
const ABSOLUTE_MAX_ROUNDS = 80;
const MAX_CONTINUATION_GUARDS = 2;
const STREAMING_TOOL_OUTPUT_MAX_CHARS = 80_000;

const CONTINUATION_INTENT_RE =
  /\b(?:wait(?:ing)?|poll|check(?:ing)?|download(?:ing)?|compare|continue|next step|not (?:done|finished|complete)|after .*complete|once .*complete)\b|(?:等待|生成完成后|完成后|下载|对比|继续|下一步|稍后|轮生成任务)/i;

const PROMISED_TOOL_WORK_RE =
  /(?:\b(?:(?:i|we)(?:\s*(?:'|’)ll|\s+will|\s+(?:am|are)\s+going\s+to|\s+need\s+to|\s+should)|let\s+me|next(?:,?\s*(?:i|we)(?:\s*(?:'|’)ll|\s+will))?|now(?:,?\s*(?:i|we)(?:\s*(?:'|’)ll|\s+will))?|first(?:,?\s*(?:i|we)(?:\s*(?:'|’)ll|\s+will))?)\b[\s\S]{0,260}\b(?:inspect|check|read|list|open|search|scan|review|create|write|edit|modify|update|delete|move|copy|run|execute|test|build|install|generate|save|load|call|invoke|use)\b|(?:我(?:将|会|需要|应该)|先|接下来|现在)[\s\S]{0,120}(?:检查|读取|列出|搜索|创建|写入|修改|更新|运行|执行|测试|构建|保存|调用|使用))/i;

const CONTINUATION_GUARD_PROMPT =
  'You indicated the task still needs a later step, but you did not call a tool. Continue the task now. Do not describe future tool work. If a tool can inspect, read, list, create, write, run, check status, compare, or finish the work, call that tool in this response. Only provide a final answer when the requested task is actually complete.';

const FINALIZE_PROMPT =
  'The tool-use round limit has been reached. Stop using tools and provide the best final status now: what is complete, what changed, what was verified, and any remaining blockers.';

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
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.maxRounds]
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
    signal = null,
    subAgentDepth = 0,
  } = opts;

  const maxRounds = normalizeMaxRounds(opts.maxRounds);
  const workspaceDirName = agentId ? await getWorkspaceDirName(agentId) : null;
  const activeAgent = agentId ? await getAgent(agentId) : null;
  const memorySnapshot = await loadMemory(agentId);
  const skillsList = await buildSkillsSection(agentId);
  const agentIdentity = agentId ? await readAgentAgentsFile(agentId) : null;
  const contextWindow = opts.contextWindow || getStaticContextWindow(opts.provider, opts.model);
  const schemas = getEnabledToolSchemas({
    agentUrl,
    agentId,
    llmProfileId: opts.llmProfileId,
    subAgentDepth,
  });
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
    signal,
  };
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
  });

  let state = createAgentEventState();
  const emit = (event) => {
    state = applyAgentEvent(state, event);
    onEvent?.(event);
    onUpdate?.({
      content: state.content,
      thinking: state.thinking,
      toolCalls: state.toolCalls,
    });
  };

  const model = llm.getLanguageModel(opts.llmProfileId);
  const tools = createAgentTools(schemas, toolContext, emit);
  const initial = await consumeAgentStream({
    model,
    messages: toModelMessages(packed.apiMessages),
    system: packed.systemPrompt,
    tools,
    maxRounds,
    contextWindow,
    signal,
    emit,
  });

  let latestRun = initial;
  let responseMessages = [...initial.responseMessages];
  let latestUsage = initial.usage;
  let totalUsage = initial.totalUsage;
  let modelCallCount = initial.steps.length;
  let continuationGuardCount = 0;

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
      contextWindow,
      signal,
      emit,
    });
    latestRun = continuation;
    responseMessages.push(...continuation.responseMessages);
    latestUsage = continuation.usage || latestUsage;
    totalUsage = addUsage(totalUsage, continuation.totalUsage);
    modelCallCount += continuation.steps.length;
  }

  // `stepCountIs` ends on a tool-call step. Give the model one tool-free turn
  // to report a useful status, matching the old loop's bounded finalizer.
  if (latestRun.finishReason === 'tool-calls' && !signal?.aborted) {
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
      contextWindow,
      signal,
      emit,
    });
    latestUsage = finalizer.usage || latestUsage;
    totalUsage = addUsage(totalUsage, finalizer.totalUsage);
    modelCallCount += finalizer.steps.length;
  }

  throwIfAborted(signal);
  const usage = buildUsageReport(latestUsage, totalUsage, contextWindow, modelCallCount);
  emit({ type: 'finish', usage });

  return {
    content: state.content,
    thinking: state.thinking,
    toolCalls: state.toolCalls,
    usage,
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
        const scheduled = executionTail.then(() => executeAgentTool({
          toolCallId: execution.toolCallId,
          toolName: schema.name,
          input,
          signal: execution.abortSignal || toolContext.signal,
          toolContext,
          emit,
        }));
        executionTail = scheduled.catch(() => {});
        return scheduled;
      },
    }),
  ]));
}

async function executeAgentTool({ toolCallId, toolName, input, signal, toolContext, emit }) {
  let streamingStdout = '';
  let streamingStderr = '';
  const baseEvent = { toolCallId, toolName, input };

  const updateRunningOutput = (chunk) => {
    if (chunk?.stdout) streamingStdout = appendStreamingOutput(streamingStdout, chunk.stdout, 'stdout');
    if (chunk?.stderr) streamingStderr = appendStreamingOutput(streamingStderr, chunk.stderr, 'stderr');
    emit({
      type: 'tool-status',
      ...baseEvent,
      status: 'running',
      output: formatStreamingCommandResult(streamingStdout, streamingStderr),
    });
  };

  try {
    throwIfAborted(signal);
    const result = await registry.dispatch(toolName, input, {
      ...toolContext,
      signal,
      onToolUpdate: updateRunningOutput,
    });
    const output = String(result);
    const summary = formatToolCallSummary(toolName, input, output);
    emit({ type: 'tool-result', ...baseEvent, status: 'completed', output, summary });
    return compactToolResultForModel({ name: toolName, parsedArgs: input }, output, {
      contextWindow: toolContext.contextWindow,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
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

async function consumeAgentStream({ model, messages, system, tools, maxRounds, contextWindow, signal, emit }) {
  const result = streamText({
    model,
    messages,
    ...(system ? { system } : {}),
    ...(Object.keys(tools).length ? { tools, stopWhen: stepCountIs(maxRounds) } : {}),
    ...(signal ? { abortSignal: signal } : {}),
    prepareStep: ({ messages: stepMessages }) => {
      const compacted = compactAiMessages(stepMessages, contextWindow);
      return compacted === stepMessages ? undefined : { messages: compacted };
    },
    maxRetries: 0,
  });

  let finishReason = null;
  let currentStepHasText = false;
  let currentStepHasReasoning = false;

  for await (const part of result.fullStream) {
    throwIfAborted(signal);
    switch (part.type) {
      case 'start-step':
        currentStepHasText = false;
        currentStepHasReasoning = false;
        break;
      case 'text-delta':
        emit({
          type: 'text-delta',
          text: part.text,
          newSegment: !currentStepHasText,
        });
        currentStepHasText = true;
        break;
      case 'reasoning-delta':
        emit({
          type: 'reasoning-delta',
          text: part.text,
          newSegment: !currentStepHasReasoning,
        });
        currentStepHasReasoning = true;
        break;
      case 'tool-input-start':
        emit({ type: 'tool-input-start', toolCallId: part.id, toolName: part.toolName });
        break;
      case 'tool-input-delta':
        emit({ type: 'tool-input-delta', toolCallId: part.id, delta: part.delta });
        break;
      case 'tool-call':
        emit({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
          summary: formatToolCallSummary(part.toolName, part.input),
        });
        break;
      case 'tool-error':
        emit({
          type: 'tool-error',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          error: part.error,
        });
        break;
      case 'finish':
        finishReason = part.finishReason;
        break;
      case 'error':
        throw part.error;
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
  if (name === 'write_browser_file' || name === 'write_sandbox_file' || name === 'write_skill_file') {
    const path = typeof args.path === 'string' && args.path.trim() ? args.path : 'file';
    const contentSize = typeof args.content === 'string' ? ` (${formatBytes(args.content.length)})` : '';
    const target = name === 'write_browser_file' ? 'browser' : name === 'write_skill_file' ? 'skill' : 'sandbox';
    return `${target}: ${path}${contentSize}`;
  }
  if (name === 'memory') return [args.action, args.type, args.id].filter(Boolean).join(' ');
  if (name === 'skill') return [args.action, args.name, args.reference_name].filter(Boolean).join(' ');
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

function formatStreamingCommandResult(stdout, stderr) {
  let output = 'Running...';
  if (stdout) output += `\nStdout:\n${stdout}`;
  if (stderr) output += `\nStderr:\n${stderr}`;
  return output;
}

function formatAbortResult(stdout, stderr) {
  let output = '';
  if (stdout) output += `Stdout:\n${stdout}`;
  if (stderr) output += `${output ? '\n' : ''}Stderr:\n${stderr}`;
  return `${output ? `${output}\n` : ''}Aborted`;
}

function normalizeMaxRounds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_ROUNDS;
  return Math.min(Math.max(Math.floor(parsed), 1), ABSOLUTE_MAX_ROUNDS);
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
