const DEBUG_EXPORT_VERSION = 1;
const TOKENS_PER_CHAR = 4;

export function buildChatDebugExport({
  session = null,
  messages = session?.messages || [],
  llmMessages = messages,
  systemPrompt = '',
  llmProfile = null,
  provider = null,
  agent = null,
  runtime = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const chatMessages = Array.isArray(messages) ? messages : [];
  const expandedMessages = Array.isArray(llmMessages) ? llmMessages : chatMessages;
  const contextWindow = normalizePositiveNumber(llmProfile?.contextWindow);
  const providerUsage = latestAssistantUsage(chatMessages);
  const rawMessageEstimatedTokens = estimateDebugTokens(chatMessages, '');
  const llmInputEstimatedTokens = estimateDebugTokens(expandedMessages, systemPrompt);
  const toolCalls = collectToolCalls(chatMessages);

  return {
    type: 'vertex-agent-chat-debug',
    version: DEBUG_EXPORT_VERSION,
    generatedAt,
    session: sanitizeSession(session, chatMessages),
    llm: sanitizeLlmProfile(llmProfile, provider),
    agent: sanitizeAgent(agent),
    runtime: sanitizeRuntime(runtime),
    context: {
      contextWindow,
      rawMessageEstimatedTokens,
      llmInputEstimatedTokens,
      systemPromptChars: String(systemPrompt || '').length,
      messageCount: chatMessages.length,
      expandedMessageCount: expandedMessages.length,
      providerUsage,
      estimatedWindowRatio: contextWindow ? roundRatio(llmInputEstimatedTokens / contextWindow) : null,
      providerWindowRatio: contextWindow && providerUsage?.total_tokens
        ? roundRatio(providerUsage.total_tokens / contextWindow)
        : null,
    },
    toolCalls: {
      count: toolCalls.length,
      byStatus: countBy(toolCalls, 'status'),
      byName: countBy(toolCalls, 'name'),
      items: toolCalls,
    },
    messages: chatMessages.map(sanitizeMessage),
    llmMessages: expandedMessages.map(sanitizeMessage),
  };
}

export function createChatDebugFilename(session, date = new Date()) {
  const sessionId = safeFilenamePart(session?.id || 'session');
  const title = safeFilenamePart(session?.title || 'chat').slice(0, 36) || 'chat';
  const stamp = date.toISOString().replace(/[:.]/g, '-');
  return `vertex-agent-debug-${title}-${sessionId}-${stamp}.json`;
}

function sanitizeSession(session, messages) {
  if (!session) {
    return {
      id: null,
      title: null,
      messageCount: messages.length,
    };
  }

  return {
    id: session.id || null,
    title: session.title || null,
    lastMessage: session.lastMessage || '',
    updatedAt: session.updatedAt || null,
    updatedAtMs: Number.isFinite(session.updatedAtMs) ? session.updatedAtMs : null,
    agentId: session.agentId || null,
    llmProfileId: session.llmProfileId || null,
    messageCount: messages.length,
  };
}

function sanitizeLlmProfile(profile, provider) {
  return {
    id: profile?.id || null,
    name: profile?.name || null,
    provider: profile?.provider || null,
    providerName: provider?.name || profile?.provider || null,
    model: profile?.model || null,
    contextWindow: normalizePositiveNumber(profile?.contextWindow),
    configured: Boolean(profile?.configured),
    hasApiKey: Boolean(profile?.hasApiKey),
    hasBaseUrl: Boolean(profile?.baseUrl),
  };
}

function sanitizeAgent(agent) {
  return {
    id: agent?.id || null,
    name: agent?.name || null,
    llmProfileId: agent?.llmProfileId || null,
    hasSandbox: Boolean(agent?.sandboxUrl),
  };
}

function sanitizeRuntime(runtime) {
  return {
    activeSessionId: runtime?.activeSessionId || null,
    streaming: Boolean(runtime?.streaming),
    hasToolContext: Boolean(runtime?.hasToolContext),
  };
}

function sanitizeMessage(message) {
  const toolCalls = Array.isArray(message?.toolCalls)
    ? message.toolCalls.map(sanitizeToolCall)
    : undefined;

  return {
    id: message?.id || null,
    role: message?.role || null,
    content: cloneContent(message?.content),
    contentChars: contentChars(message?.content),
    thinking: message?.thinking || undefined,
    thinkingChars: message?.thinking ? String(message.thinking).length : 0,
    reasoning_content: message?.reasoning_content || undefined,
    images: sanitizeImages(message?.images),
    contextFiles: sanitizeContextFiles(message?.contextFiles),
    toolCalls,
    usage: normalizeUsage(message?.usage),
  };
}

function sanitizeImages(images) {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  return images.map((image) => ({
    name: image?.name || null,
    type: image?.type || null,
    size: Number.isFinite(image?.size) ? image.size : null,
    dataUrlChars: image?.dataUrl ? String(image.dataUrl).length : 0,
  }));
}

function sanitizeContextFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return undefined;
  return files.map((file) => ({
    source: file?.source || null,
    relativePath: file?.relativePath || null,
    displayPath: file?.displayPath || null,
    size: Number.isFinite(file?.size) ? file.size : null,
    content: file?.content || '',
    contentChars: file?.content ? String(file.content).length : 0,
  }));
}

