import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __providerPresetInternals,
  normalizeProviderConfig,
  normalizeProviderPreset,
  pathStyleForProviderPreset,
  validateSyncPrefix,
  validateProviderConfig,
} from './providerPresets.js';

const {
  LONGEST_MANAGED_OBJECT_SUFFIX,
  MAX_OSS_OBJECT_KEY_BYTES,
  MAX_S3_OBJECT_KEY_BYTES,
} = __providerPresetInternals;

test('provider preset names are canonicalized before use', () => {
  assert.equal(normalizeProviderPreset('  ALIYUN-OSS  '), 'aliyun-oss');
  assert.equal(normalizeProviderPreset(''), 's3');
  assert.equal(
    normalizeProviderConfig({ providerPreset: '  S3  ' }).providerPreset,
    's3'
  );
});

test('sync prefixes are normalized and reserve space for managed object keys', () => {
  const suffixBytes = new TextEncoder().encode(LONGEST_MANAGED_OBJECT_SUFFIX).byteLength;
  const maxS3PrefixBytes = MAX_S3_OBJECT_KEY_BYTES - suffixBytes - 1;
  const maxOssPrefixBytes = MAX_OSS_OBJECT_KEY_BYTES - suffixBytes - 1;
  const maxS3CjkCharacters = Math.floor(maxS3PrefixBytes / 3);

  assert.equal(validateSyncPrefix('  /team/cherry/  '), 'team/cherry');
  assert.equal(
    validateSyncPrefix('a'.repeat(maxS3PrefixBytes)),
    'a'.repeat(maxS3PrefixBytes)
  );
  assert.throws(
    () => validateSyncPrefix('a'.repeat(maxS3PrefixBytes + 1)),
    /prefix is too long.*1,024 UTF-8-byte object-key limit/i
  );
  assert.equal(
    validateSyncPrefix('界'.repeat(maxS3CjkCharacters)),
    '界'.repeat(maxS3CjkCharacters)
  );
  assert.throws(
    () => validateSyncPrefix('界'.repeat(maxS3CjkCharacters + 1)),
    /prefix is too long/i
  );
  assert.equal(
    validateSyncPrefix('a'.repeat(maxOssPrefixBytes), 'aliyun-oss'),
    'a'.repeat(maxOssPrefixBytes)
  );
  assert.throws(
    () => validateSyncPrefix('a'.repeat(maxOssPrefixBytes + 1), 'aliyun-oss'),
    /OSS's 1,023 UTF-8-byte object-key limit/i
  );
  assert.throws(
    () => validateSyncPrefix('\\unsafe', 'aliyun-oss'),
    /must not begin with a backslash/i
  );
});

test('provider normalization returns the canonical prefix', () => {
  assert.equal(
    normalizeProviderConfig({ providerPreset: 's3', prefix: ' /cherry-agent/ ' }).prefix,
    'cherry-agent'
  );
});

test('MinIO always selects path-style addressing', () => {
  assert.equal(pathStyleForProviderPreset('minio', false), true);
  assert.equal(pathStyleForProviderPreset('minio', true), true);
});

test('AWS S3 always selects virtual-hosted addressing', () => {
  assert.equal(pathStyleForProviderPreset('s3', false), false);
  assert.equal(pathStyleForProviderPreset('s3', true), false);
});

test('Aliyun OSS always selects virtual-hosted addressing', () => {
  assert.equal(pathStyleForProviderPreset('aliyun-oss', false), false);
  assert.equal(pathStyleForProviderPreset('aliyun-oss', true), false);
});

test('custom providers preserve the explicit addressing choice', () => {
  assert.equal(pathStyleForProviderPreset('custom', false), false);
  assert.equal(pathStyleForProviderPreset('custom', true), true);
});

test('Aliyun OSS derives the AWS-compatible regional endpoint', () => {
  assert.deepEqual(
    normalizeProviderConfig({ providerPreset: 'aliyun-oss', region: 'cn-beijing', forcePathStyle: true }),
    {
      providerPreset: 'aliyun-oss',
      region: 'cn-beijing',
      endpoint: 'https://s3.oss-cn-beijing.aliyuncs.com',
      forcePathStyle: false,
      bucketEndpoint: false,
    }
  );
});

test('Aliyun OSS defaults to cn-beijing when no region is configured', () => {
  assert.deepEqual(
    normalizeProviderConfig({ providerPreset: 'aliyun-oss' }),
    {
      providerPreset: 'aliyun-oss',
      region: 'cn-beijing',
      endpoint: 'https://s3.oss-cn-beijing.aliyuncs.com',
      forcePathStyle: false,
      bucketEndpoint: false,
    }
  );
});

