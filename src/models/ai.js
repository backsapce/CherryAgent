/**
 * AI SDK model factory.
 *
 * This keeps provider construction in one place while allowing the rest of
 * the app to use the provider-neutral Vercel AI SDK APIs.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const DEFAULT_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  openrouter: 'https://openrouter.ai/api/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  deepseek: 'https://api.deepseek.com',
};

/**
 * Create an AI SDK language model from a saved VertexAgent profile.
 *
 * The application intentionally creates a provider per request: profiles can
 * change at runtime and each request must use the selected session profile.
 */
export function createLanguageModel(config = {}) {
  const provider = config.provider;
  const apiKey = config.apiKey;
  const model = config.model;
  const baseUrl = withoutTrailingSlash(config.baseUrl || DEFAULT_BASE_URLS[provider] || '');

  if (!provider || !apiKey || !model) {
    throw new Error('An LLM provider, API key, and model are required.');
  }

  switch (provider) {
    case 'openai':
      return createOpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) }).chat(model);
    case 'anthropic':
      return createAnthropic({
        apiKey,
        baseURL: anthropicBaseUrl(baseUrl),
        // The app is intentionally browser-first. Anthropic requires this
        // acknowledgement header for direct browser requests.
        headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
      }).messages(model);
    case 'gemini':
      return createGoogleGenerativeAI({
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
          'HTTP-Referer': globalThis.location?.href || 'https://vertex-agent.local',
          'X-Title': 'Vertex Agent',
        },
      });
    case 'qwen':
    case 'deepseek':
    case 'custom-openai':
      return createCompatibleModel({ provider, apiKey, baseUrl, model });
    default:
      throw new Error(`Unsupported AI SDK provider: ${provider}`);
  }
}

/** Convert AI SDK usage into the persisted VertexAgent usage shape. */
export function normalizeAiUsage(usage) {
  const prompt = numberOrZero(usage?.inputTokens ?? usage?.prompt_tokens ?? usage?.input_tokens);
  const completion = numberOrZero(usage?.outputTokens ?? usage?.completion_tokens ?? usage?.output_tokens);
  const total = numberOrZero(usage?.totalTokens ?? usage?.total_tokens) || prompt + completion;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
}

/** Convert VertexAgent's persisted message shape into AI SDK ModelMessages. */
export function toModelMessages(messages = []) {
  return messages
    .filter((message) => message?.role === 'system' || message?.role === 'user' || message?.role === 'assistant')
    .map((message) => {
      if (message.role === 'system') {
        return { role: 'system', content: String(message.content || '') };
      }

      if (message.role === 'assistant') {
        return { role: 'assistant', content: String(message.content || '') };
      }

      const images = Array.isArray(message.images) ? message.images : [];
      if (images.length === 0) {
        return { role: 'user', content: String(message.content || '') };
      }

      const parts = images
        .filter((image) => image?.dataUrl)
        .map((image) => ({
          type: 'image',
          // AI SDK image parts accept base64 data, not a complete data URL.
          image: imageData(image.dataUrl),
          mediaType: imageMediaType(image.dataUrl, image.type),
        }));
      if (message.content) parts.push({ type: 'text', text: String(message.content) });
      return { role: 'user', content: parts.length ? parts : String(message.content || '') };
    });
}

function createCompatibleModel({ provider, apiKey, baseUrl, model, headers }) {
  if (!baseUrl) {
    throw new Error(`A base URL is required for ${provider}.`);
  }
  return createOpenAICompatible({
    name: provider,
    apiKey,
    baseURL: baseUrl,
    includeUsage: true,
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
