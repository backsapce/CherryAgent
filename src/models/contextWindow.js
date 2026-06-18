import { getContext } from 'tokenlens';

const TOKENLENS_PROVIDER = {
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'google',
  qwen: 'alibaba',
  openrouter: 'openrouter',
  deepseek: 'deepseek',
};

const FALLBACK_WINDOWS = {
  anthropic: 200_000,
  openai: 128_000,
  gemini: 1_000_000,
  openrouter: 128_000,
  qwen: 1_000_000,
  deepseek: 128_000,
  'custom-openai': 128_000,
};

export function getModelContextWindowFallback(provider, model) {
  const modelWindow = getModelSpecificContextWindow(model);
  if (modelWindow) return modelWindow;
  return FALLBACK_WINDOWS[provider] || 128_000;
}

export function getStaticContextWindow(provider, model) {
  const tokenlensWindow = getTokenlensContextWindow(provider, model);
  if (tokenlensWindow) return tokenlensWindow;
  return getModelContextWindowFallback(provider, model);
}

function getTokenlensContextWindow(provider, model) {
  if (!model) return null;
  const tlProvider = TOKENLENS_PROVIDER[provider];
  const ids = [];
  if (tlProvider) {
    ids.push(`${tlProvider}:${model}`);
    ids.push(`${tlProvider}:${normalizeModelSeparators(model)}`);
  }
  ids.push(model);
  ids.push(normalizeModelSeparators(model));

  for (const mid of [...new Set(ids.filter(Boolean))]) {
    try {
      const ctx = getContext({ modelId: mid });
      if (ctx.maxTotal || ctx.combinedMax) return ctx.maxTotal || ctx.combinedMax;
    } catch {
      // tokenlens does not know every provider model.
    }
  }

  return null;
}

function getModelSpecificContextWindow(model) {
  const m = String(model || '').toLowerCase().trim();
  if (!m) return null;

  if (isQwenMillionTokenModel(m)) return 1_000_000;
  if (m.startsWith('qwen3-') || m.startsWith('qwen-m') || m.startsWith('qwen-p')) return 262_144;
  if (m === 'qwen-turbo') return 262_144;
  if (m.startsWith('deepseek-v4-')) return 1_000_000;
  if (m.startsWith('deepseek-')) return 128_000;
  return null;
}

function isQwenMillionTokenModel(model) {
  return /^qwen3[.-][5-9](?:[.-]|$)/.test(model);
}

function normalizeModelSeparators(model) {
  return String(model || '').replace(/(\d)\.(\d)/g, '$1-$2');
}
