const KNOWN_PROVIDER_PRESETS = new Set(['s3', 'aliyun-oss', 'minio', 'custom']);
const MAX_S3_OBJECT_KEY_BYTES = 1024;
const MAX_OSS_OBJECT_KEY_BYTES = 1023;
// A persisted client ID is allowed to be up to 128 ASCII characters. Its
// sharded manifest key is therefore the longest fixed-format key sync creates.
const LONGEST_MANAGED_OBJECT_SUFFIX = (
  `manifests/${'x'.repeat(128)}.${Number.MAX_SAFE_INTEGER}.${'f'.repeat(16)}.json`
);

export function normalizeProviderPreset(value) {
  const preset = String(value || 's3').trim().toLowerCase() || 's3';
  if (!KNOWN_PROVIDER_PRESETS.has(preset)) {
    throw new RangeError(`Unsupported object storage provider preset: ${preset}`);
  }
  return preset;
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value)).byteLength;
}

/**
 * Normalize a sync prefix and ensure every fixed-format object key can fit
 * within S3's 1,024 UTF-8-byte key limit.
 */
export function validateSyncPrefix(prefix, providerPreset = 's3') {
  const normalized = String(prefix || '').trim().replace(/^\/+|\/+$/g, '');
  const preset = normalizeProviderPreset(providerPreset);
  const maximumBytes = preset === 'aliyun-oss'
    ? MAX_OSS_OBJECT_KEY_BYTES
    : MAX_S3_OBJECT_KEY_BYTES;
  if (preset === 'aliyun-oss' && normalized.startsWith('\\')) {
    throw new RangeError('Aliyun OSS object prefixes must not begin with a backslash');
  }
  const separatorBytes = normalized ? 1 : 0;
  const requiredBytes = utf8ByteLength(normalized)
    + separatorBytes
    + utf8ByteLength(LONGEST_MANAGED_OBJECT_SUFFIX);
  if (requiredBytes > maximumBytes) {
    throw new RangeError(
      'Object storage prefix is too long to fit VertexAgent sync keys within '
      + `${preset === 'aliyun-oss' ? "OSS's 1,023" : "S3's 1,024"} UTF-8-byte object-key limit`
    );
  }
  return normalized;
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (value === 'localhost' || value.endsWith('.localhost') || value === '::1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(value);
}

function validateEndpoint(endpoint) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new TypeError('Object storage endpoint must be a valid HTTP(S) URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError('Object storage endpoint must use HTTP or HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('Object storage endpoint must not contain credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new TypeError('Object storage endpoint must not contain a query or fragment');
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw new TypeError('Unencrypted object storage endpoints are allowed only on localhost or loopback addresses');
  }
  return parsed;
}

/**
 * Resolve the addressing style implied by a provider preset.
 * Custom endpoints keep the user's explicit choice.
 */
export function pathStyleForProviderPreset(preset, currentValue = false) {
  const normalized = normalizeProviderPreset(preset);
  if (normalized === 'minio') return true;
  if (normalized === 's3' || normalized === 'aliyun-oss') return false;
  return Boolean(currentValue);
}

/**
 * Validate a provider configuration and return its normalized representation.
 * Invalid configurations throw before an SDK client can issue a request.
 */
export function validateProviderConfig(config = {}) {
  const source = config && typeof config === 'object' ? config : {};
  const providerPreset = normalizeProviderPreset(source.providerPreset);
  const defaultRegion = providerPreset === 'aliyun-oss' ? 'cn-beijing' : 'us-east-1';
  const region = String(source.region || defaultRegion).trim() || defaultRegion;
  const explicitEndpoint = String(source.endpoint || '').trim();
  const bucketEndpoint = source.bucketEndpoint === true;
  const prefix = validateSyncPrefix(source.prefix, providerPreset);

  if ((providerPreset === 'minio' || providerPreset === 'custom') && !explicitEndpoint) {
    throw new TypeError(`${providerPreset === 'minio' ? 'MinIO' : 'Custom'} object storage requires an explicit endpoint`);
  }
  if (bucketEndpoint && providerPreset !== 'aliyun-oss' && providerPreset !== 'custom') {
    throw new TypeError('Bucket/CNAME endpoints are supported only for Aliyun OSS and custom providers');
  }
  if (bucketEndpoint && !explicitEndpoint) {
    throw new TypeError('Bucket/CNAME endpoint mode requires an explicit endpoint URL');
  }

  let endpoint = explicitEndpoint || null;
  if (providerPreset === 'aliyun-oss' && !endpoint) {
    endpoint = `https://s3.oss-${region}.aliyuncs.com`;
  }

  const parsedEndpoint = endpoint ? validateEndpoint(endpoint) : null;
  if (bucketEndpoint && parsedEndpoint.pathname !== '/') {
    throw new TypeError('Bucket/CNAME endpoint URL must not contain a path');
  }

  const forcePathStyle = pathStyleForProviderPreset(providerPreset, source.forcePathStyle);
  if (bucketEndpoint && forcePathStyle) {
    throw new TypeError('Bucket/CNAME endpoint mode cannot be combined with path-style addressing');
  }

  return {
    ...source,
    providerPreset,
    endpoint,
    region,
    forcePathStyle,
    bucketEndpoint,
    ...(Object.hasOwn(source, 'prefix') ? { prefix } : {}),
  };
}

export function normalizeProviderConfig(config = {}) {
  return validateProviderConfig(config);
}

export const __providerPresetInternals = {
  isLoopbackHostname,
  validateEndpoint,
  LONGEST_MANAGED_OBJECT_SUFFIX,
  MAX_OSS_OBJECT_KEY_BYTES,
  MAX_S3_OBJECT_KEY_BYTES,
};
