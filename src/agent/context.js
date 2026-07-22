/**
 * Context assembly for the agent loop.
 *
 * The packer keeps a small stable head, a compact summary of the older middle,
 * and the freshest tail that fits the model budget. Unlike the previous
 * sliding window, the summary is actually generated and tracked by message
 * index so the same turns are not summarized repeatedly.
 */

import llm from '../models/llm.js';
import { buildMemorySection } from './memory.js';
import { COMMAND_EXECUTION_GUIDANCE } from './commandGuidance.js';

const CONTEXT_WINDOW_FALLBACK = 128_000;
const PACKING_THRESHOLD_RATIO = 0.72;
const HEAD_PROTECT = 4;
const MIN_TAIL_KEEP = 8;
const PREFERRED_TAIL_KEEP = 36;
const RESPONSE_RESERVE_RATIO = 0.14;
const MIN_RESPONSE_RESERVE = 4096;
const MAX_RESPONSE_RESERVE = 24_000;
const TOKENS_PER_CHAR = 4;
const MAX_SUMMARY_SOURCE_CHARS = 80_000;

const AGENT_RUNTIME_PROMPT = `You are VertexAgent, an autonomous coding and browser-work agent.

Filesystem model:
- Browser OPFS is the durable VertexAgent storage backend, but browser file tools do NOT expose the OPFS root.
- Browser file tools can read/write only the active agent's own files area: workspace/<active-agent>/files/.
- Browser file tools cannot access other agents, OPFS root files, AGENTS.md, memory files, or skill files by path.
- Use the skill tool for the enabled skill catalog and skill reads. When explicitly creating or editing a skill, use skill file tools under workspace/<active-agent>/skills/.
- The sandbox filesystem is a separate runtime workdir for command tools. It is useful for running commands, builds, tests, and temporary generated files.
- Active agent files and sandbox workdir files do not automatically sync. Choose browser file tools for workspace/<active-agent>/files/, sandbox file tools for command-runtime files, and explicitly copy content between them when needed.
- Never infer that a path seen in the sandbox exists in the active agent files area, or that an active agent file path exists in the sandbox.
- Display real images only by calling display_browser_image or display_sandbox_image with the file path. Never put image bytes, binary data, base64, data URLs, or Markdown/HTML image tags for local files in the conversation.

Operating rules:
- Work from evidence. Inspect files, command output, tool results, and provided context before making risky changes.
- Keep going until the user's request is genuinely handled or a real blocker requires user input.
- Do not answer with a promise like "I will inspect/read/create/run". If the next step needs a tool, call the tool in the same response.
- Prefer small, reversible edits and clear verification. Do not hide failures; use them to choose the next step.
- Use memory only for durable facts, preferences, and project conventions that are likely to matter in future sessions.
- Use skills as just-in-time procedures: list/search when needed, read the relevant skill before relying on it, and avoid loading unrelated references.
- A user message beginning with /<skill-name> explicitly selects that enabled skill. Read the named skill before acting, follow it for this turn, and treat the text after the command as the user's task. If the named skill does not exist or is disabled, explain that briefly instead of silently substituting another skill.
- Treat tool output as authoritative over assumptions. If context is summarized, rely on the live tail for the latest state.`;

const AGENT_RUNTIME_PROMPT_WITH_COMMANDS = `${AGENT_RUNTIME_PROMPT}\n\n${COMMAND_EXECUTION_GUIDANCE}`;

const SANDBOX_RUNTIME_PROMPT = `You are VertexAgent running entirely inside a persistent sandbox runtime.

Runtime isolation:
- The agent loop, model calls, tool calls, and filesystem operations all run in this sandbox.
- Browser state, browser OPFS, browser files, browser actions, and other browser-only tools are unavailable and invisible.
- The only visible filesystem is the sandbox workspace. Use sandbox file tools and command tools for all inspection and changes.
- Browser memory is not copied into this runtime. At run startup, browser-backed AGENTS.md and enabled skills are copied into the sandbox only when their destination paths do not already exist; their identity and compact catalog are also included below in this prompt.
- The browser is only a client that may disconnect and later replay this run's persisted event log and result.
- Display real images only with display_sandbox_image and their sandbox file path. Never put image bytes, binary data, base64, data URLs, or Markdown/HTML image tags for local files in the conversation.

Operating rules:
- Work from evidence and continue until the request is handled or a real blocker requires user input.
- Do not promise future tool work; call an available tool in the same response.
- Prefer small, reversible edits, verify important changes, and report failures honestly.
- A user message beginning with /<skill-name> explicitly selects that enabled skill. Read skills/<skill-name>/SKILL.md before acting, follow it for this turn, and treat the text after the command as the user's task. If the named skill is unavailable, explain that briefly instead of silently substituting another skill.

${COMMAND_EXECUTION_GUIDANCE}`;

/**
 * Backward-compatible helper. Returns packed messages and system prompt.
 */
export async function buildContext(opts) {
  const result = await assembleApiMessages(opts);
  return {
    messages: result.apiMessages,
    systemPrompt: result.systemPrompt,
    compressed: result.compressed,
    summaryState: result.summaryState,
  };
}

