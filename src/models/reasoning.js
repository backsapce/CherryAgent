export const REASONING_EFFORTS = ['low', 'medium', 'high'];
export const normalizeReasoningEffort = (value) => REASONING_EFFORTS.includes(value) ? value : null;
let catalogPromise;

async function catalog() {
  if (!catalogPromise) {
    catalogPromise = fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(5000) })
      .then((response) => {
        if (!response.ok) throw new Error('Model catalog unavailable');
        return response.json();
      }).catch((error) => { catalogPromise = null; throw error; });
  }
  return catalogPromise;
}

export function reasoningLevels(provider, model, info) {
  if (!info?.reasoning) return [];
  if (provider === 'anthropic') {
    return /claude-(?:opus-4-[6-9]|sonnet-4-[6-9]|[a-z]+-5)/.test(model) ? REASONING_EFFORTS : [];
  }
  if (provider === 'gemini') {
    if (!/gemini-3/.test(model)) return [];
    return /flash/.test(model) ? REASONING_EFFORTS : ['low', 'high'];
  }
  if (['openai', 'openrouter', 'custom-openai'].includes(provider)) return REASONING_EFFORTS;
  return [];
}

export async function resolveReasoningLevels(provider, model) {
  try {
    const data = await catalog();
    const providerId = { gemini: 'google', qwen: 'alibaba' }[provider] || provider;
    const id = String(model || '').replace(/^models\//, '');
    let info = data[providerId]?.models?.[id];
    if (!info && ['custom-openai', 'openrouter'].includes(provider)) {
      const bare = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
      info = Object.values(data).map((entry) => entry.models?.[id] || entry.models?.[bare]).find(Boolean);
    }
    return reasoningLevels(provider, id, info);
  } catch { return []; }
}

export function reasoningProviderOptions(provider, effort) {
  if (!normalizeReasoningEffort(effort)) return {};
  if (provider === 'anthropic') return { anthropic: { thinking: { type: 'adaptive' }, effort } };
  if (provider === 'gemini') return { google: { thinkingConfig: { thinkingLevel: effort, includeThoughts: true } } };
  if (provider === 'openrouter') return { openrouter: { reasoning: { effort } } };
  return { [provider]: { reasoningEffort: effort } };
}
