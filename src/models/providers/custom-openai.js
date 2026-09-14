/**
 * Custom OpenAI-compatible provider.
 * Works with any OpenAI-compatible API endpoint.
 * Requires user to provide Base URL, API Key, and Model name.
 */

const MODELS = [];

export default {
  id: 'custom-openai',
  name: 'Custom OpenAI-compatible',
  fallbackModels: MODELS,
  defaultModel: '',
  defaultBaseUrl: '',
  requiresBaseUrl: true,

  async listModels(config) {
    const baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) return [];
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) throw new Error(`Custom endpoint models error ${res.status}`);
    const json = await res.json();
    return (json.data || [])
      .sort((a, b) => (a.id || '').localeCompare(b.id || ''))
      .map((m) => ({ id: m.id, name: m.id }));
  },
};
