/**
 * Agent loop: stream -> tool calls -> tool results -> continue until complete.
 */

import { getContext } from 'tokenlens';
import llm from '../models/llm';
import { getEnabledToolSchemas, registry } from './tools.js';
import { assembleApiMessages } from './context.js';
import { loadMemory } from './memory.js';
import { buildSkillsSection } from './skills.js';
import { compactToolResultForModel } from './toolObservation.js';
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
 * @param {Function} [opts.onUpdate]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.maxRounds]
 * @param {string} [opts.provider]
 * @param {string} [opts.model]
 * @param {number} [opts.contextWindow]
 * @param {string} [opts.llmProfileId]
 * @param {number} [opts.subAgentDepth]
 * @returns {Promise<{ content: string, thinking: string, toolCalls: Array, usage: Object|null }>}
 */
export async function runAgentLoop(opts) {
  const {
    messages = [],
    systemPrompt = '',
    agentUrl = null,
    agentId = null,
    onUpdate = () => {},
    signal = null,
    subAgentDepth = 0,
  } = opts;

  const maxRounds = normalizeMaxRounds(opts.maxRounds);
  const workspaceDirName = agentId ? await getWorkspaceDirName(agentId) : null;
  const activeAgent = agentId ? await getAgent(agentId) : null;
  const memorySnapshot = await loadMemory(agentId);
  const skillsList = await buildSkillsSection(agentId);
  const agentIdentity = agentId ? await readAgentAgentsFile(agentId) : null;
  const contextWindow = opts.contextWindow || getContextWindow(opts.provider, opts.model);
  const toolSchemas = getAvailableToolSchemas({
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

  const history = [...messages];
  const allToolCalls = {};
  let summaryState = { content: '', coveredUntil: 0 };
  let finalContent = '';
  let finalThinking = '';
  let displayContent = '';
  let displayThinking = '';
  let continuationGuardCount = 0;
  let completed = false;
  let exhaustedRounds = false;
  let usageTotals = emptyUsageTotals();
  let latestUsage = null;
  let usageCallCount = 0;

  for (let round = 0; round < maxRounds; round += 1) {
    throwIfAborted(signal);
    const packed = await assembleApiMessages({
      messages: history,
      systemPrompt,
      memorySnapshot,
      skillsList,
      agentIdentity,
      contextWindow,
      summaryState,
      llmProfileId: opts.llmProfileId,
      signal,
    });
    summaryState = packed.summaryState;

    const response = await streamAndCollect(
      packed.apiMessages,
      packed.systemPrompt,
      toolSchemas,
      {
        signal,
        onUpdate,
        llmProfileId: opts.llmProfileId,
        displayContent,
        displayThinking,
      }
    );

    displayContent = appendDisplaySegment(displayContent, response.content);
    displayThinking = appendDisplaySegment(displayThinking, response.thinking);
    finalContent = displayContent;
    finalThinking = displayThinking;
    if (hasUsageTokens(response.usage)) {
      latestUsage = normalizeUsage(response.usage);
      usageTotals = addUsage(usageTotals, latestUsage);
      usageCallCount += 1;
    }

    if (!response.toolCalls?.length) {
      if (
        shouldContinueWithoutToolCall({
          content: response.content,
          thinking: response.thinking,
          toolSchemas,
          toolCallsSoFar: Object.keys(allToolCalls).length,
          continuationGuardCount,
          round,
          maxRounds,
        })
      ) {
        continuationGuardCount += 1;
        history.push(buildAssistantMessage(response.content, response.thinking, []));
        history.push({ role: 'user', content: CONTINUATION_GUARD_PROMPT });
        continue;
      }
      completed = true;
      break;
    }

    continuationGuardCount = 0;
    registerToolCalls(response.toolCalls, allToolCalls);
    onUpdate({ content: displayContent, thinking: displayThinking, toolCalls: Object.values(allToolCalls) });

    const toolResults = await executeToolCalls(response.toolCalls, {
      allToolCalls,
      content: displayContent,
      thinking: displayThinking,
      onUpdate,
      toolContext,
    });

    history.push(buildAssistantMessage(response.content, response.thinking, response.toolCalls));
    history.push(...toolResults);
    onUpdate({ content: displayContent, thinking: displayThinking, toolCalls: Object.values(allToolCalls) });
  }

  if (!completed) {
    exhaustedRounds = true;
  }

  if (exhaustedRounds && !signal?.aborted) {
    history.push({ role: 'user', content: FINALIZE_PROMPT });
    const packed = await assembleApiMessages({
      messages: history,
      systemPrompt,
      memorySnapshot,
      skillsList,
      agentIdentity,
      contextWindow,
      summaryState,
      llmProfileId: opts.llmProfileId,
      signal,
    });
    summaryState = packed.summaryState;
    const response = await streamAndCollect(
      packed.apiMessages,
      packed.systemPrompt,
      [],
      {
        signal,
        onUpdate,
        llmProfileId: opts.llmProfileId,
        displayContent,
        displayThinking,
      }
    );
    displayContent = appendDisplaySegment(displayContent, response.content);
    displayThinking = appendDisplaySegment(displayThinking, response.thinking);
    finalContent = displayContent || finalContent;
    finalThinking = displayThinking || finalThinking;
    if (hasUsageTokens(response.usage)) {
      latestUsage = normalizeUsage(response.usage);
      usageTotals = addUsage(usageTotals, latestUsage);
      usageCallCount += 1;
    }
  }

  return {
    content: finalContent,
    thinking: finalThinking,
    toolCalls: Object.values(allToolCalls),
    usage: buildUsageReport(latestUsage, usageTotals, contextWindow, usageCallCount),
  };
}

// ─── Streaming ──────────────────────────────────────────────────────────────

async function streamAndCollect(apiMessages, systemPrompt, toolSchemas, opts) {
  let content = '';
  let thinking = '';
  const toolCallFragments = [];
  let usage = null;

  try {
    const requestOpts = {
      signal: opts.signal,
      llmProfileId: opts.llmProfileId,
      ...(toolSchemas?.length ? { tools: toolSchemas } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
    };

    for await (const chunk of llm.streamSession(apiMessages, requestOpts)) {
      if (typeof chunk === 'string') {
        content += chunk;
      } else {
        if (chunk.usage) {
          usage = normalizeUsage(chunk.usage, usage);
          continue;
        }
        if (chunk.content) content += chunk.content;
        if (chunk.reasoning) thinking += chunk.reasoning;
        if (chunk.toolCalls) {
          for (const tc of chunk.toolCalls) mergeToolFragment(toolCallFragments, tc);
        }
      }
      opts.onUpdate?.({
        content: appendDisplaySegment(opts.displayContent, content),
        thinking: appendDisplaySegment(opts.displayThinking, thinking),
        toolCalls: previewToolFragments(toolCallFragments),
      });
    }

    const completedToolCalls = finalizeToolCalls(toolCallFragments);
    return {
      content,
      thinking,
      toolCalls: completedToolCalls,
      completed: !completedToolCalls?.length,
      usage,
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { content, thinking, toolCalls: null, completed: true, usage };
    }
    throw err;
  }
}

function appendDisplaySegment(existing, segment) {
  const base = String(existing || '');
  const text = String(segment || '');
  if (!text) return base;
  if (!base) return text;
  const separator = base.endsWith('\n') || text.startsWith('\n') ? '' : '\n\n';
  return `${base}${separator}${text}`;
}

function mergeToolFragment(accumulator, fragment) {
  const idx = fragment.index ?? 0;
  if (!accumulator[idx]) {
    accumulator[idx] = { id: '', name: '', arguments: '' };
  }
  const existing = accumulator[idx];
  if (fragment.id) existing.id = fragment.id;
  if (fragment.name) existing.name = fragment.name;
  if (fragment.arguments) existing.arguments += fragment.arguments;
}

function previewToolFragments(fragments) {
  if (!fragments.length) return null;
  return fragments
    .filter((fragment) => fragment?.name)
    .map((fragment) => ({
      id: fragment.id || fragment.name || '',
      name: fragment.name,
      status: getInitialToolStatus(fragment.name),
    }));
}

function finalizeToolCalls(fragments) {
  const results = [];
  for (const fragment of Object.values(fragments)) {
    if (!fragment.name) continue;
    let parsedArgs = {};
    try {
      parsedArgs = fragment.arguments ? JSON.parse(fragment.arguments) : {};
    } catch {
      parsedArgs = { _raw: fragment.arguments };
    }
    results.push({
      id: fragment.id || createToolCallId(fragment.name),
      name: fragment.name,
      parsedArgs,
      rawArgs: fragment.arguments || '{}',
    });
  }
  return results.length > 0 ? results : null;
}

// ─── Tool execution ─────────────────────────────────────────────────────────

async function executeToolCalls(toolCalls, env) {
  if (toolCalls.length > 1 && toolCalls.every((tc) => registry.canRunInParallel(tc.name))) {
    return Promise.all(toolCalls.map((tc) => executeToolCall(tc, env)));
  }

  const results = [];
  for (const toolCall of toolCalls) {
    results.push(await executeToolCall(toolCall, env));
  }
  return results;
}

async function executeToolCall(toolCall, env) {
  const { allToolCalls, content, thinking, onUpdate, toolContext } = env;
  let streamingStdout = '';
  let streamingStderr = '';

  const updateRunningOutput = (chunk) => {
    if (!allToolCalls[toolCall.id]) return;
    if (chunk?.stdout) streamingStdout = appendStreamingOutput(streamingStdout, chunk.stdout, 'stdout');
    if (chunk?.stderr) streamingStderr = appendStreamingOutput(streamingStderr, chunk.stderr, 'stderr');
    allToolCalls[toolCall.id].result = formatStreamingCommandResult(streamingStdout, streamingStderr);
    allToolCalls[toolCall.id].status = 'running';
    onUpdate({ content, thinking, toolCalls: Object.values(allToolCalls) });
  };

  try {
    const result = await registry.dispatch(toolCall.name, toolCall.parsedArgs, {
      ...toolContext,
      onToolUpdate: updateRunningOutput,
    });
    const resultStr = String(result);
    const modelResultStr = compactToolResultForModel(toolCall, resultStr, {
      contextWindow: toolContext.contextWindow,
    });
    updateToolCall(allToolCalls, toolCall, {
      status: 'completed',
      result: resultStr,
      summary: formatToolCallSummary(toolCall, resultStr),
    });
    onUpdate({ content, thinking, toolCalls: Object.values(allToolCalls) });
    return buildToolResultMessage(toolCall, modelResultStr);
  } catch (err) {
    if (err.name === 'AbortError') {
      const abortStr = formatAbortResult(streamingStdout, streamingStderr);
      updateToolCall(allToolCalls, toolCall, {
        status: 'aborted',
        result: abortStr,
        summary: formatToolCallSummary(toolCall),
      });
      onUpdate({ content, thinking, toolCalls: Object.values(allToolCalls) });
      throw err;
    }
    const errStr = `Error: ${err.message}`;
    const modelErrStr = compactToolResultForModel(toolCall, errStr, {
      contextWindow: toolContext.contextWindow,
    });
    updateToolCall(allToolCalls, toolCall, {
      status: 'error',
      result: errStr,
      summary: formatToolCallSummary(toolCall),
    });
    onUpdate({ content, thinking, toolCalls: Object.values(allToolCalls) });
    return buildToolResultMessage(toolCall, modelErrStr);
  }
}

function registerToolCalls(toolCalls, allToolCalls) {
  for (const toolCall of toolCalls) {
    allToolCalls[toolCall.id] = {
      id: toolCall.id,
      name: toolCall.name,
      parsedArgs: toolCall.parsedArgs,
      rawArgs: toolCall.rawArgs,
      status: getInitialToolStatus(toolCall.name),
      command: getToolCallCommand(toolCall),
      summary: formatToolCallSummary(toolCall),
    };
  }
}

function updateToolCall(allToolCalls, toolCall, patch) {
  if (!allToolCalls[toolCall.id]) return;
  allToolCalls[toolCall.id] = {
    ...allToolCalls[toolCall.id],
    ...patch,
  };
}

function buildAssistantMessage(content, thinking, toolCalls) {
  return {
    role: 'assistant',
    content: content || '',
    ...(thinking ? { reasoning_content: thinking } : {}),
    ...(toolCalls?.length ? {
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.rawArgs || '{}',
      })),
    } : {}),
  };
}

