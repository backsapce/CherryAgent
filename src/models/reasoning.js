import { loadModelsDevCatalog } from './modelsDevCatalog.js';

export { resetModelsDevCatalog as resetReasoningCatalog } from './modelsDevCatalog.js';

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

export async function resolveReasoningLevels(provider, model, { allowUnknown = false } = {}) {
  const supported = PROVIDER_EFFORTS[provider];
  if (!supported?.length) return [];
  // Private gateway aliases need an opt-in effort picker even without
  // catalog metadata. With no selected effort, the request stays automatic.
  const fallback = allowUnknown ? supported : [];
  try {
    const data = await loadModelsDevCatalog();
    const providerId = { gemini: 'google', qwen: 'alibaba' }[provider] || provider;
    const id = String(model || '').replace(/^models\//, '');
    let info = data[providerId]?.models?.[id];
    if (!info && ['custom-openai', 'openrouter'].includes(provider)) {
      const bare = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
      info = Object.values(data).map((entry) => entry.models?.[id] || entry.models?.[bare]).find(Boolean);
    }
    return info ? reasoningLevels(provider, id, info) : fallback;
  } catch { return fallback; }
}

export function reasoningProviderOptions(provider, effort) {
  if (!PROVIDER_EFFORTS[provider]?.includes(effort)) return {};
  if (provider === 'anthropic') return { anthropic: { thinking: { type: 'adaptive' }, effort } };
  if (provider === 'gemini') return { google: { thinkingConfig: { thinkingLevel: effort, includeThoughts: true } } };
  if (provider === 'openrouter') return { openrouter: { reasoning: { effort } } };
  if (provider === 'openai') {
    return { openai: { reasoningEffort: effort, ...reasoningSummaryOptions.openai } };
  }
  return { [provider]: { reasoningEffort: effort } };
}

// Hosted OpenAI reasoning models (gpt-5.x, gpt-sol, o-series) hide the raw
// chain of thought; the Responses API can instead stream a summarized
// "thinking overview" (the bold-headed summaries the ChatGPT UI shows).
// `summary: 'auto'` asks for those summaries, and `forceReasoning` bypasses
// the SDK's built-in model-id allowlist (o1/o3/o4-mini/gpt-5), which does not
// know newer families like gpt-sol and would silently drop the reasoning
// parameters from the request body.
const reasoningSummaryOptions = { openai: { reasoningSummary: 'auto', forceReasoning: true } };

/** Provider options that request reasoning summaries without an effort level. */
export function summaryProviderOptions(provider) {
  if (provider !== 'openai') return {};
  return reasoningSummaryOptions;
}
