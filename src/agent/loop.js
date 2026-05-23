/**
 * Agent Running Loop — multi-turn tool execution engine.
 *
 * Inspired by Hermes Agent's run_conversation() loop.
 *
 * Flow:
 * 1. Build context (apply sliding window + tool schemas + memory + skills)
 * 2. Stream LLM response with tool schemas
 * 3. Extract tool calls from response
 * 4. If tool calls: execute them, append results, go to step 2
 * 5. If no tool calls: loop ends, return final response
 * 6. Max rounds: configurable (default 10)
 *
 * Usage:
 *   import { runAgentLoop } from './agent/loop';
 *
 *   const result = await runAgentLoop({
 *     messages: sessionMessages,
 *     systemPrompt: basePrompt,
 *     agentUrl: 'http://localhost:3099',
 *     onUpdate: ({ content, thinking, toolCalls }) => { ... },
 *     signal: controller.signal,
 *   });
 *   // result.content, result.thinking, result.toolCalls
 */

import { getContext } from 'tokenlens';
import llm from '../models/llm';
import { getEnabledToolSchemas, registry } from './tools.js';
import { assembleApiMessages } from './context.js';
import { loadMemory } from './memory.js';
import { buildSkillsSection } from './skills.js';
import { readAgentAgentsFile } from '../vfs/opfs.js';
import { getAgent, getWorkspaceDirName } from '../agents/agents.js';

const DEFAULT_MAX_ROUNDS = 10;

/**
 * Run the agent loop for a session.
 *
 * @param {Object} opts
 * @param {Array} opts.messages - Current session messages
 * @param {string} opts.systemPrompt - Base system prompt
 * @param {string} [opts.agentUrl] - Agent server URL (null if no agent)
 * @param {string} [opts.agentId] - Agent workspace ID (for memory/file scoping)
 * @param {Function} [opts.onUpdate] - Callback for streaming updates
 * @param {AbortSignal} [opts.signal] - Abort signal for cancellation
 * @param {number} [opts.maxRounds] - Max tool execution rounds (default 10)
 * @param {string} [opts.provider] - Provider id for context window estimation
 * @param {string} [opts.model] - Model id for accurate context window lookup
 * @param {number} [opts.contextWindow] - Persisted model context window from profile metadata
 * @param {string} [opts.llmProfileId] - LLM profile id to use for this run
 * @param {number} [opts.subAgentDepth] - Internal guard for delegated agent runs
 * @returns {Promise<{ content: string, thinking: string, toolCalls: Array }>}
 */
