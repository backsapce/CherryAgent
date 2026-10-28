/**
 * Provider/model logo resolution against models.dev.
 *
 * Logos are hotlinked as SVG: https://models.dev/logos/{provider}.svg
 * They are monochrome (fill="currentColor"), which resolves to black inside
 * an <img>, so themes flip them with a CSS invert filter. Unknown providers
 * are served models.dev's generic fallback logo (never a 404); the UI-level
 * component additionally falls back to a local icon on network errors.
 */

export const MODELS_DEV_LOGOS_URL = 'https://models.dev/logos';

/**
 * CherryAgent provider type → models.dev provider id.
 * (Kept in sync with the context-window lookup in llm.js, which imports it.)
 */
export const MODELS_DEV_PROVIDER = {
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'google',
  qwen: 'alibaba',
  deepseek: 'deepseek',
  openrouter: 'openrouter',
};

/**
 * Model-family patterns → models.dev provider ids. Custom OpenAI-compatible
 * endpoints routinely serve another lab's models, and their ids arrive
 * without the routing prefix OpenRouter uses (`gpt-4o`, `kimi-k2`, ...).
 * The pattern list recovers the lab from the model name itself.
 *
 * Order matters: deepseek before alibaba/meta (its distilled qwen/llama
 * releases belong to DeepSeek), openai's `o1`-style ids before anything that
 * could start with `o`, and loose keywords (`nova`, `llama`) after the
 * distinctive ones to avoid false positives.
 */
const MODEL_FAMILY_PATTERNS = [
  [/^o\d/, 'openai'],
  [/gpt|chatgpt|davinci|whisper/, 'openai'],
  [/claude/, 'anthropic'],
  [/gemini|gemma|nano-banana/, 'google'],
  [/deepseek/, 'deepseek'],
  [/qwen|qwq|qvq/, 'alibaba'],
  [/kimi|moonshot/, 'moonshotai'],
  [/glm|chatglm/, 'zhipuai'],
  [/grok/, 'xai'],
  [/minimax/, 'minimax'],
  [/mistral|mixtral|ministral|codestral|pixtral|magistral/, 'mistral'],
  [/ernie/, 'baidu'],
  [/hunyuan/, 'tencent'],
  [/nova/, 'amazon'],
  [/llama/, 'meta'],
  [/nemotron/, 'nvidia'],
  [/^phi/, 'microsoft'],
  [/command|c4ai/, 'cohere'],
  [/^flux/, 'black-forest-labs'],
];

/**
 * Best-effort lab behind a bare model id. Matches the segment after the last
 * `/` so routed ids (`openrouter/anthropic/claude-...`) resolve to the lab,
 * not the router. Returns a models.dev provider id or null for names no
 * pattern recognises — callers keep their own fallback icon for those.
 */
export function inferModelFamilyProvider(modelId) {
  const id = String(modelId || '').toLowerCase().trim().replace(/^models\//, '');
  if (!id) return null;
  const lastSegment = id.slice(id.lastIndexOf('/') + 1);
  for (const [pattern, provider] of MODEL_FAMILY_PATTERNS) {
    if (pattern.test(lastSegment)) return provider;
  }
  return null;
}

/**
 * Provider id candidates for models.dev lookups, ordered for catalog queries
 * (context windows): the connection's own provider first, then the lab prefix
 * embedded in routed model ids (`anthropic/claude-...` via OpenRouter or an
 * OpenAI-compatible endpoint), then the lab inferred from a bare model name
 * (`custom-openai` + `gpt-4o` is an OpenAI model).
 */
export function getModelsDevProviderCandidates(providerId, modelId) {
  const candidates = [
    MODELS_DEV_PROVIDER[providerId],
    providerId,
  ];

  if ((providerId === 'openrouter' || providerId === 'custom-openai') && modelId?.includes('/')) {
    candidates.push(modelId.split('/')[0]);
  }
  candidates.push(inferModelFamilyProvider(modelId));

  return [...new Set(candidates.filter(Boolean))];
}

/**
 * Best models.dev provider id for a model's *display logo*. Unlike catalog
 * lookups, display prefers the lab behind the model: the routing prefix first
 * (`anthropic/claude-...` shows Anthropic, not the router's), then the
 * connection's provider type, then the lab inferred from a bare model name —
 * custom endpoints serving standard models (`gpt-4o` via custom-openai) get
 * the real lab's logo. Returns null when nothing plausible is known —
 * callers then render their own default icon instead of a wildcard hotlink.
 */
export function modelLogoId(providerId, modelId) {
  const candidates = [];

  if ((providerId === 'openrouter' || providerId === 'custom-openai') && modelId?.includes('/')) {
    candidates.push(modelId.split('/')[0]);
  }
  candidates.push(MODELS_DEV_PROVIDER[providerId]);
  candidates.push(inferModelFamilyProvider(modelId));
  candidates.push(providerId);

  // `custom-openai` is a CherryAgent-side type, never a models.dev provider.
  const id = [...new Set(candidates.filter(Boolean))].find((candidate) => candidate !== 'custom-openai');
  return id || null;
}

/** Full hotlink URL for a provider/model pair, or null when unknown. */
export function modelLogoUrl(providerId, modelId) {
  const id = modelLogoId(providerId, modelId);
  return id ? `${MODELS_DEV_LOGOS_URL}/${encodeURIComponent(id)}.svg` : null;
}