function buildToolResultMessage(toolCall, result) {
  return {
    role: 'tool',
    tool_call_id: toolCall.id,
    name: toolCall.name,
    content: String(result),
  };
}

// ─── Small helpers ──────────────────────────────────────────────────────────

function getAvailableToolSchemas(context) {
  return getEnabledToolSchemas(context);
}

function shouldContinueWithoutToolCall({
  content,
  thinking,
  toolSchemas,
  toolCallsSoFar,
  continuationGuardCount,
  round,
  maxRounds,
}) {
  if (!toolSchemas?.length) return false;
  if (continuationGuardCount >= MAX_CONTINUATION_GUARDS) return false;
  if (round >= maxRounds - 1) return false;

  const text = `${content || ''}\n${thinking || ''}`;
  if (toolCallsSoFar > 0 && CONTINUATION_INTENT_RE.test(text)) return true;
  return PROMISED_TOOL_WORK_RE.test(text);
}

function getInitialToolStatus(name) {
  return name === 'write_browser_file' || name === 'write_sandbox_file' || name === 'write_skill_file'
    ? 'writing'
    : 'running';
}

function getToolCallCommand(toolCall) {
  if (toolCall.name !== 'execute_command') return undefined;
  const command = toolCall.parsedArgs?.command;
  return typeof command === 'string' && command.trim() ? command : undefined;
}