export async function runAgentLoop(opts) {
  const {
    messages,
    systemPrompt,
    agentUrl = null,
    agentId = null,
    onUpdate = () => {},
    signal = null,
    maxRounds = DEFAULT_MAX_ROUNDS,
    subAgentDepth = 0,
  } = opts;

  // Resolve workspace directory name from agent's current display name
  const workspaceDirName = agentId ? await getWorkspaceDirName(agentId) : null;
  const activeAgent = agentId ? await getAgent(agentId) : null;

  // Load memory snapshot (frozen for this session)
  const memorySnapshot = await loadMemory(agentId);
  // Load skills list (global + agent-specific)
  const skillsList = await buildSkillsSection(agentId);
  // Load agent identity (AGENTS.md)
  const agentIdentity = agentId ? await readAgentAgentsFile(agentId) : null;

  // Context window by provider + model (tokenlens with fallback)
  const contextWindow = opts.contextWindow || getContextWindow(opts.provider, opts.model);

  // Track accumulated tool calls for this agent loop invocation
  const allToolCalls = {}; // id -> { id, name, status, result? }
  let finalContent = '';
  let finalThinking = '';
  // Accumulate usage across rounds (prompt_tokens grows each round)
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;

  // Build the API messages with context management
  let { apiMessages, systemPrompt: finalSystemPrompt } =
    await assembleApiMessages({
      messages,
      systemPrompt,
      memorySnapshot,
      skillsList,
      agentIdentity,
      contextWindow,
    });

  // Get tool schemas (filter by availability)
  const toolSchemas = getAvailableToolSchemas({
    agentUrl,
    agentId,
    llmProfileId: opts.llmProfileId,
    subAgentDepth,
  });

  for (let round = 0; round <= maxRounds; round++) {
    // Stream LLM response
    const { content, thinking, toolCalls, usage } = await streamAndCollect(
      apiMessages,
      finalSystemPrompt,
      toolSchemas,
      { signal, onUpdate, llmProfileId: opts.llmProfileId }
    );

    finalContent = content;
    finalThinking = thinking;

    // Accumulate usage stats across rounds
    if (usage) {
      totalPromptTokens += usage.prompt_tokens || 0;
      totalCompletionTokens += usage.completion_tokens || usage.output_tokens || 0;
      totalTokens += usage.total_tokens || 0;
    }

    // No tool calls — we're done
    if (!toolCalls || toolCalls.length === 0) {
      break;
    }

    // Record tool calls by id (deduplicate)
    for (const tc of toolCalls) {
      allToolCalls[tc.id] = {
        id: tc.id,
        name: tc.name,
        status: 'running',
        command: getToolCallCommand(tc),
        summary: formatToolCallSummary(tc),
      };
    }
    onUpdate({ content, thinking, toolCalls: Object.values(allToolCalls) });

    // Execute tool calls and build results
    const executeToolCall = async (tc) => {
      let streamingStdout = '';
      let streamingStderr = '';
      try {
        const result = await registry.dispatch(tc.name, tc.parsedArgs, {
          agentUrl,
          agentId,
          agentName: activeAgent?.name || workspaceDirName,
          agentWorkspace: workspaceDirName,
          llmProfileId: opts.llmProfileId,
          provider: opts.provider,
          model: opts.model,
          contextWindow: opts.contextWindow,
          subAgentDepth,
          signal,
          onToolUpdate: (chunk) => {
            if (!allToolCalls[tc.id]) return;
            if (chunk?.stdout) streamingStdout += chunk.stdout;
            if (chunk?.stderr) streamingStderr += chunk.stderr;
            let streamingResult = 'Running...';
            if (streamingStdout) streamingResult += `\nStdout:\n${streamingStdout}`;
            if (streamingStderr) streamingResult += `\nStderr:\n${streamingStderr}`;
            allToolCalls[tc.id].result = streamingResult;
            allToolCalls[tc.id].status = 'running';
            onUpdate({ content, thinking, toolCalls: Object.values(allToolCalls) });
          },
        });
        const resultStr = String(result);
        // Update tracking with result
        if (allToolCalls[tc.id]) {
          allToolCalls[tc.id].status = 'completed';
          allToolCalls[tc.id].result = resultStr;
          allToolCalls[tc.id].summary = formatToolCallSummary(tc, resultStr);
        }
        onUpdate({ content, thinking, toolCalls: Object.values(allToolCalls) });
        return {
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.name,
          content: resultStr,
        };
      } catch (err) {
        if (err.name === 'AbortError') {
          let abortStr = 'Aborted';
          if (streamingStdout || streamingStderr) {
            abortStr = '';
            if (streamingStdout) abortStr += `Stdout:\n${streamingStdout}`;
            if (streamingStderr) abortStr += `${abortStr ? '\n' : ''}Stderr:\n${streamingStderr}`;
            abortStr += `${abortStr ? '\n' : ''}Aborted`;
          }
          if (allToolCalls[tc.id]) {
            allToolCalls[tc.id].status = 'aborted';
            allToolCalls[tc.id].result = abortStr;
            allToolCalls[tc.id].summary = formatToolCallSummary(tc);
          }
          onUpdate({ content, thinking, toolCalls: Object.values(allToolCalls) });
          throw err;
        }
        const errStr = `Error: ${err.message}`;
        if (allToolCalls[tc.id]) {
          allToolCalls[tc.id].status = 'error';
          allToolCalls[tc.id].result = errStr;
          allToolCalls[tc.id].summary = formatToolCallSummary(tc);
        }
        onUpdate({ content, thinking, toolCalls: Object.values(allToolCalls) });
        return {
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.name,
          content: errStr,
        };
      }
    };

    let toolResults = [];
    const canRunInParallel =
      toolCalls.length > 1 && toolCalls.every((tc) => tc.name === 'execute_command');
    if (canRunInParallel) {
      toolResults = await Promise.all(toolCalls.map((tc) => executeToolCall(tc)));
    } else {
      for (const tc of toolCalls) {
        toolResults.push(await executeToolCall(tc));
      }
    }

    // Notify UI of tool results (as array)
    onUpdate({ content, thinking, toolCalls: Object.values(allToolCalls) });

    // Append assistant message and tool results to apiMessages
    apiMessages = [
      ...apiMessages,
      {
        role: 'assistant',
        content,
        ...(thinking ? { reasoning_content: thinking } : {}),
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.rawArgs || '{}',
        })),
      },
      ...toolResults,
    ];

    // Continue loop — but first check if context needs compression
    const ctxResult = await assembleApiMessages({
      messages: apiMessages,
      systemPrompt: systemPrompt,
      memorySnapshot,
      skillsList,
      agentIdentity,
      contextWindow,
    });
    apiMessages = ctxResult.apiMessages;
    finalSystemPrompt = ctxResult.systemPrompt;
  }

  const usageSummary = totalTokens > 0 ? {
    prompt_tokens: totalPromptTokens,
    completion_tokens: totalCompletionTokens,
    total_tokens: totalTokens,
    content_len: contextWindow,
  } : null;

  return { content: finalContent, thinking: finalThinking, toolCalls: Object.values(allToolCalls), usage: usageSummary };
}

