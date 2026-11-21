/**
 * Custom OpenAI-compatible provider.
 * Works with any OpenAI-compatible API endpoint.
 * Requires user to provide Base URL, API Key, and Model name.
 */

const MODELS = [];

/** A complete generation URL selects the protocol; a bare base URL defaults to Chat Completions. */
export function resolveCustomOpenAiEndpoint(value) {
  const endpoint = String(value || '').trim();
  if (!endpoint) return null;
  // Keep query parameters (e.g. api-version) after the resource path, not
  // between the base URL and the path the SDK appends. Fragments aren't sent.
  const [location] = endpoint.split('#', 1);
  const queryStart = location.indexOf('?');
  const query = queryStart < 0 ? '' : location.slice(queryStart);
  const path = (queryStart < 0 ? location : location.slice(0, queryStart)).replace(/\/+$/, '');
  const resource = path.replace(/^https?:\/\/[^/]+/i, '').match(/\/(responses|chat\/completions)$/);
  const baseUrl = resource ? path.slice(0, -resource[0].length) : path;
  return {
    api: resource?.[1] === 'responses' ? 'responses' : 'chat',
    baseUrl,
    query,
    modelsUrl: `${baseUrl}/models${query}`,
  };
}

export default {
  id: 'custom-openai',
  name: 'Custom OpenAI-compatible',
  fallbackModels: MODELS,
  defaultModel: '',
  defaultBaseUrl: '',
  requiresBaseUrl: true,

  async listModels(config) {
    const endpoint = resolveCustomOpenAiEndpoint(config.baseUrl);
    if (!endpoint) return [];
    const res = await fetch(endpoint.modelsUrl, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) throw new Error(`Custom endpoint models error ${res.status}`);
    const json = await res.json();
    return (json.data || [])
      .sort((a, b) => (a.id || '').localeCompare(b.id || ''))
      .map((m) => ({ id: m.id, name: m.id }));
  },
};
