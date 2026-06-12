/**
 * Anthropic (Claude) provider.
 * Uses the Anthropic Messages API with streaming.
 * Supports native tool_use / tool_result protocol.
 */

const DEFAULT_BASE_URL = 'https://api.anthropic.com';

const MODELS = [
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
  { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet' },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
  { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
];

export default {
  id: 'anthropic',
  name: 'Anthropic',
  fallbackModels: MODELS,
  defaultModel: 'claude-sonnet-4-20250514',
  defaultBaseUrl: DEFAULT_BASE_URL,

  async listModels(config) {
    const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    });
    if (!res.ok) throw new Error(`Anthropic models error ${res.status}`);
    const json = await res.json();
    return (json.data || [])
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((m) => ({ id: m.id, name: m.display_name || m.id }));
  },

  async *stream(config, messages, opts = {}) {
    const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');

    let system = undefined;
    const apiMessages = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        system = system ? `${system}\n\n${msg.content}` : msg.content;
      } else if (msg.role === 'tool') {
        appendAnthropicToolResult(apiMessages, msg);
      } else if (msg.tool_calls?.length) {
        apiMessages.push({
          role: 'assistant',
          content: formatAnthropicToolUse(msg),
        });
      } else if (msg.images?.length) {
        const parts = msg.images.map((img) => {
          const [header, data] = img.dataUrl.split(',');
          const mediaType = header.match(/data:(.*?);/)?.[1] || 'image/jpeg';
          return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
        });
        if (msg.content) parts.push({ type: 'text', text: msg.content });
        apiMessages.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: parts });
      } else {
        apiMessages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content || '',
        });
      }
    }

    const body = {
      model: config.model || this.defaultModel,
      messages: apiMessages,
      max_tokens: opts.maxTokens || 4096,
      stream: true,
      ...(opts.temperature != null && { temperature: opts.temperature }),
    };

    if (system) body.system = system;

    // Tool calling support
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic error ${res.status}: ${err}`);
    }

    yield* readAnthropicSSE(res.body);
  },
};

function formatAnthropicToolUse(msg) {
  const blocks = [];
  if (msg.content) blocks.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls) {
    blocks.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.name,
      input: safeParseToolArgs(tc.arguments),
    });
  }
  return blocks.length ? blocks : [{ type: 'text', text: '' }];
}

function appendAnthropicToolResult(apiMessages, msg) {
  const block = {
    type: 'tool_result',
    tool_use_id: msg.tool_call_id,
    content: msg.content || '',
  };
  const last = apiMessages[apiMessages.length - 1];
  if (
    last?.role === 'user'
    && Array.isArray(last.content)
    && last.content.every((part) => part.type === 'tool_result')
  ) {
    last.content.push(block);
    return;
  }
  apiMessages.push({ role: 'user', content: [block] });
}

function safeParseToolArgs(args) {
  try {
    return args ? JSON.parse(args) : {};
  } catch {
    return {};
  }
}

/**
 * Parse Anthropic SSE stream.
 * Yields: { content, reasoning, toolCalls }
 * toolCalls format: [{ id, name, input (partial JSON string) }]
 * On message_delta, yields { usage: { input_tokens, output_tokens } } from cache_control usage.
 */
async function* readAnthropicSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();

        try {
          const json = JSON.parse(data);

          if (json.type === 'content_block_start') {
            // Tool call starts
            if (json.content_block?.type === 'tool_use') {
              yield {
                content: null,
                reasoning: null,
                toolCalls: [{
                  index: json.index ?? 0,
                  id: json.content_block.id,
                  name: json.content_block.name,
                  arguments: null,
                }],
              };
            }
          } else if (json.type === 'content_block_delta') {
            if (json.delta?.type === 'thinking_delta' && json.delta?.thinking) {
              yield { content: null, reasoning: json.delta.thinking, toolCalls: null };
            } else if (json.delta?.text) {
              yield { content: json.delta.text, reasoning: null, toolCalls: null };
            } else if (json.delta?.type === 'input_json_delta' && json.delta?.partial_json) {
              // Tool call argument fragment
              yield {
                content: null,
                reasoning: null,
                toolCalls: [{
                  index: json.index ?? 0,
                  id: null,
                  name: null,
                  arguments: json.delta.partial_json,
                }],
              };
            }
          } else if (json.type === 'message_delta') {
            // Usage info at end of stream
            if (json.usage) {
              yield { usage: json.usage };
            }
          } else if (json.type === 'message_stop') {
            return;
          }
        } catch {
          // skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