/**
 * Stream LLM response and collect all content + tool calls.
 *
 * @param {Array} apiMessages
 * @param {string} systemPrompt
 * @param {Array} toolSchemas
 * @param {Object} opts - { signal, onUpdate }
 * @returns {Promise<{ content: string, thinking: string, toolCalls: Array|null, completed: boolean, usage?: Object }>}
 */
async function streamAndCollect(apiMessages, systemPrompt, toolSchemas, opts) {
  let content = '';
  let thinking = '';
  const toolCallFragments = []; // { id, name, arguments }
  let usage = null;

  try {
    const requestOpts = {
      signal: opts.signal,
      llmProfileId: opts.llmProfileId,
    };

    // Add tool schemas if available
    if (toolSchemas?.length) {
      requestOpts.tools = toolSchemas;
    }

    // Add system prompt
    if (systemPrompt) {
      requestOpts.systemPrompt = systemPrompt;
    }

    for await (const chunk of llm.streamSession(apiMessages, requestOpts)) {
      if (typeof chunk === 'string') {
        content += chunk;
        opts.onUpdate?.({ content, thinking, toolCalls: null });
      } else {
        // Usage data from API (final chunk when stream_options.include_usage = true)
        if (chunk.usage) {
          usage = chunk.usage;
          continue;
        }
        if (chunk.content) {
          content += chunk.content;
        }
        if (chunk.reasoning) {
          thinking += chunk.reasoning;
        }
        if (chunk.toolCalls) {
          for (const tc of chunk.toolCalls) {
            // Merge fragments by index
            mergeToolFragment(toolCallFragments, tc);
          }
        }
        opts.onUpdate?.({
          content,
          thinking,
          toolCalls: toolCallFragments.map((f) => ({ id: f.id || '', name: f.name })),
        });
      }
    }

    // Parse complete tool calls from fragments
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
      return { content, thinking, toolCalls: null, completed: true };
    }
    throw err;
  }
}

/**
 * Merge a tool call fragment into the accumulator.
 * Handles both OpenAI-style (index-based) and Anthropic-style fragments.
 */
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

/**
 * Finalize accumulated tool call fragments into complete tool calls.
 */
function finalizeToolCalls(fragments) {
  const results = [];
  for (const f of Object.values(fragments)) {
    if (!f.name) continue;
    let parsedArgs = {};
    try {
      parsedArgs = f.arguments ? JSON.parse(f.arguments) : {};
    } catch {
      // If arguments are incomplete JSON, try to parse as much as possible
      parsedArgs = { _raw: f.arguments };
    }
    results.push({
      id: f.id || `tc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: f.name,
      parsedArgs,
      rawArgs: f.arguments,
    });
  }
  return results.length > 0 ? results : null;
}

/**
 * Get available tool schemas filtered by availability.
 */
function getAvailableToolSchemas(context) {
  return getEnabledToolSchemas(context);
}

function getToolCallCommand(toolCall) {
  if (toolCall.name !== 'execute_command') return undefined;

  const command = toolCall.parsedArgs?.command;
  return typeof command === 'string' && command.trim() ? command : undefined;
}

function formatToolCallSummary(toolCall, result = '') {
  if (toolCall.name !== 'spawn_agent') return undefined;

  const completedAgents = [];
  const matches = String(result).matchAll(/(?:Sub-agent|Agent)\s+(.+?)\s+\((agent-[^)]+)\)\s+completed/g);
  for (const match of matches) {
    completedAgents.push(`${match[1]} (${match[2]})`);
  }
  if (completedAgents.length > 0) return completedAgents.join(', ');

  const args = toolCall.parsedArgs || {};
  const taskTargets = Array.isArray(args.tasks) && args.tasks.length > 0
    ? args.tasks
    : [args];

  const targets = taskTargets.map((task, index) => {
    if (task.agent_id && task.agent_name) return `${task.agent_name} (${task.agent_id})`;
    if (task.agent_id) return task.agent_id;
    if (task.agent_name) return task.agent_name;
    return taskTargets.length > 1 ? `current agent task ${index + 1}` : 'current agent';
  });

  return targets.join(', ');
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

// Fallback context windows when tokenlens doesn't have the model
const FALLBACK_WINDOWS = {
  anthropic: 200_000,
  openai: 128_000,
  gemini: 1_000_000,
  openrouter: 128_000,
  qwen: 1_000_000,
  deepseek: 128_000,
  'custom-openai': 128_000,
};

// Per-model overrides for known models not yet in tokenlens
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

/**
 * Get the context window size for a provider/model pair.
 * Tries tokenlens catalog first, falls back to model-specific, then provider defaults.
 */
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
        if (ctx.maxTotal || ctx.combinedMax) {
          return ctx.maxTotal || ctx.combinedMax;
        }
      } catch { /* tokenlens miss — try next id */ }
    }

    const modelWindow = modelFallbackWindow(model);
    if (modelWindow) return modelWindow;
  }

  return FALLBACK_WINDOWS[provider] || 128_000;
}
