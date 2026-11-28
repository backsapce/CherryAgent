/**
 * Context assembly for the agent loop.
 *
 * The packer keeps a small stable head, a compact summary of the older middle,
 * and the freshest tail that fits the model budget. Unlike the previous
 * sliding window, the summary is actually generated and tracked by message
 * index so the same turns are not summarized repeatedly.
 */

import llm from '../models/llm.js';
import { toModelMessages } from '../models/ai.js';
import { buildMemorySection } from './memory.js';
import { COMMAND_EXECUTION_GUIDANCE } from './commandGuidance.js';
import { estimateTextTokens } from './tokenEstimate.js';
import { truncateMiddle } from './toolObservation.js';

const CONTEXT_WINDOW_FALLBACK = 128_000;
const PACKING_THRESHOLD_RATIO = 0.72;
const HEAD_PROTECT = 4;
const RECENT_TAIL_KEEP = 8;
const PREFERRED_TAIL_KEEP = 36;
const MAX_SUMMARY_TOKENS = 700;
const MAX_SUMMARY_SOURCE_CHARS = 80_000;

const AGENT_RUNTIME_PROMPT = `You are CherryAgent, an autonomous coding and browser-work agent.

Filesystem model:
- Browser OPFS is the durable CherryAgent storage backend, but browser file tools do NOT expose the OPFS root.
- Browser file tools can read/write only the active agent's own files area: workspace/<active-agent>/files/.
- Browser file tools cannot access other agents, OPFS root files, AGENTS.md, memory files, or skill files by path.
- The skill catalog is merged in order from OPFS global skills, active OPFS workspace skills, then selected agent skills; a later same-named skill overrides an earlier one.
- Use the skill tool for all skill reads and writes. In browser runtime, skill writes always go to workspace/<active-agent>/skills/ in OPFS.
- The sandbox filesystem is the selected agent runtime workdir. Its skills/ directory is the final skill-catalog source, but it remains separate from browser OPFS for other files and state.
- Active agent files and sandbox workdir files do not automatically sync. Choose browser file tools for workspace/<active-agent>/files/, sandbox file tools for command-runtime files, and explicitly copy content between them when needed.
- Never infer that a path seen in the sandbox exists in the active agent files area, or that an active agent file path exists in the sandbox.
- Display real images only by calling display_browser_image or display_sandbox_image with the file path. Never put image bytes, binary data, base64, data URLs, or Markdown/HTML image tags for local files in the conversation.

Operating rules:
- Work from evidence. Inspect files, command output, tool results, and provided context before making risky changes.
- Keep going until the user's request is genuinely handled or a real blocker requires user input.
- Do not answer with a promise like "I will inspect/read/create/run". If the next step needs a tool, call the tool in the same response.
- Prefer small, reversible edits and clear verification. Do not hide failures; use them to choose the next step.
- Use memory only for durable facts, preferences, and project conventions that are likely to matter in future sessions.
- Use skills as just-in-time procedures: list with a query when discovery is needed, read the relevant skill before relying on it, and avoid loading unrelated references.
- A user message beginning with /<skill-name> explicitly selects that enabled skill. Read the named skill before acting, follow it for this turn, and treat the text after the command as the user's task. If the named skill does not exist or is disabled, explain that briefly instead of silently substituting another skill.
- Reuse a skill read already visible in the conversation when it still applies; reload if it changed or is no longer visible. This does not replace an explicit /<skill-name> request.
- Treat tool output as authoritative over assumptions. If context is summarized, rely on the live tail for the latest state.`;

const AGENT_RUNTIME_PROMPT_WITH_COMMANDS = `${AGENT_RUNTIME_PROMPT}\n\n${COMMAND_EXECUTION_GUIDANCE}`;

