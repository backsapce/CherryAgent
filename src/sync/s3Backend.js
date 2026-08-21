import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { validateProviderConfig } from './providerPresets.js';

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_MODE = 'standard';
const RETRY_MODES = new Set(['standard', 'adaptive']);
const REQUIRED_CHECKSUM_SETTING = 'WHEN_REQUIRED';
const MAX_INITIAL_STREAM_ALLOCATION = 1024 * 1024;
const MAX_OBJECT_KEY_BYTES = 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_MIN_UPLOAD_BYTES_PER_SECOND = 256 * 1024;
const DEFAULT_UPLOAD_GRACE_MS = 30_000;

function utf8ByteLengthThroughLimit(value, limit) {
  let byteLength = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) byteLength += 1;
    else if (code <= 0x7ff) byteLength += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (trailing >= 0xdc00 && trailing <= 0xdfff) {
        byteLength += 4;
        index += 1;
      } else {
        byteLength += 3;
      }
    } else byteLength += 3;
    if (byteLength > limit) break;
  }
  return byteLength;
}

export function assertValidObjectKey(key, description = 'S3 object key') {
  const value = String(key ?? '');
  const byteLength = utf8ByteLengthThroughLimit(value, MAX_OBJECT_KEY_BYTES);
  if (byteLength > MAX_OBJECT_KEY_BYTES) {
    throw new RangeError(`${description} exceeds the 1,024 UTF-8-byte S3 limit`);
  }
  return value;
}

function trimSlashes(value) {
  return String(value || '').replace(/^\/+|\/+$/g, '');
}

export function objectKey(config, suffix) {
  const prefix = trimSlashes(config.prefix);
  const cleanSuffix = trimSlashes(suffix);
  return assertValidObjectKey(prefix ? `${prefix}/${cleanSuffix}` : cleanSuffix);
}

function boundedMaxAttempts(value) {
  if (value == null || value === '') return DEFAULT_MAX_ATTEMPTS;
  const requested = Number(value);
  if (!Number.isFinite(requested)) return DEFAULT_MAX_ATTEMPTS;
  return Math.min(MAX_MAX_ATTEMPTS, Math.max(1, Math.floor(requested)));
}

function retryMode(value) {
  return RETRY_MODES.has(value) ? value : DEFAULT_RETRY_MODE;
}

function boundedTimeout(value, fallback) {
  if (value == null || value === '') return fallback;
  const requested = Number(value);
  if (!Number.isFinite(requested)) return fallback;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(requested)));
}

function bodyByteLength(body) {
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return null;
}

function uploadRequestTimeout(body, configuredTimeout, explicitlyConfigured = false) {
  if (explicitlyConfigured) return configuredTimeout;
  const byteLength = bodyByteLength(body);
  return sizeAwareTransferTimeout(byteLength, configuredTimeout);
}

function sizeAwareTransferTimeout(byteLength, configuredTimeout) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) return configuredTimeout;
  const transferBudget = Math.ceil(
    (byteLength / DEFAULT_MIN_UPLOAD_BYTES_PER_SECOND) * 1000
  );
  return Math.min(
    MAX_TIMEOUT_MS,
    Math.max(configuredTimeout, DEFAULT_UPLOAD_GRACE_MS + transferBudget)
  );
}

function downloadStreamTimeout(
  contentLength,
  maxBytes,
  configuredTimeout,
  explicitlyConfigured = false
) {
  if (explicitlyConfigured) return configuredTimeout;
  const expectedBytes = normalizedContentLength(contentLength) ?? normalizeMaxBytes(maxBytes);
  return sizeAwareTransferTimeout(expectedBytes, configuredTimeout);
}

