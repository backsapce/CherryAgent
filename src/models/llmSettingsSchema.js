export const LLM_SETTINGS_SCHEMA_VERSION = 2;

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function nullableString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeBaseUrl(value) {
  const text = nullableString(value);
  return text ? text.replace(/\/+$/, '') : null;
}

function normalizeApiKey(value) {
  if (value == null || value === '') return null;
  return String(value);
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? Math.floor(timestamp) : null;
}

function uniqueIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id)).filter(Boolean))];
}

function providerType(providerTypes, type) {
  if (!type) return null;
  if (Array.isArray(providerTypes)) {
    return providerTypes.find((provider) => provider?.id === type) || null;
  }
  return providerTypes?.[type] || null;
}

export function normalizeProviderEndpoint(type, baseUrl, providerTypes = {}) {
  const metadata = providerType(providerTypes, type);
  return normalizeBaseUrl(baseUrl || metadata?.defaultBaseUrl || '') || '';
}

export function defaultProviderName(type, baseUrl, providerTypes = {}) {
  const metadata = providerType(providerTypes, type);
  const typeName = metadata?.name || type || 'Provider';
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl || normalizedBaseUrl === normalizeBaseUrl(metadata?.defaultBaseUrl)) {
    return typeName;
  }

  try {
    return `${typeName} (${new URL(normalizedBaseUrl).host})`;
  } catch {
    return `${typeName} (${normalizedBaseUrl})`;
  }
}

export function defaultLlmName(provider, model) {
  const providerName = nullableString(provider?.name) || 'Provider';
  const modelName = nullableString(model);
  return modelName ? `${providerName} / ${modelName}` : providerName;
}

export function normalizeProviderConfig(id, value = {}, providerTypes = {}) {
  const type = nullableString(value.type ?? value.provider);
  const updatedAtMs = normalizeTimestamp(value.updatedAtMs);
  return {
    id,
    name: nullableString(value.name) || defaultProviderName(type, value.baseUrl, providerTypes),
    type,
    apiKey: normalizeApiKey(value.apiKey),
    baseUrl: normalizeBaseUrl(value.baseUrl),
    ...(updatedAtMs ? { updatedAtMs } : {}),
  };
}

export function normalizeLlmConfig(id, value = {}, providers = {}) {
  const providerId = nullableString(value.providerId);
  const provider = providerId ? providers[providerId] : null;
  const model = nullableString(value.model);
  const contextWindow = Number(value.contextWindow);
  const updatedAtMs = normalizeTimestamp(value.updatedAtMs);
  return {
    id,
    name: nullableString(value.name) || defaultLlmName(provider, model),
    providerId,
    model,
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0
      ? Math.floor(contextWindow)
      : null,
    ...(updatedAtMs ? { updatedAtMs } : {}),
  };
}

function emptySettings() {
  return {
    schemaVersion: LLM_SETTINGS_SCHEMA_VERSION,
    activeLlmId: null,
    providers: {},
    llms: {},
    deletedProviderIds: [],
    deletedLlmIds: [],
  };
}

function normalizeV2Settings(saved, providerTypes) {
  const providers = {};
  if (isRecord(saved.providers)) {
    for (const [id, provider] of Object.entries(saved.providers)) {
      providers[id] = normalizeProviderConfig(id, provider, providerTypes);
    }
  }

  const llms = {};
  if (isRecord(saved.llms)) {
    for (const [id, llm] of Object.entries(saved.llms)) {
      llms[id] = normalizeLlmConfig(id, llm, providers);
    }
  }

  const firstLlmId = Object.keys(llms)[0] || null;
  const activeLlmId = saved.activeLlmId && llms[saved.activeLlmId]
    ? saved.activeLlmId
    : firstLlmId;
  const providerIds = new Set(Object.keys(providers));
  const llmIds = new Set(Object.keys(llms));

  return {
    schemaVersion: LLM_SETTINGS_SCHEMA_VERSION,
    activeLlmId,
    providers,
    llms,
    deletedProviderIds: uniqueIds(saved.deletedProviderIds).filter((id) => !providerIds.has(id)),
    deletedLlmIds: uniqueIds(saved.deletedLlmIds).filter((id) => !llmIds.has(id)),
  };
}