const SANDBOX_RUNTIME_PROMPT = `You are CherryAgent running entirely inside a persistent sandbox runtime.

Runtime isolation:
- The agent loop, model calls, tool calls, and filesystem operations all run in this sandbox.
- Browser state, browser OPFS, browser files, browser actions, and other browser-only tools are unavailable and invisible.
- The only visible filesystem is the sandbox workspace. Use sandbox file tools and command tools for all inspection and changes.
- Browser memory is not copied into this runtime. At run startup, enabled OPFS global and workspace skills are synchronized into skills/ without replacing skills that already exist in the sandbox; identity and the compact merged catalog are also included below in this prompt.
- The skill tool interacts only with the sandbox skills/ directory. Skills created or changed here remain sandbox files and are not written back to browser OPFS.
- The browser is only a client that may disconnect and later replay this run's persisted event log and result.
- Display real images only with display_sandbox_image and their sandbox file path. Never put image bytes, binary data, base64, data URLs, or Markdown/HTML image tags for local files in the conversation.

Operating rules:
- Work from evidence and continue until the request is handled or a real blocker requires user input.
- Reuse a skill read already visible in the conversation when it still applies; reload if it changed or is no longer visible. This does not replace an explicit /<skill-name> request.
- Do not promise future tool work; call an available tool in the same response.
- Prefer small, reversible edits, verify important changes, and report failures honestly.
- A user message beginning with /<skill-name> explicitly selects that enabled skill. Read it with the skill tool before acting, follow it for this turn, and treat the text after the command as the user's task. If the named skill is unavailable, explain that briefly instead of silently substituting another skill.

${COMMAND_EXECUTION_GUIDANCE}`;

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
 * @param {{ content?: string, coveredUntil?: number, anchorId?: string|null }} [opts.summaryState]
 * @param {string} [opts.summary] Legacy summary text.
 * @param {string} [opts.llmProfileId]
 * @param {AbortSignal} [opts.signal]
 * @param {boolean} [opts.autoSummarize=true]
 * @returns {Promise<{ apiMessages: Array, modelMessages: Array, latestUserMessage: Object|null, summaryMessage: Object|null, systemPrompt: string, compressed: boolean, summaryState: Object, estimatedTokens: number }>}
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
    completeSummary,
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
  // Keep the stored reply atomic for summary anchors, but count exactly the
  // model-side messages it expands to (including call arguments and results).
  const usedCallIds = new Set();
  const projected = messages.map((message) => toModelMessages([message], { contextWindow, usedCallIds }));
  const messageCosts = projected.map((group) => group.reduce((total, message) => total + estimateModelMessageTokens(message), 0));
  const latestUserIndex = messages.findLastIndex((message) => message?.role === 'user');
  const latestUserMessage = projected[latestUserIndex]?.[0] ?? null;
  const systemTokens = estimateSystemTokens(fullSystemPrompt);
  const pack = () => packMessages(messages, projected, messageCosts, latestUserIndex, systemTokens, contextWindow, summaryState);
  let packed = pack();

  let summaryPasses = 0;
  while (autoSummarize && packed.needsSummary && summaryPasses < 3) {
    summaryPasses += 1;
    const start = Math.max(packed.summaryStart, summaryState.content ? summaryState.coveredUntil : 0);
    const summary = await summarizeMiddle(projected, {
      start,
      end: packed.summaryEnd,
      existingSummary: summaryState.content,
      llmProfileId,
      signal,
      completeSummary,
      contextWindow,
    });
    if (!summary) break;
    summaryState = summary;
    packed = pack();
  }
  summaryState = stampSummaryAnchor(summaryState, messages);

  return {
    apiMessages: packed.apiMessages,
    modelMessages: packed.modelMessages,
    latestUserMessage,
    summaryMessage: packed.summaryMessage,
    systemPrompt: fullSystemPrompt,
    compressed: packed.compressed,
    summaryState,
    estimatedTokens: packed.estimatedTokens,
  };
}

/** Summarize a bounded prefix of the dropped history, then advance its anchor. */
async function summarizeMiddle(groups, { start, end, existingSummary, contextWindow, llmProfileId, signal, completeSummary }) {
  const buildPrompt = (source) => ({ role: 'user', content: (existingSummary
    ? [
      'Update the running conversation summary for an autonomous agent.',
      'Preserve only durable state: user requests, completed work, files touched, tool findings, relevant skill instructions, decisions, blockers, and remaining TODOs.',
      'Do not include generic chit-chat. Keep it concise but specific enough to resume work.',
      '',
      '<existing_summary>',
      existingSummary,
      '</existing_summary>',
      '',
      '<new_turns>',
      source,
      '</new_turns>',
    ]
    : [
      'Summarize these earlier conversation turns for an autonomous agent.',
      'Include: the active task, completed actions, important files/commands/results, relevant skill instructions, decisions, blockers, and pending work.',
      'Keep it concise, factual, and ordered from oldest to newest where useful.',
      '',
      '<turns>',
      source,
      '</turns>',
    ]).join('\n') });
  const budget = inputTokenBudget(contextWindow);
  let remainingTokens = budget - estimateModelMessageTokens(buildPrompt(''));
  let remainingChars = MAX_SUMMARY_SOURCE_CHARS;
  const chunks = [];
  let coveredUntil = start;
  let prompt;
  for (; coveredUntil < end && remainingTokens > 0; coveredUntil += 1) {
    if (!groups[coveredUntil].length) continue;
    const source = `${formatMessages(groups[coveredUntil])}\n\n`;
    const tokens = estimateTextTokens(JSON.stringify(source));
    if (tokens > remainingTokens || source.length > remainingChars) {
      // Excerpt one oversized reply, not the entire middle: the anchor must
      // not advance past other turns that were never in the summary request.
      if (!chunks.length) {
        prompt = fitTextMessage(truncateMiddle(source, MAX_SUMMARY_SOURCE_CHARS), buildPrompt, budget);
        if (prompt) coveredUntil += 1;
      }
      break;
    }
    chunks.push(source);
    remainingTokens -= tokens;
    remainingChars -= source.length;
  }
  if (!prompt && chunks.length) prompt = buildPrompt(chunks.join(''));
  if (!prompt) return null;

  try {
    signal?.throwIfAborted();
    const summary = await (completeSummary || llm.completeSession)([prompt], {
      llmProfileId,
      signal,
      maxTokens: Math.min(MAX_SUMMARY_TOKENS, normalizeContextWindow(contextWindow) - budget),
    });
    signal?.throwIfAborted();
    const content = typeof summary === 'string' ? summary.trim() : '';
    return content ? { content, coveredUntil } : null;
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('Context summary failed:', err?.message || err);
    return null;
  }
}

