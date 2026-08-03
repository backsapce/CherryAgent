/**
 * Unified LLM Service for Vertex Agent.
 *
 * Provider connections own credentials/endpoints. LLM records reference one
 * connection and select a concrete model, so many LLMs can reuse a connection
 * and the same model can be routed through different connections.
 *
 * Usage:
 *   import llm from './models/llm';
 *
 *   const provider = await llm.configureProvider({ type: 'openai', apiKey: 'sk-...' });
 *   await llm.configureLlm({ providerId: provider.id, model: 'gpt-4o' });
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
import {
  LLM_SETTINGS_SCHEMA_VERSION,
  defaultLlmName,
  defaultProviderName,
  normalizeLlmConfig,
  normalizeLlmSettings,
  normalizeProviderConfig,
} from './llmSettingsSchema.js';

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

let activeLlmId = null;
let providerConfigs = {};
let llms = {};
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

function generateLlmId() {
  return `llm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateProviderId() {
  return `provider_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function uniqueName(baseName, records, exceptId = null) {
  const base = String(baseName || '').trim() || 'Provider';
  const used = new Set(Object.values(records)
    .filter((record) => record.id !== exceptId)
    .map((record) => record.name));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}

function getProviderConfig(providerId) {
  return providerId ? providerConfigs[providerId] : null;
}

function getLlm(llmId = activeLlmId) {
  return llmId ? llms[llmId] : null;
}

function providerIsConfigured(providerConfig) {
  const adapter = providers[providerConfig?.type];
  return Boolean(
    adapter
    && providerConfig?.apiKey
    && (!adapter.requiresBaseUrl || providerConfig.baseUrl)
  );
}

function publicProviderConfig(providerConfig) {
  if (!providerConfig) return null;
  const adapter = providers[providerConfig.type];
  return {
    id: providerConfig.id,
    name: providerConfig.name,
    type: providerConfig.type,
    baseUrl: providerConfig.baseUrl || null,
    configured: providerIsConfigured(providerConfig),
    hasApiKey: Boolean(providerConfig.apiKey),
    requiresBaseUrl: Boolean(adapter?.requiresBaseUrl),
    updatedAtMs: providerConfig.updatedAtMs || null,
  };
}

function publicLlm(llmConfig) {
  if (!llmConfig) {
    return {
      id: null,
      name: null,
      providerId: null,
      providerName: null,
      provider: null,
      model: null,
      contextWindow: null,
      baseUrl: null,
      configured: false,
      hasApiKey: false,
    };
  }
  const providerConfig = getProviderConfig(llmConfig.providerId);
  const adapter = providers[providerConfig?.type];
  const model = llmConfig.model || adapter?.defaultModel || null;
  const contextWindow = llmConfig.contextWindow
    || (providerConfig?.type && model
      ? getModelContextWindowFallback(providerConfig.type, model)
      : null);
  return {
    id: llmConfig.id,
    name: llmConfig.name,
    providerId: providerConfig?.id || llmConfig.providerId || null,
    providerName: providerConfig?.name || null,
    provider: providerConfig?.type || null,
    model,
    contextWindow,
    baseUrl: providerConfig?.baseUrl || null,
    configured: Boolean(providerIsConfigured(providerConfig) && model),
    hasApiKey: Boolean(providerConfig?.apiKey),
    updatedAtMs: llmConfig.updatedAtMs || null,
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

function normalizeDeletedIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id)).filter(Boolean))];
}

async function persistSettings({ deletedLlmId = null, deletedProviderId = null } = {}) {
  const saved = await loadSettings();
  const activeLlmIds = new Set(Object.keys(llms));
  const activeProviderIds = new Set(Object.keys(providerConfigs));
  const deletedLlmIds = normalizeDeletedIds([
    ...(saved?.deletedLlmIds || []),
    ...(saved?.deletedProfileIds || []),
  ]).filter((id) => !activeLlmIds.has(id));
  const deletedProviderIds = normalizeDeletedIds(saved?.deletedProviderIds)
    .filter((id) => !activeProviderIds.has(id));
  if (deletedLlmId) deletedLlmIds.push(String(deletedLlmId));
  if (deletedProviderId) deletedProviderIds.push(String(deletedProviderId));

  await saveSettings({
    schemaVersion: LLM_SETTINGS_SCHEMA_VERSION,
    activeLlmId,
    providers: providerConfigs,
    llms,
    deletedProviderIds: [...new Set(deletedProviderIds)],
    deletedLlmIds: [...new Set(deletedLlmIds)],
  });
}

function providerTypeMetadata() {
  return providers;
}

async function listModels(adapter, config) {
  if (!config.apiKey) return adapter.fallbackModels;
  try {
    const models = await adapter.listModels(config);
    return models.length > 0 ? models : adapter.fallbackModels;
  } catch (err) {
    console.warn(`Failed to fetch models from ${adapter.name}:`, err.message);
    return adapter.fallbackModels;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

const llm = {
  getProviderTypes() {
    return Object.values(providers).map((p) => ({
      id: p.id,
      name: p.name,
      fallbackModels: p.fallbackModels,
      defaultModel: p.defaultModel,
      defaultBaseUrl: p.defaultBaseUrl,
      requiresBaseUrl: p.requiresBaseUrl || false,
    }));
  },

  // Backward-compatible name for the provider adapter/type catalog.
  getProviders() {
    return llm.getProviderTypes();
  },

  getProviderConfigs() {
    return Object.values(providerConfigs).map(publicProviderConfig);
  },

  getActiveConfig(llmId = activeLlmId) {
    return publicLlm(getLlm(llmId));
  },

  getLlms() {
    return Object.values(llms).map(publicLlm);
  },

  getProfiles() {
    return llm.getLlms();
  },

  getActiveLlmId() {
    return activeLlmId;
  },

  getActiveProfileId() {
    return activeLlmId;
  },

  /**
   * Return the complete profile for execution in a user-selected remote
   * runtime. Callers must only send this over an authenticated HTTPS channel.
   */
  getRuntimeConfig(llmId = activeLlmId) {
    const llmConfig = getLlm(llmId);
    const providerConfig = getProviderConfig(llmConfig?.providerId);
    const provider = providers[providerConfig?.type];
    const model = llmConfig?.model || provider?.defaultModel;
    if (!providerIsConfigured(providerConfig) || !model) {
      throw new Error('A configured LLM profile is required for sandbox runtime.');
    }
    return {
      provider: providerConfig.type,
      apiKey: providerConfig.apiKey,
      baseUrl: providerConfig.baseUrl || provider.defaultBaseUrl || null,
      model,
      contextWindow: llmConfig.contextWindow || null,
    };
  },

  /**
   * Build a Vercel AI SDK model for a saved profile.
   * API keys remain local to the browser and are never returned by
   * getActiveConfig(), which is safe to use for UI rendering.
   */
  getLanguageModel(llmId = activeLlmId) {
    const llmConfig = getLlm(llmId);
    const providerConfig = getProviderConfig(llmConfig?.providerId);
    const provider = providers[providerConfig?.type];
    if (!provider) {
      throw new Error('No LLM provider configured. Please set up a provider in Settings.');
    }
    if (!providerConfig.apiKey) {
      throw new Error(`API key not set for ${providerConfig.name}. Please add your key in Settings.`);
    }
    if (provider.requiresBaseUrl && !providerConfig.baseUrl) {
      throw new Error(`Base URL not set for ${providerConfig.name}. Please add it in Settings.`);
    }
    const model = llmConfig?.model || provider.defaultModel;
    if (!model) {
      throw new Error(`No model selected for ${providerConfig.name}.`);
    }
    return createLanguageModel({
      provider: providerConfig.type,
      apiKey: providerConfig.apiKey,
      baseUrl: providerConfig.baseUrl || provider.defaultBaseUrl,
      model,
    });
  },

  async fetchProviderModels(providerId, config = {}) {
    const providerConfig = getProviderConfig(providerId);
    if (!providerConfig) throw new Error(`Unknown provider configuration: ${providerId}`);
    const adapter = providers[providerConfig.type];
    if (!adapter) throw new Error(`Unknown provider type: ${providerConfig.type}`);
    return listModels(adapter, {
      ...config,
      apiKey: config.apiKey || providerConfig.apiKey,
      baseUrl: config.baseUrl || providerConfig.baseUrl || adapter.defaultBaseUrl,
    });
  },

  /** Backward-compatible adapter-type model lookup. */
  async fetchModels(providerId, config = {}, profileId = activeLlmId) {
    if (providerConfigs[providerId]) return llm.fetchProviderModels(providerId, config);
    const adapter = providers[providerId];
    if (!adapter) throw new Error(`Unknown provider: ${providerId}`);
    const llmConfig = getLlm(profileId);
    const savedProvider = getProviderConfig(llmConfig?.providerId);
    const matchingProvider = savedProvider?.type === providerId ? savedProvider : null;
    return listModels(adapter, {
      ...config,
      apiKey: config.apiKey || matchingProvider?.apiKey,
      baseUrl: config.baseUrl || matchingProvider?.baseUrl || adapter.defaultBaseUrl,
    });
  },

  async configureProvider(cfg = {}) {
    const id = cfg.id || generateProviderId();
    const previous = getProviderConfig(id);
    const type = cfg.type || previous?.type;
    if (!type || !providers[type]) throw new Error(`Unknown provider type: ${type || ''}`);

    const typeChanged = Boolean(previous?.type && previous.type !== type);
    const previousDefaultName = previous
      ? defaultProviderName(previous.type, previous.baseUrl, providerTypeMetadata())
      : null;
    const hasCustomPreviousName = Boolean(previous?.name && previous.name !== previousDefaultName);
    const requestedName = String(cfg.name || '').trim();
    const nextBaseUrl = hasOwn(cfg, 'baseUrl') ? (cfg.baseUrl || null) : (previous?.baseUrl || null);
    const automaticName = defaultProviderName(type, nextBaseUrl, providerTypeMetadata());
    const nextName = uniqueName(
      requestedName || (hasCustomPreviousName ? previous.name : automaticName),
      providerConfigs,
      id
    );
    const nextApiKey = cfg.clearApiKey
      ? null
      : (cfg.apiKey ? cfg.apiKey : (typeChanged ? null : previous?.apiKey));
    const next = normalizeProviderConfig(id, {
      ...previous,
      type,
      name: nextName,
      apiKey: nextApiKey,
      baseUrl: nextBaseUrl,
      updatedAtMs: Date.now(),
    }, providerTypeMetadata());

    providerConfigs = { ...providerConfigs, [id]: next };
    if (previous) {
      const updatedLlms = { ...llms };
      for (const [llmId, llmConfig] of Object.entries(llms)) {
        if (llmConfig.providerId !== id) continue;
        const oldAutoName = defaultLlmName(previous, llmConfig.model);
        if (llmConfig.name !== oldAutoName) continue;
        updatedLlms[llmId] = { ...llmConfig, name: defaultLlmName(next, llmConfig.model) };
      }
      llms = updatedLlms;
    }
    await persistSettings();
    return publicProviderConfig(next);
  },

  async deleteProvider(providerId) {
    if (!providerConfigs[providerId]) return null;
    const usageCount = Object.values(llms).filter((item) => item.providerId === providerId).length;
    if (usageCount > 0) {
      throw new Error(`This provider is used by ${usageCount} LLM${usageCount === 1 ? '' : 's'}. Delete or move them first.`);
    }
    const nextProviders = { ...providerConfigs };
    delete nextProviders[providerId];
    providerConfigs = nextProviders;
    await persistSettings({ deletedProviderId: providerId });
    return null;
  },

  async configureLlm(cfg = {}) {
    const id = hasOwn(cfg, 'id') ? (cfg.id || generateLlmId()) : (activeLlmId || generateLlmId());
    const previous = getLlm(id);
    const providerId = cfg.providerId || previous?.providerId;
    const providerConfig = getProviderConfig(providerId);
    if (!providerConfig) throw new Error('Select a configured provider before saving the LLM.');
    const adapter = providers[providerConfig.type];
    const model = String(cfg.model || previous?.model || adapter?.defaultModel || '').trim();
    if (!model) throw new Error('A model is required.');

    const previousProvider = getProviderConfig(previous?.providerId);
    const previousAutoName = previous ? defaultLlmName(previousProvider, previous.model) : null;
    const hasCustomPreviousName = Boolean(previous?.name && previous.name !== previousAutoName);
    const requestedName = String(cfg.name || '').trim();
    const name = requestedName
      || (hasCustomPreviousName ? previous.name : defaultLlmName(providerConfig, model));
    const modelChanged = previous?.providerId !== providerId || previous?.model !== model;
    const requestedContextWindow = Number(cfg.contextWindow);
    const hasContextWindowOverride = hasOwn(cfg, 'contextWindow')
      && Number.isFinite(requestedContextWindow)
      && requestedContextWindow > 0;
    const shouldResolveContextWindow = !hasContextWindowOverride
      && (hasOwn(cfg, 'contextWindow') || modelChanged || !previous?.contextWindow);
    const contextWindow = hasContextWindowOverride
      ? Math.floor(requestedContextWindow)
      : (shouldResolveContextWindow
        ? await resolveContextWindow(providerConfig.type, model)
        : previous.contextWindow);
    const next = normalizeLlmConfig(id, {
      ...previous,
      providerId,
      name,
      model,
      contextWindow,
      updatedAtMs: Date.now(),
    }, providerConfigs);
    llms = { ...llms, [id]: next };
    activeLlmId = id;
    await persistSettings();
    return llm.getActiveConfig(id);
  },

  /** Legacy flattened configuration adapter. */
  async configure(cfg = {}) {
    if (cfg.providerId) return llm.configureLlm(cfg);
    if (!cfg.provider || !providers[cfg.provider]) {
      throw new Error(`Unknown provider: ${cfg.provider || ''}`);
    }
    const llmId = hasOwn(cfg, 'id') ? (cfg.id || generateLlmId()) : (activeLlmId || generateLlmId());
    const previousLlm = getLlm(llmId);
    const previousProvider = getProviderConfig(previousLlm?.providerId);
    const cloneLlm = cfg.cloneApiKeyFrom ? getLlm(cfg.cloneApiKeyFrom) : null;
    const cloneProvider = getProviderConfig(cloneLlm?.providerId);
    let providerId = previousProvider?.type === cfg.provider ? previousProvider.id : null;
    if (!providerId && cloneProvider?.type === cfg.provider && !cfg.apiKey) providerId = cloneProvider.id;
    if (!providerId) providerId = generateProviderId();
    if (!providerConfigs[providerId] || cfg.apiKey || hasOwn(cfg, 'baseUrl')) {
      await llm.configureProvider({
        id: providerId,
        type: cfg.provider,
        ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
        ...(hasOwn(cfg, 'baseUrl') ? { baseUrl: cfg.baseUrl } : {}),
      });
    }
    return llm.configureLlm({
      id: llmId,
      name: cfg.name,
      providerId,
      model: cfg.model,
      contextWindow: cfg.contextWindow,
    });
  },

  async selectLlm(llmId) {
    if (llmId && !llms[llmId]) throw new Error(`Unknown LLM: ${llmId}`);
    activeLlmId = llmId || null;
    await persistSettings();
    return llm.getActiveConfig();
  },

  async selectProfile(profileId) {
    return llm.selectLlm(profileId);
  },

  async deleteLlm(llmId) {
    if (!llms[llmId]) return llm.getActiveConfig();
    const nextLlms = { ...llms };
    delete nextLlms[llmId];
    llms = nextLlms;
    if (activeLlmId === llmId) activeLlmId = Object.keys(llms)[0] || null;
    await persistSettings({ deletedLlmId: llmId });
    return llm.getActiveConfig();
  },

  async deleteProfile(profileId) {
    return llm.deleteLlm(profileId);
  },

  /**
   * Load persisted settings from OPFS (call once at app startup).
   */
  async init() {
    const saved = await loadSettings();
    const normalized = normalizeLlmSettings(saved, providerTypeMetadata());
    activeLlmId = normalized.settings.activeLlmId;
    providerConfigs = normalized.settings.providers;
    llms = normalized.settings.llms;
    if (normalized.migrated) await persistSettings();
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
    return llm.getActiveConfig().configured;
  },

  isProfileConfigured(profileId = activeLlmId) {
    return llm.getActiveConfig(profileId).configured;
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