function nextLegacyProviderId(llmId, providers) {
  const base = `provider_${llmId}`;
  let id = base;
  let suffix = 2;
  while (providers[id]) {
    id = `${base}_${suffix}`;
    suffix += 1;
  }
  return id;
}

function uniqueProviderName(name, providers) {
  const used = new Set(Object.values(providers).map((provider) => provider.name));
  if (!used.has(name)) return name;
  let suffix = 2;
  while (used.has(`${name} ${suffix}`)) suffix += 1;
  return `${name} ${suffix}`;
}

function hasLegacySingleConfig(saved) {
  return ['provider', 'apiKey', 'model', 'baseUrl'].some((field) => own(saved, field) && saved[field]);
}

function migrateLegacySettings(saved, providerTypes) {
  const settings = emptySettings();
  let legacyProfiles = null;

  if (isRecord(saved.profiles)) {
    legacyProfiles = saved.profiles;
  } else if (hasLegacySingleConfig(saved)) {
    const id = nullableString(saved.id) || 'default';
    legacyProfiles = { [id]: saved };
  }

  if (!legacyProfiles) return { settings, migrated: false };

  const providerIdentity = new Map();
  for (const [id, profileValue] of Object.entries(legacyProfiles)) {
    const profile = isRecord(profileValue) ? profileValue : {};
    const type = nullableString(profile.provider);
    const apiKey = normalizeApiKey(profile.apiKey);
    let providerId = null;

    if (type) {
      const endpoint = normalizeProviderEndpoint(type, profile.baseUrl, providerTypes);
      const canMerge = Boolean(apiKey && apiKey.trim());
      const identity = canMerge ? JSON.stringify([type, endpoint, apiKey]) : null;
      providerId = identity ? providerIdentity.get(identity) : null;

      if (!providerId) {
        providerId = nextLegacyProviderId(id, settings.providers);
        const providerConfig = normalizeProviderConfig(providerId, {
          type,
          apiKey,
          baseUrl: profile.baseUrl,
          updatedAtMs: profile.updatedAtMs,
        }, providerTypes);
        providerConfig.name = uniqueProviderName(providerConfig.name, settings.providers);
        settings.providers[providerId] = providerConfig;
        if (identity) providerIdentity.set(identity, providerId);
      } else {
        const provider = settings.providers[providerId];
        const timestamp = Math.max(
          Number(provider.updatedAtMs) || 0,
          Number(profile.updatedAtMs) || 0,
        );
        if (timestamp > 0) provider.updatedAtMs = Math.floor(timestamp);
      }
    }

    settings.llms[id] = normalizeLlmConfig(id, {
      name: profile.name,
      providerId,
      model: profile.model,
      contextWindow: profile.contextWindow,
      updatedAtMs: profile.updatedAtMs,
    }, settings.providers);
  }

  const firstLlmId = Object.keys(settings.llms)[0] || null;
  settings.activeLlmId = saved.activeProfileId && settings.llms[saved.activeProfileId]
    ? saved.activeProfileId
    : firstLlmId;
  settings.deletedLlmIds = uniqueIds(saved.deletedProfileIds)
    .filter((id) => !settings.llms[id]);
  return { settings, migrated: true };
}

/**
 * Normalize the persisted LLM section and migrate legacy single/profile
 * settings to the provider + LLM binding schema.
 */
export function normalizeLlmSettings(saved, providerTypes = {}) {
  if (!isRecord(saved)) return { settings: emptySettings(), migrated: false };

  if (
    Number(saved.schemaVersion) === LLM_SETTINGS_SCHEMA_VERSION
    || isRecord(saved.providers)
    || isRecord(saved.llms)
  ) {
    return {
      settings: normalizeV2Settings(saved, providerTypes),
      migrated: Number(saved.schemaVersion) !== LLM_SETTINGS_SCHEMA_VERSION,
    };
  }

  return migrateLegacySettings(saved, providerTypes);
}