/**
 * Build provider-safe messages plus the full system prompt.
 *
 * @param {Object} opts
 * @param {Array} opts.messages
 * @param {string} opts.systemPrompt
 * @param {{ memory: string|null, user: string|null }} [opts.memorySnapshot]
 * @param {string} [opts.skillsList]
 * @param {string} [opts.agentIdentity]
 * @param {number} [opts.contextWindow]
 * @param {{ content?: string, coveredUntil?: number }} [opts.summaryState]
 * @param {string} [opts.summary] Legacy summary text.
 * @param {string} [opts.llmProfileId]
 * @param {AbortSignal} [opts.signal]
 * @param {boolean} [opts.autoSummarize=true]
 * @returns {Promise<{ apiMessages: Array, systemPrompt: string, compressed: boolean, summaryState: Object, estimatedTokens: number }>}
 */
export async function assembleApiMessages(opts) {
  const {
    messages = [],
    systemPrompt = '',
    memorySnapshot,
    skillsList = '',
    agentIdentity = null,
    contextWindow = CONTEXT_WINDOW_FALLBACK,
    llmProfileId,
    signal,
    autoSummarize = true,
    runtimeMode = 'browser',
  } = opts;

  const fullSystemPrompt = buildSystemPrompt({
    systemPrompt,
    memorySnapshot,
    skillsList,
    agentIdentity,
    runtimeMode,
  });
  let summaryState = normalizeSummaryState(opts.summaryState, opts.summary);
  let packed = packMessages(messages, fullSystemPrompt, contextWindow, summaryState);

  let summaryPasses = 0;
  while (autoSummarize && packed.needsSummary && summaryPasses < 3) {
    summaryPasses += 1;
    const start = Math.max(packed.summaryStart, summaryState.coveredUntil || packed.summaryStart);
    const end = packed.summaryEnd;
    const newMessages = messages.slice(start, end);
    if (newMessages.length === 0) break;
    const summary = await summarizeMiddle(newMessages, summaryState.content, {
      llmProfileId,
      signal,
    });
    summaryState = {
      content: summary,
      coveredUntil: end,
    };
    packed = packMessages(messages, fullSystemPrompt, contextWindow, summaryState);
  }

  return {
    apiMessages: packed.apiMessages,
    systemPrompt: fullSystemPrompt,
    compressed: packed.compressed,
    summaryState,
    estimatedTokens: packed.estimatedTokens,
  };
}

/**
 * Summarize dropped messages and merge into an existing running summary.
 *
 * @param {Array} middleMessages
 * @param {string} existingSummary
 * @param {{ llmProfileId?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<string>}
 */
export async function summarizeMiddle(middleMessages, existingSummary = '', opts = {}) {
  if (!middleMessages?.length) return existingSummary || '';

  const formatted = truncateText(formatMessages(middleMessages), MAX_SUMMARY_SOURCE_CHARS);
  const prompt = existingSummary
    ? [
      'Update the running conversation summary for an autonomous agent.',
      'Preserve only durable state: user requests, completed work, files touched, tool findings, decisions, blockers, and remaining TODOs.',
      'Do not include generic chit-chat. Keep it concise but specific enough to resume work.',
      '',
      '<existing_summary>',
      existingSummary,
      '</existing_summary>',
      '',
      '<new_turns>',
      formatted,
      '</new_turns>',
    ].join('\n')
    : [
      'Summarize these earlier conversation turns for an autonomous agent.',
      'Include: the active task, completed actions, important files/commands/results, decisions, blockers, and pending work.',
      'Keep it concise, factual, and ordered from oldest to newest where useful.',
      '',
      '<turns>',
      formatted,
      '</turns>',
    ].join('\n');

  try {
    const summary = await llm.completeSession(
      [{ role: 'user', content: prompt }],
      {
        llmProfileId: opts.llmProfileId,
        signal: opts.signal,
        maxTokens: 700,
      }
    );
    return summary.trim();
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.warn('Context summary failed:', err.message);
    const fallback = `[${middleMessages.length} earlier turns were compressed; summary generation failed: ${err.message}]`;
    return existingSummary ? `${existingSummary}\n${fallback}` : fallback;
  }
}

// ─── Packing ────────────────────────────────────────────────────────────────