// ─── Packing ────────────────────────────────────────────────────────────────

function normalizeContextWindow(contextWindow) {
  const window = Number(contextWindow);
  return Number.isFinite(window) && window > 0 ? window : CONTEXT_WINDOW_FALLBACK;
}

export function inputTokenBudget(contextWindow, requiredTokens = 0) {
  // Leave headroom for tool schemas, provider framing, and the reply.
  const budget = Math.floor(normalizeContextWindow(contextWindow) * PACKING_THRESHOLD_RATIO);
  if (requiredTokens > budget) {
    const error = new Error(`The system prompt and latest user message(s) need about ${requiredTokens} tokens, above the model's ${budget}-token input budget. Shorten the prompt or select a model with a larger context window.`);
    error.name = 'ContextTooLargeError';
    error.code = 'CONTEXT_TOO_LARGE';
    throw error;
  }
  return budget;
}

function packMessages(messages, projected, messageCosts, latestUserIndex, systemTokens, contextWindow, summaryState) {
  const requiredTokens = systemTokens + (messageCosts[latestUserIndex] ?? 0);
  const budget = inputTokenBudget(contextWindow, requiredTokens);
  const estimatedTokens = systemTokens + messageCosts.reduce((total, tokens) => total + tokens, 0);
  const coveredUntil = summaryState.content ? Math.min(messages.length, summaryState.coveredUntil) : 0;
  if (estimatedTokens <= budget && !coveredUntil) {
    return {
      apiMessages: [...messages], modelMessages: projected.flat(), summaryMessage: null,
      compressed: false, needsSummary: false, estimatedTokens,
    };
  }

  let remaining = budget - requiredTokens;
  const summaryMessage = summaryState.content ? fitTextMessage(summaryState.content, buildSummaryMessage, remaining) : null;
  if (summaryMessage) remaining -= estimateModelMessageTokens(summaryMessage);

  let tailStart = latestUserIndex < 0 ? messages.length : latestUserIndex;
  let tailEnd = Math.min(messages.length, tailStart + 1);
  // A replay can end with an assistant reply; it is optional, unlike the last user message.
  while (tailEnd < messages.length && messageCosts[tailEnd] <= remaining) remaining -= messageCosts[tailEnd++];
  const tailFloor = Math.min(coveredUntil, tailStart);
  let headCount = 0;
  const keepTail = (maxCount) => {
    while (tailStart > Math.max(headCount, tailFloor) && tailEnd - tailStart < maxCount && messageCosts[tailStart - 1] <= remaining) {
      remaining -= messageCosts[--tailStart];
    }
  };
  keepTail(RECENT_TAIL_KEEP);
  // A tight window can summarize within the preferred head; don't replay its anchor on a wider model.
  const headLimit = Math.min(HEAD_PROTECT, tailStart, coveredUntil ? coveredUntil - 1 : Infinity);
  while (headCount < headLimit && messageCosts[headCount] <= remaining) {
    remaining -= messageCosts[headCount++];
  }
  keepTail(estimatedTokens <= budget ? Infinity : PREFERRED_TAIL_KEEP);
  // With no kept head or summary, do not start the prompt with a reply to a dropped user turn.
  while (!headCount && !summaryMessage && tailStart < latestUserIndex && messages[tailStart]?.role === 'assistant') {
    remaining += messageCosts[tailStart++];
  }

  const summary = summaryMessage ? [summaryMessage] : [];
  return {
    apiMessages: [...messages.slice(0, headCount), ...summary, ...messages.slice(tailStart, tailEnd)],
    modelMessages: [...projected.slice(0, headCount).flat(), ...summary, ...projected.slice(tailStart, tailEnd).flat()],
    summaryMessage,
    compressed: true,
    needsSummary: tailStart > Math.max(headCount, coveredUntil),
    summaryStart: headCount,
    summaryEnd: tailStart,
    estimatedTokens: budget - remaining,
  };
}