function createClient(config, clientOptions = {}) {
  const normalized = validateProviderConfig(config);
  return new S3Client({
    region: normalized.region || 'us-east-1',
    endpoint: normalized.endpoint || undefined,
    forcePathStyle: Boolean(normalized.forcePathStyle),
    bucketEndpoint: Boolean(normalized.bucketEndpoint),
    credentials: {
      accessKeyId: normalized.accessKeyId || '',
      secretAccessKey: normalized.secretAccessKey || '',
      ...(normalized.sessionToken ? { sessionToken: normalized.sessionToken } : {}),
    },
    maxAttempts: boundedMaxAttempts(normalized.maxAttempts),
    retryMode: retryMode(normalized.retryMode),
    // Recent AWS SDK releases calculate optional CRC checksums by default.
    // Several S3-compatible backends do not implement those extensions.
    requestChecksumCalculation: REQUIRED_CHECKSUM_SETTING,
    responseChecksumValidation: REQUIRED_CHECKSUM_SETTING,
    ...clientOptions,
  });
}

function errorStatusCode(err) {
  const value = err?.$metadata?.httpStatusCode
    ?? err?.$response?.statusCode
    ?? err?.statusCode
    ?? err?.status;
  const statusCode = Number(value);
  return Number.isFinite(statusCode) ? statusCode : null;
}

function errorCodes(err) {
  return new Set(
    [err?.name, err?.Code, err?.code]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase())
  );
}

export function isNotModifiedError(err) {
  return errorStatusCode(err) === 304 || errorCodes(err).has('notmodified');
}

export function isNotFoundError(err) {
  const codes = errorCodes(err);
  // A number of S3-compatible gateways intentionally return HTTP 404 for
  // authorization, routing, or missing-bucket failures. Treat only explicit
  // object-missing service codes as an absent key; status alone is ambiguous.
  for (const infrastructureCode of [
    'accessdenied',
    'authorizationheadermalformed',
    'invalidaccesspointaliaserror',
    'invalidbucketname',
    'nosuchaccesspoint',
    'nosuchbucket',
    'publicendpointforbidden',
  ]) {
    if (codes.has(infrastructureCode)) return false;
  }
  return codes.has('nosuchkey')
    || codes.has('nosuchobject')
    || codes.has('notfound');
}

export function isPreconditionFailedError(err) {
  return errorStatusCode(err) === 412 || errorCodes(err).has('preconditionfailed');
}

export const isPreconditionFailed = isPreconditionFailedError;

export function isConditionalRequestConflictError(err) {
  if (errorCodes(err).has('conditionalrequestconflict')) return true;
  const message = String(err?.message || '');
  return errorStatusCode(err) === 409
    && /\bconditional\b/i.test(message)
    && /\bconflict(?:ing)?\b/i.test(message);
}

export function isConditionalWriteConflictError(err) {
  return isPreconditionFailedError(err) || isConditionalRequestConflictError(err);
}

export function isConditionalRequestUnsupported(err) {
  const statusCode = errorStatusCode(err);
  const codes = errorCodes(err);
  const messageDescribesCondition = /(?:conditional|if-match|if-none-match)/i.test(String(err?.message || ''));
  return statusCode === 405
    || statusCode === 501
    || codes.has('notimplemented')
    || codes.has('unsupportedoperation')
    || codes.has('unsupportedheader')
    || codes.has('methodnotallowed')
    || (
      statusCode === 400
      && (codes.has('invalidrequest') || codes.has('invalidargument'))
      && messageDescribesCondition
    );
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return null;
}