function formatToolCallSummary(toolCall, result = '') {
  const args = toolCall.parsedArgs || {};
  if (toolCall.name === 'write_browser_file' || toolCall.name === 'write_sandbox_file' || toolCall.name === 'write_skill_file') {
    const path = typeof args.path === 'string' && args.path.trim() ? args.path : 'file';
    const contentSize = typeof args.content === 'string' ? ` (${formatBytes(args.content.length)})` : '';
    let target = 'sandbox';
    if (toolCall.name === 'write_browser_file') target = 'browser';
    if (toolCall.name === 'write_skill_file') target = 'skill';
    return `${target}: ${path}${contentSize}`;
  }
  if (toolCall.name === 'memory') {
    return [args.action, args.type, args.id].filter(Boolean).join(' ');
  }
  if (toolCall.name === 'skill') {
    return [args.action, args.name, args.reference_name].filter(Boolean).join(' ');
  }
  if (toolCall.name !== 'spawn_agent') return undefined;

  const completedAgents = [];
  const matches = String(result).matchAll(/(?:Sub-agent|Agent)\s+(.+?)\s+\((agent-[^)]+)\)\s+completed/g);
  for (const match of matches) completedAgents.push(`${match[1]} (${match[2]})`);
  if (completedAgents.length > 0) return completedAgents.join(', ');

  const taskTargets = Array.isArray(args.tasks) && args.tasks.length > 0 ? args.tasks : [args];
  return taskTargets.map((task, index) => {
    if (task.agent_id && task.agent_name) return `${task.agent_name} (${task.agent_id})`;
    if (task.agent_id) return task.agent_id;
    if (task.agent_name) return task.agent_name;
    return taskTargets.length > 1 ? `current agent task ${index + 1}` : 'current agent';
  }).join(', ');
}