function collectToolCalls(messages) {
  const items = [];
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message?.toolCalls)) return;
    message.toolCalls.forEach((toolCall, callIndex) => {
      items.push({
        messageId: message.id || null,
        messageIndex,
        callIndex,
        ...sanitizeToolCall(toolCall),
      });
    });
  });
  return items;
}

function sanitizeToolCall(toolCall) {
  return {
    id: toolCall?.id || null,
    name: toolCall?.name || null,
    status: toolCall?.status || 'unknown',
    command: toolCall?.command || undefined,
    summary: toolCall?.summary || undefined,
    parsedArgs: toolCall?.parsedArgs,
    rawArgs: toolCall?.rawArgs,
    result: toolCall?.result || undefined,
    resultChars: toolCall?.result ? String(toolCall.result).length : 0,
  };
}

function normalizeUsage(usage) {
  if (!usage) return null;
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount ?? usage.inputTokenCount ?? 0;
  const completion = usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokenCount ?? usage.candidatesTokenCount ?? 0;
  const total = usage.total_tokens ?? usage.totalTokenCount ?? prompt + completion;
  const normalized = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    contextWindow: normalizePositiveNumber(usage.content_len),
  };

  const turnPrompt = normalizeNonNegativeNumber(usage.turn_prompt_tokens);
  const turnCompletion = normalizeNonNegativeNumber(usage.turn_completion_tokens);
  const turnTotal = normalizeNonNegativeNumber(usage.turn_total_tokens);
  const modelCallCount = normalizePositiveNumber(usage.model_call_count);

  if (turnPrompt != null) normalized.turn_prompt_tokens = turnPrompt;
  if (turnCompletion != null) normalized.turn_completion_tokens = turnCompletion;
  if (turnTotal != null) normalized.turn_total_tokens = turnTotal;
  if (modelCallCount != null) normalized.model_call_count = modelCallCount;

  return normalized;
}

function latestAssistantUsage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && message.usage) return normalizeUsage(message.usage);
  }
  return null;
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function normalizePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function normalizeNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function roundRatio(value) {
  return Math.round(value * 10_000) / 10_000;
}

function contentChars(content) {
  if (typeof content === 'string') return content.length;
  if (content == null) return 0;
  return JSON.stringify(content).length;
}

function cloneContent(content) {
  if (content == null || typeof content === 'string') return content || '';
  return JSON.parse(JSON.stringify(content));
}

function estimateDebugTokens(messages, systemPrompt = '') {
  let total = systemPrompt ? String(systemPrompt).length : 0;
  for (const message of messages || []) {
    total += estimateMessageChars(message);
  }
  return Math.max(1, Math.floor(total / TOKENS_PER_CHAR));
}

function estimateMessageChars(message) {
  if (!message) return 0;
  let total = String(message.role || '').length + String(message.name || '').length;
  total += contentChars(message.content);
  if (message.thinking) total += String(message.thinking).length;
  if (message.reasoning_content) total += String(message.reasoning_content).length;
  if (message.tool_calls) total += JSON.stringify(message.tool_calls).length;
  if (message.toolCalls) total += JSON.stringify(message.toolCalls).length;
  if (message.tool_call_id) total += String(message.tool_call_id).length;
  if (message.images?.length) {
    total += message.images.reduce((sum, image) => sum + String(image?.dataUrl || '').length, 0);
  }
  if (message.contextFiles?.length) {
    total += message.contextFiles.reduce((sum, file) => sum + String(file?.content || '').length, 0);
  }
  return total;
}

function safeFilenamePart(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