test('an explicit custom endpoint and path style remain unchanged', () => {
  assert.deepEqual(
    normalizeProviderConfig({
      providerPreset: 'custom',
      endpoint: 'https://storage.example.test',
      region: 'custom-1',
      forcePathStyle: true,
    }),
    {
      providerPreset: 'custom',
      endpoint: 'https://storage.example.test',
      region: 'custom-1',
      forcePathStyle: true,
      bucketEndpoint: false,
    }
  );
});

test('unknown provider presets are rejected', () => {
  assert.throws(
    () => validateProviderConfig({ providerPreset: 'mystery-store' }),
    /unsupported object storage provider preset/i
  );
  assert.throws(
    () => pathStyleForProviderPreset('mystery-store'),
    /unsupported object storage provider preset/i
  );
});

test('MinIO and custom providers require an explicit endpoint', () => {
  assert.throws(
    () => validateProviderConfig({ providerPreset: 'minio' }),
    /MinIO object storage requires an explicit endpoint/
  );
  assert.throws(
    () => validateProviderConfig({ providerPreset: 'custom', endpoint: '   ' }),
    /Custom object storage requires an explicit endpoint/
  );
});

test('endpoints must be safe HTTP(S) URLs without embedded credentials', () => {
  for (const endpoint of [
    'not a URL',
    'ftp://storage.example.test',
    'https://access:secret@storage.example.test',
    'http://storage.example.test',
    'http://localhost.evil.example',
    'https://storage.example.test?access_token=secret',
    'https://storage.example.test#unexpected-fragment',
  ]) {
    assert.throws(
      () => validateProviderConfig({ providerPreset: 'custom', endpoint }),
      /endpoint|unencrypted/i,
      endpoint
    );
  }
});

test('HTTP endpoints are accepted only for localhost and loopback development', () => {
  for (const endpoint of [
    'http://localhost:9000',
    'http://minio.localhost:9000',
    'http://127.0.0.2:9000',
    'http://[::1]:9000',
  ]) {
    assert.equal(
      validateProviderConfig({ providerPreset: 'minio', endpoint }).endpoint,
      endpoint
    );
  }
  assert.equal(
    validateProviderConfig({
      providerPreset: 'custom',
      endpoint: 'https://storage.example.test',
    }).endpoint,
    'https://storage.example.test'
  );
});

test('Aliyun and custom providers support explicit bucket/CNAME endpoints', () => {
  assert.deepEqual(
    normalizeProviderConfig({
      providerPreset: 'aliyun-oss',
      endpoint: 'https://bucket.example.test',
      bucketEndpoint: true,
    }),
    {
      providerPreset: 'aliyun-oss',
      endpoint: 'https://bucket.example.test',
      region: 'cn-beijing',
      forcePathStyle: false,
      bucketEndpoint: true,
    }
  );
  assert.equal(
    normalizeProviderConfig({
      providerPreset: 'custom',
      endpoint: 'https://bucket.example.test',
      bucketEndpoint: true,
    }).bucketEndpoint,
    true
  );
});

test('bucket/CNAME endpoint mode rejects unsafe addressing combinations', () => {
  assert.throws(
    () => normalizeProviderConfig({ providerPreset: 's3', bucketEndpoint: true }),
    /supported only for Aliyun OSS and custom providers/
  );
  assert.throws(
    () => normalizeProviderConfig({ providerPreset: 'aliyun-oss', bucketEndpoint: true }),
    /requires an explicit endpoint URL/
  );
  assert.throws(
    () => normalizeProviderConfig({
      providerPreset: 'custom',
      endpoint: 'https://bucket.example.test',
      bucketEndpoint: true,
      forcePathStyle: true,
    }),
    /cannot be combined with path-style addressing/
  );
  assert.throws(
    () => normalizeProviderConfig({
      providerPreset: 'custom',
      endpoint: 'https://bucket.example.test/proxy',
      bucketEndpoint: true,
    }),
    /must not contain a path/
  );
});

test('bucket/CNAME endpoint mode does not require a separate bucket name', () => {
  const normalized = normalizeProviderConfig({
    providerPreset: 'aliyun-oss',
    endpoint: 'https://bucket.example.test',
    bucketEndpoint: true,
  });

  assert.equal(normalized.bucket, undefined);
  assert.equal(normalized.endpoint, 'https://bucket.example.test');
  assert.equal(normalized.bucketEndpoint, true);
});