function packMessages(messages, systemPrompt, contextWindow, summaryState) {
  const estimatedTokens = estimateTokens(messages, systemPrompt);
  const threshold = Math.floor((contextWindow || CONTEXT_WINDOW_FALLBACK) * PACKING_THRESHOLD_RATIO);
  if (estimatedTokens <= threshold) {
    return {
      apiMessages: [...messages],
      compressed: false,
      needsSummary: false,
      summaryStart: 0,
      summaryEnd: 0,
      estimatedTokens,
    };
  }

  const headCount = Math.min(HEAD_PROTECT, messages.length);
  const head = messages.slice(0, headCount);
  const summaryMessage = summaryState.content ? buildSummaryMessage(summaryState.content) : null;
  const responseReserve = clampNumber(
    Math.floor((contextWindow || CONTEXT_WINDOW_FALLBACK) * RESPONSE_RESERVE_RATIO),
    MIN_RESPONSE_RESERVE,
    MAX_RESPONSE_RESERVE
  );
  const targetBudget = Math.max(
    2048,
    threshold - responseReserve - estimateTokens(head, systemPrompt) - estimateTokens(summaryMessage ? [summaryMessage] : [], '')
  );

  let tailStart = chooseTailStart(messages, headCount, targetBudget);
  if (summaryState.content && summaryState.coveredUntil > tailStart) {
    tailStart = Math.min(messages.length, summaryState.coveredUntil);
  }
  tailStart = Math.max(headCount, tailStart);

  const tail = messages.slice(tailStart);
  const apiMessages = [
    ...head,
    ...(summaryMessage ? [summaryMessage] : []),
    ...tail,
  ];
  const summaryStart = headCount;
  const summaryEnd = tailStart;

  return {
    apiMessages,
    compressed: true,
    needsSummary: summaryEnd > Math.max(summaryStart, summaryState.coveredUntil || 0),
    summaryStart,
    summaryEnd,
    estimatedTokens: estimateTokens(apiMessages, systemPrompt),
  };
}

function chooseTailStart(messages, headCount, tokenBudget) {
  let tokens = 0;
  let kept = 0;
  let tailStart = messages.length;

  for (let index = messages.length - 1; index >= headCount; index -= 1) {
    const messageTokens = estimateMessageTokens(messages[index]);
    const mustKeep = kept < MIN_TAIL_KEEP;
    const preferred = kept < PREFERRED_TAIL_KEEP;
    if (!mustKeep && (!preferred || tokens + messageTokens > tokenBudget)) break;
    tokens += messageTokens;
    kept += 1;
    tailStart = index;
  }

  return tailStart;
}

function buildSummaryMessage(summary) {
  return {
    role: 'user',
    content: [
      '<conversation_summary>',
      'The following is a compact summary of earlier turns. Do not answer this message directly; use it only as background context.',
      summary,
      '</conversation_summary>',
    ].join('\n'),
  };
}

// ─── Prompt assembly ────────────────────────────────────────────────────────

function buildSystemPrompt({ systemPrompt, memorySnapshot, skillsList, agentIdentity, runtimeMode }) {
  const sections = [];
  if (systemPrompt?.trim()) sections.push(systemPrompt.trim());
  sections.push(runtimeMode === 'sandbox' ? SANDBOX_RUNTIME_PROMPT : AGENT_RUNTIME_PROMPT_WITH_COMMANDS);
  if (agentIdentity) sections.push(buildAgentIdentitySection(agentIdentity));
  const memorySection = buildMemorySection(memorySnapshot);
  if (memorySection) sections.push(memorySection);
  if (skillsList) sections.push(skillsList.trim());
  return sections.filter(Boolean).join('\n\n');
}

function buildAgentIdentitySection(content) {
  return `<agent_identity>\n${content.trim()}\n</agent_identity>`;
}

// ─── Token estimation and formatting ────────────────────────────────────────

export function estimateTokens(messages, systemPrompt = '') {
  let total = systemPrompt ? systemPrompt.length : 0;
  for (const msg of messages || []) {
    total += estimateMessageChars(msg);
  }
  return Math.max(1, Math.floor(total / TOKENS_PER_CHAR));
}

function estimateMessageTokens(message) {
  return Math.max(1, Math.floor(estimateMessageChars(message) / TOKENS_PER_CHAR));
}

function estimateMessageChars(message) {
  if (!message) return 0;
  let total = String(message.role || '').length + String(message.name || '').length;
  if (typeof message.content === 'string') total += message.content.length;
  else if (message.content != null) total += JSON.stringify(message.content).length;
  if (message.thinking) total += String(message.thinking).length;
  if (message.reasoning_content) total += String(message.reasoning_content).length;
  if (message.tool_calls) total += JSON.stringify(message.tool_calls).length;
  if (message.tool_call_id) total += String(message.tool_call_id).length;
  if (message.images?.length) total += message.images.reduce((sum, img) => sum + String(img.dataUrl || '').length, 0);
  return total;
}

function formatMessages(messages) {
  return messages
    .map((message, index) => {
      const role = message.role || (message.tool_call_id ? 'tool' : 'unknown');
      const parts = [`[${index + 1}] ${role}`];
      if (message.name) parts.push(`name=${message.name}`);
      if (message.tool_call_id) parts.push(`tool_call_id=${message.tool_call_id}`);
      if (message.tool_calls?.length) {
        parts.push(`tool_calls=${JSON.stringify(message.tool_calls)}`);
      }
      const content = typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content || '');
      return `${parts.join(' ')}\n${truncateText(content, 4000)}`;
    })
    .join('\n\n');
}

function normalizeSummaryState(summaryState, legacySummary) {
  return {
    content: String(summaryState?.content || legacySummary || '').trim(),
    coveredUntil: Number.isFinite(summaryState?.coveredUntil) ? summaryState.coveredUntil : 0,
  };
}

function truncateText(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

function clampNumber(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
}