function formatStreamingCommandResult(stdout, stderr) {
  let out = 'Running...';
  if (stdout) out += `\nStdout:\n${stdout}`;
  if (stderr) out += `\nStderr:\n${stderr}`;
  return out;
}

function appendStreamingOutput(existing, chunk, streamName) {
  const combined = `${existing || ''}${chunk || ''}`;
  if (combined.length <= STREAMING_TOOL_OUTPUT_MAX_CHARS) return combined;
  const notice = `[${streamName} streaming output trimmed to latest ${STREAMING_TOOL_OUTPUT_MAX_CHARS} chars]\n`;
  const tailBudget = Math.max(1, STREAMING_TOOL_OUTPUT_MAX_CHARS - notice.length);
  return `${notice}${combined.slice(-tailBudget)}`;
}

function formatAbortResult(stdout, stderr) {
  let out = '';
  if (stdout) out += `Stdout:\n${stdout}`;
  if (stderr) out += `${out ? '\n' : ''}Stderr:\n${stderr}`;
  return `${out ? `${out}\n` : ''}Aborted`;
}

function createToolCallId(name) {
  const random = globalThis.crypto?.randomUUID?.().slice(0, 8)
    || Math.random().toString(36).slice(2, 10);
  return `tc-${name}-${Date.now()}-${random}`;
}

