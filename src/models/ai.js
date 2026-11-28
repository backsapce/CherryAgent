import { wrapLanguageModel } from 'ai';
import { projectAssistantHistory } from '../agent/sessionHistory.js';
import { resolveCustomOpenAiEndpoint } from './providers/custom-openai.js';
import {
  resolveReasoningLevels,
  reasoningProviderOptions,
  summaryProviderOptions,
} from './reasoning.js';
/**
 * AI SDK model factory.
 *
 * This keeps provider construction in one place while allowing the rest of
 * the app to use the provider-neutral Vercel AI SDK APIs.
 */


const DEFAULT_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  openrouter: 'https://openrouter.ai/api/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  deepseek: 'https://api.deepseek.com',
};

/**
 * Create an AI SDK language model from a saved CherryAgent profile.
 *
 * The application intentionally creates a provider per request: profiles can
 * change at runtime and each request must use the selected session profile.
 */
export async function createLanguageModel(config = {}) {
  config = { ...config };
  const endpoint = config.provider === 'custom-openai' ? resolveCustomOpenAiEndpoint(config.baseUrl) : null;
  const customResponses = endpoint?.api === 'responses';
  const model = await createBaseLanguageModel(config, endpoint);
  const effort = config.reasoningEffort;
  const optionProvider = customResponses ? 'openai' : config.provider;
  const effortOptions = reasoningProviderOptions(optionProvider, effort);
  const wantsEffort = Object.keys(effortOptions).length > 0;
  const wantsSummary = customResponses || (config.provider === 'openai' && isOfficialOpenAiEndpoint(config.baseUrl));
  if (!wantsEffort && !wantsSummary) return model;
  let levelsPromise;
  return wrapLanguageModel({ model, middleware: {
    specificationVersion: 'v3',
    ...(customResponses ? { wrapStream: streamCustomResponses } : {}),
    async transformParams({ params }) {
      // Keep the fallback for this model instance, too: each step should not
      // wait for another request to an unavailable catalog.
      const levels = await (levelsPromise ||= resolveReasoningLevels(config.provider, config.model, {
        allowUnknown: customResponses && wantsEffort,
      }));
      const sources = [
        ...(wantsEffort && levels.includes(effort) ? [effortOptions] : []),
        ...(wantsSummary && levels.length > 0 ? [summaryProviderOptions(optionProvider)] : []),
      ];
      // Merge the option sets per provider name so
      // summary options do not overwrite the effort options.
      const options = {};
      for (const source of sources) {
        for (const [key, value] of Object.entries(source)) {
          options[key] = { ...options[key], ...value };
        }
      }
      if (!customResponses && Object.keys(options).length === 0) return params;
      const providerOptions = { ...params.providerOptions };
      for (const [key, value] of Object.entries(options)) {
        providerOptions[key] = { ...value, ...providerOptions[key] };
      }
      if (!customResponses) return { ...params, providerOptions };
      // CherryAgent owns the history (including compaction and wake-ups), so
      // never replace it with provider-side conversation/item references.
      const { previousResponseId: _previousResponseId, conversation: _conversation, ...openai } = providerOptions.openai || {};
      providerOptions.openai = {
        ...openai,
        store: false,
        ...(params.tools?.length ? { parallelToolCalls: false } : {}),
      };
      return {
        ...params,
        providerOptions,
        // Agent schemas have optional arguments. Prevent Responses from
        // implicitly normalizing them into strict, all-required schemas.
        tools: params.tools?.map((tool) => tool.type === 'function'
          ? { ...tool, strict: tool.strict ?? false }
          : tool),
      };
    },
  } });
}

// The SDK maps response.failed to a finish reason but omits the provider's
// error. Surface it as a stream error rather than accepting partial output or
// retrying an API failure as if it were an empty response.
async function streamCustomResponses({ model, params }) {
  const result = await model.doStream({ ...params, includeRawChunks: true });
  return {
    ...result,
    stream: result.stream.pipeThrough(new TransformStream({
      transform(part, controller) {
        if (part.type === 'raw') {
          const event = part.rawValue;
          if (event?.type === 'response.failed' || event?.type === 'error') {
            const error = event.response?.error ?? event.error ?? event;
            controller.enqueue({ type: 'error', error: new Error(error.message || 'The Responses endpoint reported a stream failure.') });
            controller.terminate();
            return;
          }
          if (!params.includeRawChunks) return;
        }
        controller.enqueue(part);
      },
    })),
  };
}

/**
 * Hosted OpenAI reasoning models (gpt-5.x, gpt-sol, o-series) never expose
 * their chain of thought through Chat Completions; only the Responses API
 * streams reasoning summaries. Custom base URLs usually point at chat-only
 * proxies, so they keep the Chat Completions protocol.
 */
