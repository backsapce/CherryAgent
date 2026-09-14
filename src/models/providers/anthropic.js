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
};
