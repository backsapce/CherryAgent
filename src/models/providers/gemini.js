/**
 * Google Gemini provider.
 * Uses the Gemini REST API with streaming (generateContent stream).
 * Supports native function calling.
 */

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const MODELS = [
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
  { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
];

export default {
  id: 'gemini',
  name: 'Google Gemini',
  fallbackModels: MODELS,
  defaultModel: 'gemini-2.5-flash',
  defaultBaseUrl: DEFAULT_BASE_URL,

  async listModels(config) {
    const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const res = await fetch(`${baseUrl}/models?key=${config.apiKey}`);
    if (!res.ok) throw new Error(`Gemini models error ${res.status}`);
    const json = await res.json();
    return (json.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => {
        const id = m.name.replace('models/', '');
        return { id, name: m.displayName || id };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  },
};