function isOfficialOpenAiEndpoint(baseUrl) {
  if (!baseUrl) return true;
  try {
    return new URL(baseUrl).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

async function createBaseLanguageModel(config, endpoint) {
  const provider = config.provider;
  const apiKey = config.apiKey;
  const model = config.model;
  const baseUrl = withoutTrailingSlash(config.baseUrl || DEFAULT_BASE_URLS[provider] || '');

  if (!provider || !apiKey || !model) {
    throw new Error('An LLM provider, API key, and model are required.');
  }

  switch (provider) {
    case 'openai': {
      const openai = (await import('@ai-sdk/openai')).createOpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
      return isOfficialOpenAiEndpoint(baseUrl) ? openai.responses(model) : openai.chat(model);
    }
    case 'anthropic':
      return (await import('@ai-sdk/anthropic')).createAnthropic({
        apiKey,
        baseURL: anthropicBaseUrl(baseUrl),
        // The app is intentionally browser-first. Anthropic requires this
        // acknowledgement header for direct browser requests.
        headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
      }).messages(model);
    case 'gemini':
      return (await import('@ai-sdk/google')).createGoogleGenerativeAI({
        apiKey,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
      })(model);
    case 'openrouter':
      return createCompatibleModel({
        provider,
        apiKey,
        baseUrl,
        model,
        headers: {
          'HTTP-Referer': globalThis.location?.href || 'https://cherry-agent.local',
          'X-Title': 'Cherry Agent',
        },
      });
    case 'qwen':
    case 'deepseek':
      return createCompatibleModel({ provider, apiKey, baseUrl, model });
    case 'custom-openai': {
      if (!endpoint?.baseUrl) throw new Error(`A base URL is required for ${provider}.`);
      const fetch = endpoint.query ? (url, init) => globalThis.fetch(`${url}${endpoint.query}`, init) : undefined;
      if (endpoint.api === 'responses') {
        return (await import('@ai-sdk/openai')).createOpenAI({
          name: provider, apiKey, baseURL: endpoint.baseUrl, fetch,
        }).responses(model);
      }
      return createCompatibleModel({ provider, apiKey, baseUrl: endpoint.baseUrl, model, fetch });
    }
    default:
      throw new Error(`Unsupported AI SDK provider: ${provider}`);
  }
}

/** Convert AI SDK usage into the persisted CherryAgent usage shape. */
export function normalizeAiUsage(usage) {
  const prompt = numberOrZero(usage?.inputTokens ?? usage?.prompt_tokens ?? usage?.input_tokens);
  const completion = numberOrZero(usage?.outputTokens ?? usage?.completion_tokens ?? usage?.output_tokens);
  const total = numberOrZero(usage?.totalTokens ?? usage?.total_tokens) || prompt + completion;
  const cached = usage?.inputTokenDetails?.cacheReadTokens
    ?? usage?.cachedInputTokens
    ?? usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.cache_read_input_tokens
    ?? usage?.cached_tokens;
  return {
    ...(Number.isFinite(cached) && cached >= 0 ? { cached_tokens: cached } : {}),
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
}

/** Convert CherryAgent's persisted message shape into AI SDK ModelMessages. */
export function toModelMessages(messages = [], { contextWindow, usedCallIds = new Set() } = {}) {
  return messages.flatMap((message) => {
    if (message?.role === 'assistant') return projectAssistantHistory(message, { contextWindow, usedCallIds });
    if (message?.role === 'system') return [{ role: 'system', content: String(message.content || '') }];
    if (message?.role !== 'user') return [];

    const parts = (Array.isArray(message.images) ? message.images : [])
      .filter((image) => image?.dataUrl)
      .map((image) => ({
        type: 'image',
        // AI SDK image parts accept base64 data, not a complete data URL.
        image: imageData(image.dataUrl),
        mediaType: imageMediaType(image.dataUrl, image.type),
      }));
    const content = String(message.content || '');
    if (!parts.length) return [{ role: 'user', content }];
    if (content) parts.push({ type: 'text', text: content });
    return [{ role: 'user', content: parts }];
  });
}

async function createCompatibleModel({ provider, apiKey, baseUrl, model, headers, fetch }) {
  if (!baseUrl) {
    throw new Error(`A base URL is required for ${provider}.`);
  }
  return (await import('@ai-sdk/openai-compatible')).createOpenAICompatible({
    name: provider,
    apiKey,
    baseURL: baseUrl,
    includeUsage: true,
    ...(fetch ? { fetch } : {}),
    ...(headers ? { headers } : {}),
  }).chatModel(model);
}

function anthropicBaseUrl(baseUrl) {
  if (!baseUrl) return 'https://api.anthropic.com/v1';
  return /\/v1(?:\/|$)/.test(baseUrl) ? baseUrl : `${baseUrl}/v1`;
}

function imageMediaType(dataUrl, fallback) {
  return /^data:([^;,]+)[;,]/i.exec(dataUrl || '')?.[1] || fallback || 'image/jpeg';
}

function imageData(dataUrl) {
  const commaIndex = String(dataUrl || '').indexOf(',');
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}

function withoutTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
