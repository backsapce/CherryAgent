import { formatMultimodal, formatOpenAITools, readSSE } from './shared.js';

/**
 * OpenRouter provider.
 * Uses the OpenRouter API (OpenAI-compatible) to access many models.
 */

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

const MODELS = [
  { id: 'openai/gpt-4o', name: 'GPT-4o (via OpenRouter)' },
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4 (via OpenRouter)' },
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash (via OpenRouter)' },
  { id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick (via OpenRouter)' },
  { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1 (via OpenRouter)' },
  { id: 'qwen/qwen3-235b-a22b', name: 'Qwen3 235B (via OpenRouter)' },
];

export default {
  id: 'openrouter',
  name: 'OpenRouter',
  fallbackModels: MODELS,
  defaultModel: 'openai/gpt-4o',
  defaultBaseUrl: DEFAULT_BASE_URL,

  async listModels(config) {
    const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) throw new Error(`OpenRouter models error ${res.status}`);
    const json = await res.json();
    return (json.data || [])
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((m) => ({ id: m.id, name: m.name || m.id }));
  },

  async *stream(config, messages, opts = {}) {
    const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const body = {
      model: config.model || this.defaultModel,
      messages: formatMultimodal(messages),
      stream: true,
      stream_options: { include_usage: true },
      ...(opts.temperature != null && { temperature: opts.temperature }),
      ...(opts.maxTokens != null && { max_tokens: opts.maxTokens }),
    };

    // Tool calling support
    if (opts.tools?.length) {
      body.tools = formatOpenAITools(opts.tools);
    }

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        'HTTP-Referer': globalThis.location?.href || 'https://cherry-agent.local',
        'X-Title': 'Cherry Agent',
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenRouter error ${res.status}: ${err}`);
    }

    yield* readSSE(res.body);
  },
};