function fitTextMessage(text, buildMessage, budget) {
  const message = buildMessage(text);
  if (estimateModelMessageTokens(message) <= budget) return message;
  for (let maxChars = Math.min(text.length - 1, budget * 4); maxChars >= 80; maxChars = Math.floor(maxChars / 2)) {
    const preview = buildMessage(truncateMiddle(text, maxChars));
    if (estimateModelMessageTokens(preview) <= budget) return preview;
  }
  return null;
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
  return Math.max(1, (messages || []).reduce((total, message) => total + estimateModelMessageTokens(message), estimateSystemTokens(systemPrompt)));
}

export function estimateSystemTokens(system) {
  return system ? estimateModelMessageTokens({ role: 'system', content: system }) : 0;
}

// prepareStep re-estimates immutable message objects on every tool round.
const modelMessageTokenCache = new WeakMap();

function estimateModelMessageTokens(message) {
  if (!message) return 0;
  let tokens = modelMessageTokenCache.get(message);
  if (tokens !== undefined) return tokens;
  let { content } = message;
  let imageCount = 0;
  if (message.role !== 'system' && typeof content === 'string') {
    content = [{ type: 'text', text: content }];
  } else if (message.role === 'user' && Array.isArray(content)) {
    content = content.map((part) => {
      if (part.type !== 'image') return part;
      imageCount += 1;
      return { type: 'image', mediaType: part.mediaType };
    });
  }
  const input = content === message.content ? message : { ...message, content };
  // shortcut: use a fixed vision estimate rather than pricing base64 as text; use provider tile costs if needed.
  tokens = estimateTextTokens(JSON.stringify(input)) + imageCount * 1024;
  modelMessageTokenCache.set(message, tokens);
  return tokens;
}

function formatMessages(messages) {
  return messages
    .map((message) => {
      const content = typeof message.content === 'string'
        ? message.content
        : message.role === 'user' && Array.isArray(message.content)
          ? message.content.map((part) => part.type === 'image' ? '[image]' : part.text).join('\n')
          : JSON.stringify(message.content || '');
      return `${message.role}:\n${truncateMiddle(content, 4000)}`;
    })
    .join('\n\n');
}

function normalizeSummaryState(summaryState, legacySummary) {
  const content = String(summaryState?.content || legacySummary || '').trim();
  // Older builds saved failures as summaries with a false coverage marker.
  if (/(?:^|\n)\[\d+ earlier turns were compressed; summary generation failed:/.test(content)) {
    return { content: '', coveredUntil: 0, anchorId: null };
  }
  return {
    content,
    coveredUntil: Number.isInteger(summaryState?.coveredUntil) && summaryState.coveredUntil > 0 ? summaryState.coveredUntil : 0,
    anchorId: summaryState?.anchorId ?? null,
  };
}

/**
 * Bind a summary to the message it covers. `coveredUntil` is an index into the
 * caller's message array; if the user later edits or deletes history (indices
 * shift), the anchor id lets the next run detect the mismatch and regenerate
 * instead of applying a summary to the wrong turns.
 */
function stampSummaryAnchor(summaryState, messages) {
  if (!summaryState?.content) return summaryState;
  const coveredUntil = Number(summaryState.coveredUntil);
  if (!Number.isInteger(coveredUntil) || coveredUntil <= 0) return summaryState;
  return { ...summaryState, anchorId: messages?.[coveredUntil - 1]?.id ?? null };
}

/**
 * Whether a persisted summary can still be applied to this message history.
 * Append-only growth keeps indices valid; any edit or truncation does not.
 */
export function summaryStateMatchesHistory(summaryState, messages) {
  if (!summaryState?.content || summaryState.coveredUntil == null) return false;
  const coveredUntil = Number(summaryState.coveredUntil);
  if (!Number.isInteger(coveredUntil) || coveredUntil <= 0) return false;
  if (coveredUntil > (messages?.length || 0)) return false;
  const anchorId = summaryState.anchorId;
  if (anchorId == null) return true;
  const anchor = messages[coveredUntil - 1];
  return anchor?.id != null && anchor.id === anchorId;
}
