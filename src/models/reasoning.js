export const REASONING_EFFORTS = ['low', 'medium', 'high'];

// Canonical order of every reasoning-effort value models.dev reports today.
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// Effort values each request path can actually carry. Shaped by the AI SDK
// provider option schemas: anthropic accepts low..max, google thinkingLevel
// accepts minimal..high, OpenAI-compatible payloads accept none..xhigh.
const PROVIDER_EFFORTS = {
  anthropic: ['low', 'medium', 'high', 'xhigh', 'max'],
  gemini: ['minimal', 'low', 'medium', 'high'],
  openai: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  openrouter: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  'custom-openai': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
};

export const normalizeReasoningEffort = (value) => EFFORT_ORDER.includes(value) ? value : null;
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

function effortValuesFromInfo(info) {
  const options = Array.isArray(info?.reasoning_options) ? info.reasoning_options : [];
  const values = options.flatMap((option) => (
    option?.type === 'effort' && Array.isArray(option.values) ? option.values : []
  ));
  return [...new Set(values.map((value) => String(value)))].filter((value) => EFFORT_ORDER.includes(value));
}

export function reasoningLevels(provider, model, info) {
  if (info?.reasoning === false) return [];
  // models.dev carries per-model effort lists (e.g. gpt-5.2: none..xhigh,
  // claude-opus-4-8: low..max); prefer them over hardcoded heuristics.
  const supported = PROVIDER_EFFORTS[provider] || [];
  const catalogValues = effortValuesFromInfo(info);
  const catalogLevels = EFFORT_ORDER.filter((effort) => supported.includes(effort) && catalogValues.includes(effort));
  if (catalogLevels.length) return catalogLevels;
  // Fallback for models without effort metadata in the catalog.
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

/** Test hook: drop the cached models.dev response so fetch can be re-mocked. */
export function resetReasoningCatalog() { catalogPromise = null; }

export function reasoningProviderOptions(provider, effort) {
  if (!normalizeReasoningEffort(effort)) return {};
  if (provider === 'anthropic') return { anthropic: { thinking: { type: 'adaptive' }, effort } };
  if (provider === 'gemini') return { google: { thinkingConfig: { thinkingLevel: effort, includeThoughts: true } } };
  if (provider === 'openrouter') return { openrouter: { reasoning: { effort } } };
  return { [provider]: { reasoningEffort: effort } };
}
