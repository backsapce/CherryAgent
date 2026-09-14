/**
 * DeepSeek OpenAI-compatible provider.
 * Official base URL: https://api.deepseek.com
 */

const DEFAULT_BASE_URL = 'https://api.deepseek.com';

const MODELS = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'deepseek-chat', name: 'DeepSeek Chat' },
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
];

export default {
  id: 'deepseek',
  name: 'DeepSeek',
  fallbackModels: MODELS,
  defaultModel: 'deepseek-chat',
  defaultBaseUrl: DEFAULT_BASE_URL,

  async listModels(config) {
    const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) throw new Error(`DeepSeek models error ${res.status}`);
    const json = await res.json();
    return (json.data || [])
      .filter((m) => m.id)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((m) => ({ id: m.id, name: m.id }));
  },
};
