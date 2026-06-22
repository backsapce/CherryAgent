/**
 * Unified LLM Service for Vertex Agent.
 *
 * Provides a single API surface for the session UI regardless of which
 * provider is selected. Supports streaming responses.
 *
 * Usage:
 *   import llm from './models/llm';
 *
 *   // Configure once
 *   llm.configure({ provider: 'openai', apiKey: 'sk-...', model: 'gpt-4o' });
 *
 *   // Stream a response
 *   for await (const chunk of llm.streamSession(messages)) {
 *     process.stdout.write(chunk);
 *   }
 */

import openai from './providers/openai.js';
import anthropic from './providers/anthropic.js';
import gemini from './providers/gemini.js';
import openrouter from './providers/openrouter.js';
import qwen from './providers/qwen.js';
import deepseek from './providers/deepseek.js';
import customOpenai from './providers/custom-openai.js';
import { loadSettings, saveSettings } from './settings.js';
import { getModelContextWindowFallback } from './contextWindow.js';
import { jsonSchema, streamText, tool } from 'ai';
import { createLanguageModel, normalizeAiUsage, toModelMessages } from './ai.js';

// ─── Provider registry ──────────────────────────────────────────────────────

const providers = {
  openai,
  anthropic,
  gemini,
  openrouter,
  qwen,
  deepseek,
  'custom-openai': customOpenai,
};

// ─── Active config (in-memory) ──────────────────────────────────────────────

let activeProfileId = null;
let profiles = {};
let modelsDevCatalogPromise = null;

const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const MODELS_DEV_TIMEOUT_MS = 5000;
const MODELS_DEV_PROVIDER = {
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'google',
  qwen: 'alibaba',
  deepseek: 'deepseek',
  openrouter: 'openrouter',
};