function normalizedContentLength(value) {
  if (value == null || value === '') return null;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

function normalizedLastModified(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function responseMetadata(response = {}) {
  return {
    etag: response.ETag ?? null,
    lastModified: normalizedLastModified(response.LastModified),
    contentLength: normalizedContentLength(response.ContentLength),
    versionId: response.VersionId ?? null,
    statusCode: response.$metadata?.httpStatusCode ?? null,
  };
}

function errorResponseMetadata(err) {
  const headers = err?.$response?.headers;
  return {
    etag: headerValue(headers, 'etag'),
    lastModified: normalizedLastModified(headerValue(headers, 'last-modified')),
    contentLength: normalizedContentLength(headerValue(headers, 'content-length')),
    versionId: headerValue(headers, 'x-amz-version-id'),
    statusCode: errorStatusCode(err),
  };
}

function normalizeMaxBytes(value) {
  if (value == null) return null;
  const maxBytes = Number(value);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }
  return maxBytes;
}

export class S3ObjectTooLargeError extends Error {
  constructor(maxBytes, receivedBytes) {
    super(`S3 object exceeds the ${maxBytes} byte read limit`);
    this.name = 'S3ObjectTooLargeError';
    this.maxBytes = maxBytes;
    this.receivedBytes = receivedBytes;
  }
}

export class S3RequestTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`S3 request timed out after ${timeoutMs} ms`);
    this.name = 'S3RequestTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class S3StreamTimeoutError extends Error {
  constructor(timeoutMs, reason = 'idle') {
    super(reason === 'deadline'
      ? `S3 response stream exceeded its ${timeoutMs} ms total deadline`
      : `S3 response stream was idle for ${timeoutMs} ms`);
    this.name = 'S3StreamTimeoutError';
    this.timeoutMs = timeoutMs;
    this.reason = reason;
  }
}

function enforceByteLimit(maxBytes, receivedBytes) {
  if (maxBytes != null && receivedBytes > maxBytes) {
    throw new S3ObjectTooLargeError(maxBytes, receivedBytes);
  }
}

function byteView(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('S3 response stream produced a non-binary chunk');
}

async function cancelBody(body) {
  try {
    if (typeof body?.cancel === 'function') {
      Promise.resolve(body.cancel()).catch(() => {});
      return;
    }
    if (typeof body?.getReader === 'function') {
      const reader = body.getReader();
      Promise.resolve(reader.cancel()).catch(() => {});
      reader.releaseLock?.();
    }
  } catch {
    // The size error is more useful than a transport-specific cancellation error.
  }
}