function normalizeMaxRounds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_ROUNDS;
  return Math.min(Math.max(Math.floor(parsed), 1), ABSOLUTE_MAX_ROUNDS);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

function emptyUsageTotals() {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
}

function addUsage(total, usage) {
  if (!usage) return total;
  const normalized = normalizeUsage(usage);
  return {
    prompt_tokens: total.prompt_tokens + normalized.prompt_tokens,
    completion_tokens: total.completion_tokens + normalized.completion_tokens,
    total_tokens: total.total_tokens + normalized.total_tokens,
  };
}

function buildUsageReport(latestUsage, usageTotals, contextWindow, usageCallCount) {
  const latest = latestUsage || (hasUsageTokens(usageTotals) ? normalizeUsage(usageTotals) : null);
  if (!hasUsageTokens(latest)) return null;

  const turn = hasUsageTokens(usageTotals) ? normalizeUsage(usageTotals) : latest;
  return {
    ...latest,
    content_len: contextWindow,
    turn_prompt_tokens: turn.prompt_tokens,
    turn_completion_tokens: turn.completion_tokens,
    turn_total_tokens: turn.total_tokens,
    model_call_count: usageCallCount || 1,
  };
}

function hasUsageTokens(usage) {
  if (!usage) return false;
  const normalized = normalizeUsage(usage);
  return normalized.prompt_tokens > 0
    || normalized.completion_tokens > 0
    || normalized.total_tokens > 0;
}

function normalizeUsage(usage, previous = null) {
  const prompt = usage.prompt_tokens
    ?? usage.input_tokens
    ?? usage.promptTokenCount
    ?? usage.inputTokenCount
    ?? 0;
  const completion = usage.completion_tokens
    ?? usage.output_tokens
    ?? usage.outputTokenCount
    ?? usage.candidatesTokenCount
    ?? 0;
  const total = usage.total_tokens
    ?? usage.totalTokenCount
    ?? (prompt + completion);
  if (previous && total < previous.total_tokens) return previous;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
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

// Map app provider IDs to tokenlens provider prefixes
const TOKENLENS_PROVIDER = {
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'google',
  qwen: 'alibaba',
  openrouter: 'openrouter',
  deepseek: 'deepseek',
};

const FALLBACK_WINDOWS = {
  anthropic: 200_000,
  openai: 128_000,
  gemini: 1_000_000,
  openrouter: 128_000,
  qwen: 1_000_000,
  deepseek: 128_000,
  'custom-openai': 128_000,
};

function modelFallbackWindow(model) {
  const m = model?.toLowerCase() || '';
  if (m.startsWith('qwen3.5') || m.startsWith('qwen3-5')) return 1_000_000;
  if (m.startsWith('qwen3.6') || m.startsWith('qwen3-6')) return 1_000_000;
  if (m.startsWith('qwen3-') || m.startsWith('qwen-m') || m.startsWith('qwen-p')) return 262_144;
  if (m === 'qwen-turbo') return 262_144;
  if (m.startsWith('deepseek-v4-')) return 1_000_000;
  if (m.startsWith('deepseek-')) return 128_000;
  return null;
}

function getContextWindow(provider, model) {
  if (model) {
    const tlProvider = TOKENLENS_PROVIDER[provider];
    const ids = [];
    if (tlProvider) {
      ids.push(`${tlProvider}:${model}`);
      ids.push(`${tlProvider}:${model.replace(/(\d)\.(\d)/g, '$1-$2')}`);
    }
    ids.push(model);
    ids.push(model.replace(/(\d)\.(\d)/g, '$1-$2'));

    for (const mid of ids) {
      try {
        const ctx = getContext({ modelId: mid });
        if (ctx.maxTotal || ctx.combinedMax) return ctx.maxTotal || ctx.combinedMax;
      } catch { /* tokenlens miss */ }
    }

    const modelWindow = modelFallbackWindow(model);
    if (modelWindow) return modelWindow;
  }

  return FALLBACK_WINDOWS[provider] || 128_000;
}