function generateProfileId() {
  return `llm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultProfileName(cfg) {
  const providerName = providers[cfg.provider]?.name || cfg.provider || 'LLM';
  return cfg.model ? `${providerName} / ${cfg.model}` : providerName;
}

function normalizeProfile(id, cfg = {}) {
  const contextWindow = Number(cfg.contextWindow);
  const updatedAtMs = Number(cfg.updatedAtMs);
  return {
    id,
    name: cfg.name || defaultProfileName(cfg),
    provider: cfg.provider || null,
    apiKey: cfg.apiKey || null,
    baseUrl: cfg.baseUrl || null,
    model: cfg.model || null,
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
    ...(Number.isFinite(updatedAtMs) && updatedAtMs > 0 ? { updatedAtMs: Math.floor(updatedAtMs) } : {}),
  };
}

async function loadModelsDevCatalog() {
  if (!modelsDevCatalogPromise) {
    modelsDevCatalogPromise = new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), MODELS_DEV_TIMEOUT_MS);
      fetch(MODELS_DEV_API_URL, { signal: controller.signal })
        .then((res) => {
          clearTimeout(timeoutId);
          resolve(res);
        })
        .catch((err) => {
          clearTimeout(timeoutId);
          reject(err);
        });
    })
      .then((res) => {
        if (!res.ok) throw new Error(`models.dev error ${res.status}`);
        return res.json();
      })
      .catch((err) => {
        modelsDevCatalogPromise = null;
        throw err;
      });
  }
  return modelsDevCatalogPromise;
}

function normalizeModelsDevModelId(model) {
  return String(model || '').trim().replace(/^models\//, '');
}

function getModelsDevLimit(modelInfo) {
  const limit = modelInfo?.limit?.context ?? modelInfo?.context ?? modelInfo?.contextWindow;
  const numeric = Number(limit);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function getModelsDevProviderCandidates(providerId, modelId) {
  const candidates = [
    MODELS_DEV_PROVIDER[providerId],
    providerId,
  ];

  if ((providerId === 'openrouter' || providerId === 'custom-openai') && modelId?.includes('/')) {
    candidates.push(modelId.split('/')[0]);
  }

  return [...new Set(candidates.filter(Boolean))];
}

function getModelsDevModelCandidates(modelId) {
  const normalized = normalizeModelsDevModelId(modelId);
  const candidates = [normalized];
  if (normalized.includes('/')) {
    candidates.push(normalized.split('/').slice(1).join('/'));
  }
  candidates.push(normalized.replace(/(\d)\.(\d)/g, '$1-$2'));
  return [...new Set(candidates.filter(Boolean))];
}

function findModelsDevContextWindow(catalog, providerId, modelId) {
  const providerCandidates = getModelsDevProviderCandidates(providerId, modelId);
  const modelCandidates = getModelsDevModelCandidates(modelId);

  for (const candidateProvider of providerCandidates) {
    const provider = catalog?.[candidateProvider];
    if (!provider?.models) continue;
    for (const candidateModel of modelCandidates) {
      const limit = getModelsDevLimit(provider.models[candidateModel]);
      if (limit) return limit;
    }
  }

  for (const provider of Object.values(catalog || {})) {
    if (!provider?.models) continue;
    for (const candidateModel of modelCandidates) {
      const limit = getModelsDevLimit(provider.models[candidateModel]);
      if (limit) return limit;
    }
  }

  return null;
}

async function resolveContextWindow(providerId, modelId) {
  if (!providerId || !modelId) return null;
  try {
    const catalog = await loadModelsDevCatalog();
    return findModelsDevContextWindow(catalog, providerId, modelId)
      || getModelContextWindowFallback(providerId, modelId);
  } catch (err) {
    console.warn('Failed to fetch model context window from models.dev:', err.message);
    return getModelContextWindowFallback(providerId, modelId);
  }
}

function normalizeSettings(saved) {
  if (!saved) {
    return { activeProfileId: null, profiles: {} };
  }

  if (saved.profiles && typeof saved.profiles === 'object') {
    const normalized = {};
    for (const [id, profile] of Object.entries(saved.profiles)) {
      normalized[id] = normalizeProfile(id, profile);
    }
    const firstId = Object.keys(normalized)[0] || null;
    return {
      activeProfileId: saved.activeProfileId && normalized[saved.activeProfileId]
        ? saved.activeProfileId
        : firstId,
      profiles: normalized,
    };
  }

  // Legacy single-LLM config migration.
  if (saved.provider || saved.apiKey || saved.model || saved.baseUrl) {
    const id = saved.id || 'default';
    return {
      activeProfileId: id,
      profiles: {
        [id]: normalizeProfile(id, saved),
      },
    };
  }

  return { activeProfileId: null, profiles: {} };
}

function normalizeDeletedProfileIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id)).filter(Boolean))];
}

function getProfile(profileId = activeProfileId) {
  return profileId ? profiles[profileId] : null;
}

async function persistSettings({ deletedProfileId = null } = {}) {
  const saved = await loadSettings();
  const activeIds = new Set(Object.keys(profiles));
  const deletedProfileIds = normalizeDeletedProfileIds(saved?.deletedProfileIds)
    .filter((id) => !activeIds.has(id));
  if (deletedProfileId) {
    deletedProfileIds.push(String(deletedProfileId));
  }

  await saveSettings({
    activeProfileId,
    profiles,
    ...(deletedProfileIds.length > 0 ? { deletedProfileIds: [...new Set(deletedProfileIds)] } : {}),
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

const llm = {
  /**
   * List all registered providers with their metadata and models.
   * @returns {Array<{ id, name, models, defaultModel }>}
   */
  getProviders() {
    return Object.values(providers).map((p) => ({
      id: p.id,
      name: p.name,
      fallbackModels: p.fallbackModels,
      defaultModel: p.defaultModel,
      defaultBaseUrl: p.defaultBaseUrl,
      requiresBaseUrl: p.requiresBaseUrl || false,
    }));
  },

  /**
   * Get the currently active provider and model info.
   * @returns {{ provider, model, configured }}
   */
  getActiveConfig(profileId = activeProfileId) {
    const profile = getProfile(profileId);
    const p = providers[profile?.provider];
    const model = profile?.model || p?.defaultModel || null;
    const contextWindow = profile?.contextWindow
      || (profile?.provider && model ? getModelContextWindowFallback(profile.provider, model) : null);
    return {
      id: profile?.id || null,
      name: profile?.name || null,
      provider: profile?.provider || null,
      model,
      contextWindow,
      baseUrl: profile?.baseUrl || null,
      configured: !!(profile?.provider && profile?.apiKey),
      hasApiKey: !!profile?.apiKey,
    };
  },

  /**
   * Build a Vercel AI SDK model for a saved profile.
   * API keys remain local to the browser and are never returned by
   * getActiveConfig(), which is safe to use for UI rendering.
   */
  getLanguageModel(profileId = activeProfileId) {
    const profile = getProfile(profileId);
    const provider = providers[profile?.provider];
    if (!provider) {
      throw new Error('No LLM provider configured. Please set up a provider in Settings.');
    }
    if (!profile.apiKey) {
      throw new Error(`API key not set for ${provider.name}. Please add your key in Settings.`);
    }
    const model = profile.model || provider.defaultModel;
    if (!model) {
      throw new Error(`No model selected for ${provider.name}.`);
    }
    return createLanguageModel({
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl || provider.defaultBaseUrl,
      model,
    });
  },

  getProfiles() {
    return Object.values(profiles).map((profile) => llm.getActiveConfig(profile.id));
  },

  getActiveProfileId() {
    return activeProfileId;
  },

  /**
   * Fetch model list from a provider's API.
   * Falls back to hardcoded fallbackModels on error.
   * @param {string} providerId
   * @param {Object} config - { apiKey, baseUrl? }
   * @returns {Promise<Array<{ id, name }>>}
   */
  async fetchModels(providerId, config = {}, profileId = activeProfileId) {
    const provider = providers[providerId];
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    // Use saved API key as fallback when none is explicitly provided
    const profile = getProfile(profileId);
    const apiKey = config.apiKey || profile?.apiKey;
    if (!apiKey) return provider.fallbackModels;
    try {
      const models = await provider.listModels({ ...config, apiKey });
      return models.length > 0 ? models : provider.fallbackModels;
    } catch (err) {
      console.warn(`Failed to fetch models from ${provider.name}:`, err.message);
      return provider.fallbackModels;
    }
  },

  /**
   * Configure the active provider.
   * @param {Object} cfg - { provider, apiKey, baseUrl?, model? }
   */
  async configure(cfg) {
    if (cfg.provider && !providers[cfg.provider]) {
      throw new Error(`Unknown provider: ${cfg.provider}`);
    }

    const id = Object.prototype.hasOwnProperty.call(cfg, 'id')
      ? (cfg.id || generateProfileId())
      : (activeProfileId || generateProfileId());
    const previous = profiles[id] || { id };
    const clonedApiKey = cfg.cloneApiKeyFrom ? profiles[cfg.cloneApiKeyFrom]?.apiKey : null;
    const merged = {
      ...previous,
      ...cfg,
      apiKey: cfg.apiKey || previous.apiKey || clonedApiKey,
      updatedAtMs: Date.now(),
    };
    const modelChanged = previous.provider !== merged.provider || previous.model !== merged.model;
    const effectiveModel = merged.model || providers[merged.provider]?.defaultModel;
    const requestedContextWindow = Number(cfg.contextWindow);
    const hasContextWindowOverride = Object.prototype.hasOwnProperty.call(cfg, 'contextWindow')
      && Number.isFinite(requestedContextWindow)
      && requestedContextWindow > 0;
    const shouldResolveContextWindow = !hasContextWindowOverride
      && (Object.prototype.hasOwnProperty.call(cfg, 'contextWindow') || modelChanged || !previous.contextWindow);
    const contextWindow = hasContextWindowOverride
      ? Math.floor(requestedContextWindow)
      : (shouldResolveContextWindow ? await resolveContextWindow(merged.provider, effectiveModel) : previous.contextWindow);
    const next = normalizeProfile(id, { ...merged, contextWindow });
    profiles = { ...profiles, [id]: next };
    activeProfileId = id;
    await persistSettings();
    return llm.getActiveConfig(id);
  },

  async selectProfile(profileId) {
    if (profileId && !profiles[profileId]) {
      throw new Error(`Unknown LLM profile: ${profileId}`);
    }
    activeProfileId = profileId || null;
    await persistSettings();
    return llm.getActiveConfig();
  },

  async deleteProfile(profileId) {
    if (!profiles[profileId]) return llm.getActiveConfig();
    const nextProfiles = { ...profiles };
    delete nextProfiles[profileId];
    profiles = nextProfiles;
    if (activeProfileId === profileId) {
      activeProfileId = Object.keys(profiles)[0] || null;
    }
    await persistSettings({ deletedProfileId: profileId });
    return llm.getActiveConfig();
  },

  /**
   * Load persisted settings from OPFS (call once at app startup).
   */
  async init() {
    const saved = await loadSettings();
    const normalized = normalizeSettings(saved);
    activeProfileId = normalized.activeProfileId;
    profiles = normalized.profiles;
    if (saved && !saved.profiles && activeProfileId) {
      await persistSettings();
    }
    return llm.getActiveConfig();
  },

  /**
   * Backward-compatible stream adapter over AI SDK events.
   * New agent code should consume streamText().fullStream through agent/events.
   */
  async *streamSession(messages, opts = {}) {
    const fullMessages = opts.systemPrompt
      ? [{ role: 'system', content: opts.systemPrompt }, ...messages]
      : messages;
    const tools = createAiTools(opts.tools);
    const result = streamText({
      model: llm.getLanguageModel(opts.llmProfileId),
      messages: toModelMessages(fullMessages),
      ...(Object.keys(tools).length ? { tools } : {}),
      ...(opts.signal ? { abortSignal: opts.signal } : {}),
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens != null ? { maxOutputTokens: opts.maxTokens } : {}),
      maxRetries: 0,
    });

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') yield { content: part.text };
      else if (part.type === 'reasoning-delta') yield { reasoning: part.text };
      else if (part.type === 'tool-call') {
        yield {
          toolCalls: [{
            id: part.toolCallId,
            name: part.toolName,
            arguments: JSON.stringify(part.input || {}),
          }],
        };
      } else if (part.type === 'finish') {
        yield { usage: normalizeAiUsage(part.totalUsage) };
      } else if (part.type === 'error') {
        throw part.error;
      }
    }
  },

  /**
   * Convenience: collect the full response as a single string.
   * @param {Array} messages
   * @param {Object} [opts]
   * @returns {Promise<string>}
   */
  async completeSession(messages, opts = {}) {
    const result = streamText({
      model: llm.getLanguageModel(opts.llmProfileId),
      messages: toModelMessages(opts.systemPrompt
        ? [{ role: 'system', content: opts.systemPrompt }, ...messages]
        : messages),
      ...(opts.signal ? { abortSignal: opts.signal } : {}),
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens != null ? { maxOutputTokens: opts.maxTokens } : {}),
      maxRetries: 0,
    });
    let content = '';
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') content += part.text;
      else if (part.type === 'error') throw part.error;
    }
    return content;
  },

  /**
   * Check if the service is configured and ready.
   * @returns {boolean}
   */
  isConfigured() {
    const profile = getProfile();
    return !!(profile?.provider && profile?.apiKey);
  },

  isProfileConfigured(profileId = activeProfileId) {
    const profile = getProfile(profileId);
    return !!(profile?.provider && profile?.apiKey);
  },
};

function createAiTools(schemas = []) {
  return Object.fromEntries((schemas || []).map((schema) => [
    schema.name,
    tool({
      description: schema.description,
      inputSchema: jsonSchema(schema.parameters || { type: 'object', properties: {} }),
    }),
  ]));
}

export default llm;