function timeoutRace(promise, timeoutMs, createError, timers = {}) {
  const schedule = timers.setTimeout || globalThis.setTimeout;
  const cancel = timers.clearTimeout || globalThis.clearTimeout;
  let timeoutId;
  const timeout = new Promise((resolve, reject) => {
    timeoutId = schedule(() => reject(createError()), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => cancel(timeoutId));
}

async function readBodyWithTimeout(body, promise, timeoutMs, options) {
  try {
    return await timeoutRace(
      promise,
      timeoutMs,
      () => new S3StreamTimeoutError(timeoutMs),
      options
    );
  } catch (err) {
    if (err instanceof S3StreamTimeoutError) await cancelBody(body);
    throw err;
  }
}

async function readStream(stream, maxBytes, contentLength, options = {}) {
  const reader = stream.getReader();
  const streamTimeoutMs = boundedTimeout(options.streamTimeoutMs, DEFAULT_STREAM_TIMEOUT_MS);
  const totalStreamTimeoutMs = options.totalStreamTimeoutMs == null
    ? null
    : boundedTimeout(options.totalStreamTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const schedule = options.setTimeout || globalThis.setTimeout;
  const cancel = options.clearTimeout || globalThis.clearTimeout;
  let totalTimeoutId;
  const totalDeadline = totalStreamTimeoutMs == null
    ? null
    : new Promise((_resolve, reject) => {
      totalTimeoutId = schedule(
        () => reject(new S3StreamTimeoutError(totalStreamTimeoutMs, 'deadline')),
        totalStreamTimeoutMs
      );
    });
  const initialLength = contentLength == null
    ? null
    : Math.min(contentLength, MAX_INITIAL_STREAM_ALLOCATION);
  let output = initialLength != null ? new Uint8Array(initialLength) : null;
  const chunks = output ? null : [];
  let total = 0;

  try {
    for (;;) {
      let result;
      try {
        const idleRead = timeoutRace(
          reader.read(),
          streamTimeoutMs,
          () => new S3StreamTimeoutError(streamTimeoutMs),
          options
        );
        result = await (totalDeadline
          ? Promise.race([idleRead, totalDeadline])
          : idleRead);
      } catch (err) {
        if (err instanceof S3StreamTimeoutError) {
          try {
            Promise.resolve(reader.cancel(err)).catch(() => {});
          } catch { /* preserve the timeout */ }
        }
        throw err;
      }
      const { value, done } = result;
      if (done) break;
      const chunk = byteView(value);
      const nextTotal = total + chunk.byteLength;
      if (maxBytes != null && nextTotal > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore cancellation failure */ }
        throw new S3ObjectTooLargeError(maxBytes, nextTotal);
      }

      if (output) {
        if (nextTotal > output.byteLength) {
          let nextLength = Math.max(nextTotal, Math.max(1, output.byteLength * 2));
          if (maxBytes != null) nextLength = Math.min(nextLength, maxBytes);
          const expanded = new Uint8Array(nextLength);
          expanded.set(output.subarray(0, total));
          output = expanded;
        }
        output.set(chunk, total);
      } else {
        chunks.push(chunk);
      }
      total = nextTotal;
    }
  } finally {
    if (totalTimeoutId != null) cancel(totalTimeoutId);
    reader.releaseLock?.();
  }

  if (output) {
    // `subarray` would retain the entire advertised allocation when a server
    // sends fewer bytes than Content-Length. Copy short responses so a bogus
    // large header cannot pin a large backing buffer in the browser.
    return total === output.byteLength ? output : output.slice(0, total);
  }

  output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function bodyToBytes(body, options = {}) {
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const contentLength = normalizedContentLength(options.contentLength);
  const streamTimeoutMs = boundedTimeout(options.streamTimeoutMs, DEFAULT_STREAM_TIMEOUT_MS);
  if (maxBytes != null && contentLength != null && contentLength > maxBytes) {
    await cancelBody(body);
    throw new S3ObjectTooLargeError(maxBytes, contentLength);
  }
  if (!body) return new Uint8Array();

  if (body instanceof Uint8Array) {
    enforceByteLimit(maxBytes, body.byteLength);
    return body;
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const bytes = byteView(body);
    enforceByteLimit(maxBytes, bytes.byteLength);
    return bytes;
  }

  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    enforceByteLimit(maxBytes, body.size);
    return new Uint8Array(await readBodyWithTimeout(
      body,
      body.arrayBuffer(),
      streamTimeoutMs,
      options
    ));
  }

  const stream = typeof body.getReader === 'function'
    ? body
    : typeof body.transformToWebStream === 'function'
      ? body.transformToWebStream()
      : typeof body.stream === 'function'
        ? body.stream()
        : null;
  if (stream?.getReader) return readStream(stream, maxBytes, contentLength, options);

  if (typeof body.transformToByteArray === 'function') {
    const bytes = byteView(await readBodyWithTimeout(
      body,
      body.transformToByteArray(),
      streamTimeoutMs,
      options
    ));
    enforceByteLimit(maxBytes, bytes.byteLength);
    return bytes;
  }

  const bytes = new Uint8Array(await readBodyWithTimeout(
    body,
    new Response(body).arrayBuffer(),
    streamTimeoutMs,
    options
  ));
  enforceByteLimit(maxBytes, bytes.byteLength);
  return bytes;
}

function conditionalInput(options = {}) {
  return {
    ...(options.ifMatch != null ? { IfMatch: options.ifMatch } : {}),
    ...(options.ifNoneMatch != null ? { IfNoneMatch: options.ifNoneMatch } : {}),
  };
}

function getResult(metadata, values = {}) {
  return {
    bytes: null,
    notModified: false,
    notFound: false,
    exists: true,
    ...metadata,
    ...values,
  };
}

function putResult(response = {}) {
  return {
    etag: response.ETag ?? null,
    versionId: response.VersionId ?? null,
  };
}

function defaultProbeKey(config) {
  const nonce = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return objectKey(config, `.sync/connection-probe-${nonce}`);
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

export function createS3Backend(config, dependencies = {}) {
  const normalized = validateProviderConfig(config);
  const client = dependencies.client || createClient(normalized);
  const requestTimeoutMs = boundedTimeout(
    normalized.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS
  );
  const requestTimeoutExplicit = normalized.requestTimeoutMs != null
    && normalized.requestTimeoutMs !== '';
  const streamTimeoutMs = boundedTimeout(
    normalized.streamTimeoutMs,
    DEFAULT_STREAM_TIMEOUT_MS
  );
  const timers = {
    ...(dependencies.setTimeout ? { setTimeout: dependencies.setTimeout } : {}),
    ...(dependencies.clearTimeout ? { clearTimeout: dependencies.clearTimeout } : {}),
  };
  // In AWS SDK bucket-endpoint mode the command's Bucket value is the complete
  // bucket URL. The configured endpoint is therefore the CNAME URL, while the
  // regular bucket setting remains useful when the mode is off.
  const bucket = normalized.bucketEndpoint
    ? normalized.endpoint
    : normalized.bucket;

  async function send(command, options = {}) {
    const timeoutMs = options.timeoutMs || requestTimeoutMs;
    const controller = new AbortController();
    try {
      return await timeoutRace(
        Promise.resolve().then(() => client.send(command, { abortSignal: controller.signal })),
        timeoutMs,
        () => {
          const error = new S3RequestTimeoutError(timeoutMs);
          controller.abort(error);
          return error;
        },
        timers
      );
    } catch (err) {
      if (
        normalized.providerPreset === 'aliyun-oss'
        && errorCodes(err).has('publicendpointforbidden')
      ) {
        throw new Error(
          'Aliyun OSS rejected its public endpoint. Bind an HTTPS custom CNAME to the bucket, '
          + 'then enable Bucket/CNAME endpoint mode in sync settings.',
          { cause: err }
        );
      }
      throw err;
    }
  }

  async function getBytesWithMetadata(key, options = {}) {
    key = assertValidObjectKey(key);
    try {
      const response = await send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ...conditionalInput(options),
      }));
      const metadata = responseMetadata(response);
      const bytes = await bodyToBytes(response.Body, {
        maxBytes: options.maxBytes,
        contentLength: metadata.contentLength,
        streamTimeoutMs,
        totalStreamTimeoutMs: downloadStreamTimeout(
          metadata.contentLength,
          options.maxBytes,
          requestTimeoutMs,
          requestTimeoutExplicit
        ),
        ...timers,
      });
      return getResult(metadata, { bytes });
    } catch (err) {
      if (isNotModifiedError(err)) {
        return getResult(errorResponseMetadata(err), { notModified: true });
      }
      if (isNotFoundError(err)) {
        return getResult(errorResponseMetadata(err), { notFound: true, exists: false });
      }
      throw err;
    }
  }

  async function putBytes(key, body, contentType = 'application/octet-stream', options = {}) {
    key = assertValidObjectKey(key);
    if (contentType && typeof contentType === 'object') {
      options = contentType;
      contentType = options.contentType || 'application/octet-stream';
    }
    const response = await send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
      ...conditionalInput(options),
    }), {
      timeoutMs: uploadRequestTimeout(body, requestTimeoutMs, requestTimeoutExplicit),
    });
    return putResult(response);
  }

  async function deleteObject(key, options = {}) {
    key = assertValidObjectKey(key);
    await send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(options.ifMatch != null ? { IfMatch: options.ifMatch } : {}),
    }));
  }

  async function listObjects(prefix, options = {}) {
    prefix = assertValidObjectKey(prefix, 'S3 object-listing prefix');
    const requestedMaxObjects = Number(options.maxObjects);
    const maxObjects = Number.isFinite(requestedMaxObjects)
      ? Math.min(100_000, Math.max(1, Math.floor(requestedMaxObjects)))
      : 100_000;
    const requestedPageSize = Number(options.maxKeys);
    const maxKeys = Math.min(
      maxObjects,
      1000,
      Number.isFinite(requestedPageSize) ? Math.max(1, Math.floor(requestedPageSize)) : 1000
    );
    const objects = [];
    const objectKeys = new Set();
    const continuationTokens = new Set();
    let continuationToken;
    do {
      const response = await send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: Math.min(maxKeys, maxObjects - objects.length),
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }));
      const objectsBeforePage = objects.length;
      for (const item of response.Contents || []) {
        if (!item?.Key) continue;
        if (objectKeys.has(item.Key)) continue;
        objectKeys.add(item.Key);
        objects.push({
          key: item.Key,
          etag: item.ETag ?? null,
          size: normalizedContentLength(item.Size),
          lastModified: normalizedLastModified(item.LastModified),
        });
        if (objects.length >= maxObjects) break;
      }
      if (!response.IsTruncated || objects.length >= maxObjects) break;
      const nextContinuationToken = response.NextContinuationToken;
      if (!nextContinuationToken) {
        throw new Error('S3 object listing was truncated without a continuation token');
      }
      if (continuationTokens.has(nextContinuationToken)) {
        throw new Error('S3 object listing repeated a continuation token');
      }
      if (objects.length === objectsBeforePage) {
        throw new Error('S3 object listing made no object progress on a truncated page');
      }
      continuationTokens.add(nextContinuationToken);
      continuationToken = nextContinuationToken;
    } while (continuationToken);
    return objects;
  }

  return {
    async test(key = defaultProbeKey(normalized)) {
      const probe = new TextEncoder().encode(`cherry-agent-sync-probe:${key}`);
      let uploaded = false;
      try {
        // The probe key is random, so a conditional header adds no practical
        // safety and breaks providers whose S3 layer lacks conditional PUT.
        await putBytes(key, probe, 'application/octet-stream');
        uploaded = true;
        const result = await getBytesWithMetadata(key, { maxBytes: probe.byteLength });
        if (result.notFound || result.notModified || !result.bytes || !bytesEqual(result.bytes, probe)) {
          throw new Error('S3 sync connection probe returned unexpected content');
        }
        return true;
      } finally {
        if (uploaded) await deleteObject(key);
      }
    },

    async getJson(key, fallback = null, options = {}) {
      const result = await getBytesWithMetadata(key, options);
      if (!result.bytes) return fallback;
      return JSON.parse(new TextDecoder().decode(result.bytes));
    },

    async getJsonWithMetadata(key, fallback = null, options = {}) {
      const result = await getBytesWithMetadata(key, options);
      return {
        data: result.bytes ? JSON.parse(new TextDecoder().decode(result.bytes)) : fallback,
        etag: result.etag,
        lastModified: result.lastModified,
        contentLength: result.contentLength,
        notModified: result.notModified,
        exists: result.exists,
      };
    },

    async getBytes(key, options = {}) {
      const result = await getBytesWithMetadata(key, options);
      return result.bytes;
    },

    getBytesWithMetadata,

    async putJson(key, data, options = {}) {
      key = assertValidObjectKey(key);
      const body = JSON.stringify(data);
      const response = await send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'application/json',
        ...conditionalInput(options),
      }), {
        timeoutMs: uploadRequestTimeout(body, requestTimeoutMs, requestTimeoutExplicit),
      });
      return putResult(response);
    },

    putBytes,

    list: listObjects,

    delete: deleteObject,
  };
}

export const __s3BackendInternals = {
  MAX_MAX_ATTEMPTS,
  MAX_INITIAL_STREAM_ALLOCATION,
  MAX_OBJECT_KEY_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STREAM_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  bodyToBytes,
  boundedMaxAttempts,
  boundedTimeout,
  downloadStreamTimeout,
  sizeAwareTransferTimeout,
  uploadRequestTimeout,
  createClient,
  retryMode,
  utf8ByteLengthThroughLimit,
};
