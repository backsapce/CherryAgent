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
};
