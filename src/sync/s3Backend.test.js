import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  S3ObjectTooLargeError,
  S3RequestTimeoutError,
  S3StreamTimeoutError,
  __s3BackendInternals,
  assertValidObjectKey,
  createS3Backend,
  isConditionalRequestConflictError,
  isConditionalRequestUnsupported,
  isConditionalWriteConflictError,
  isNotFoundError,
  isNotModifiedError,
  isPreconditionFailed,
  isPreconditionFailedError,
  objectKey,
} from './s3Backend.js';

const TEST_CONFIG = {
  region: 'us-east-1',
  bucket: 'test-bucket',
  prefix: 'cherry-agent',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
};

class FakeClient {
  constructor(handler) {
    this.handler = handler;
    this.commands = [];
    this.sendOptions = [];
  }

  async send(command, options) {
    this.commands.push(command);
    this.sendOptions.push(options);
    return this.handler(command, this.commands.length - 1, options);
  }
}

function awsError(name, statusCode, headers = undefined) {
  const err = new Error(name);
  err.name = name;
  err.$metadata = { httpStatusCode: statusCode };
  if (headers) err.$response = { statusCode, headers };
  return err;
}

test('object keys normalize prefix and suffix slashes', () => {
  assert.equal(objectKey({ prefix: '/cherry-agent/' }, '/manifest.json/'), 'cherry-agent/manifest.json');
  assert.equal(objectKey({}, 'manifest.json'), 'manifest.json');
});

test('object keys enforce the S3 1,024 UTF-8-byte ceiling', () => {
  const exactAscii = 'a'.repeat(1024);
  const exactMultibyte = '\u00e9'.repeat(512);
  assert.equal(assertValidObjectKey(exactAscii), exactAscii);
  assert.equal(assertValidObjectKey(exactMultibyte), exactMultibyte);
  assert.throws(
    () => assertValidObjectKey(`${exactAscii}a`),
    /exceeds the 1,024 UTF-8-byte S3 limit/
  );
  assert.throws(
    () => objectKey({ prefix: 'p'.repeat(1024) }, 'object'),
    /exceeds the 1,024 UTF-8-byte S3 limit/
  );
  assert.throws(
    () => objectKey({}, '\ud83d\ude00'.repeat(257)),
    /exceeds the 1,024 UTF-8-byte S3 limit/
  );
});

test('backend operations reject oversized keys before issuing a request', async () => {
  const client = new FakeClient(async () => {
    throw new Error('request should not be issued');
  });
  const backend = createS3Backend(TEST_CONFIG, { client });
  const oversized = 'a'.repeat(1025);

  await assert.rejects(backend.getBytes(oversized), /1,024 UTF-8-byte S3 limit/);
  await assert.rejects(backend.putBytes(oversized, new Uint8Array()), /1,024 UTF-8-byte S3 limit/);
  await assert.rejects(backend.putJson(oversized, {}), /1,024 UTF-8-byte S3 limit/);
  await assert.rejects(backend.delete(oversized), /1,024 UTF-8-byte S3 limit/);
  await assert.rejects(backend.list(oversized), /listing prefix exceeds the 1,024 UTF-8-byte S3 limit/i);
  await assert.rejects(backend.test(oversized), /1,024 UTF-8-byte S3 limit/);
  assert.equal(client.commands.length, 0);
});

test('S3 client uses bounded retries and required-only checksum behavior', async () => {
  const lowerBounded = __s3BackendInternals.createClient({
    ...TEST_CONFIG,
    maxAttempts: 0,
    retryMode: 'invalid',
  });
  const upperBounded = __s3BackendInternals.createClient({
    ...TEST_CONFIG,
    maxAttempts: 99,
    retryMode: 'adaptive',
  });
  const defaulted = __s3BackendInternals.createClient({
    ...TEST_CONFIG,
    maxAttempts: '',
  });

  try {
    assert.equal(await lowerBounded.config.maxAttempts(), 1);
    assert.equal(lowerBounded.config.retryMode, 'standard');
    assert.equal(await lowerBounded.config.requestChecksumCalculation(), 'WHEN_REQUIRED');
    assert.equal(await lowerBounded.config.responseChecksumValidation(), 'WHEN_REQUIRED');
    assert.equal(
      await upperBounded.config.maxAttempts(),
      __s3BackendInternals.MAX_MAX_ATTEMPTS
    );
    assert.equal(upperBounded.config.retryMode, 'adaptive');
    assert.equal(await defaulted.config.maxAttempts(), 3);
  } finally {
    lowerBounded.destroy();
    upperBounded.destroy();
    defaulted.destroy();
  }
});

test('transport timeout settings are bounded', () => {
  assert.equal(
    __s3BackendInternals.boundedTimeout('', __s3BackendInternals.DEFAULT_REQUEST_TIMEOUT_MS),
    __s3BackendInternals.DEFAULT_REQUEST_TIMEOUT_MS
  );
  assert.equal(
    __s3BackendInternals.boundedTimeout(1, __s3BackendInternals.DEFAULT_REQUEST_TIMEOUT_MS),
    __s3BackendInternals.MIN_TIMEOUT_MS
  );
  assert.equal(
    __s3BackendInternals.boundedTimeout(Infinity, __s3BackendInternals.DEFAULT_REQUEST_TIMEOUT_MS),
    __s3BackendInternals.DEFAULT_REQUEST_TIMEOUT_MS
  );
  assert.equal(
    __s3BackendInternals.boundedTimeout(
      Number.MAX_SAFE_INTEGER,
      __s3BackendInternals.DEFAULT_REQUEST_TIMEOUT_MS
    ),
    __s3BackendInternals.MAX_TIMEOUT_MS
  );
  const largeBody = new Uint8Array(10 * 1024 * 1024);
  assert.ok(
    __s3BackendInternals.uploadRequestTimeout(
      largeBody,
      __s3BackendInternals.DEFAULT_REQUEST_TIMEOUT_MS
    ) > __s3BackendInternals.DEFAULT_REQUEST_TIMEOUT_MS
  );
  assert.equal(
    __s3BackendInternals.uploadRequestTimeout(largeBody, 12_345, true),
    12_345
  );
});

test('hung SDK requests are aborted and fail with a bounded timeout', async () => {
  let observedSignal = null;
  const client = new FakeClient((_command, _index, options) => {
    observedSignal = options.abortSignal;
    return new Promise(() => {});
  });
  const backend = createS3Backend(TEST_CONFIG, {
    client,
    setTimeout: (callback) => {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeout: () => {},
  });

  await assert.rejects(
    backend.getBytes('hung'),
    (error) => error instanceof S3RequestTimeoutError
      && error.timeoutMs === __s3BackendInternals.DEFAULT_REQUEST_TIMEOUT_MS
  );
  assert.equal(observedSignal.aborted, true);
});

test('idle response streams are canceled and fail with a bounded timeout', async () => {
  let canceled = false;
  const stream = new ReadableStream({
    cancel() {
      canceled = true;
    },
  });

  await assert.rejects(
    __s3BackendInternals.bodyToBytes(stream, {
      streamTimeoutMs: 1,
      setTimeout: (callback) => {
        queueMicrotask(callback);
        return 1;
      },
      clearTimeout: () => {},
    }),
    (error) => error instanceof S3StreamTimeoutError
      && error.timeoutMs === __s3BackendInternals.MIN_TIMEOUT_MS
  );
  assert.equal(canceled, true);

  let transformCanceled = false;
  const transformBody = {
    transformToByteArray: () => new Promise(() => {}),
    cancel: async () => { transformCanceled = true; },
  };
  await assert.rejects(
    __s3BackendInternals.bodyToBytes(transformBody, {
      setTimeout: (callback) => {
        queueMicrotask(callback);
        return 1;
      },
      clearTimeout: () => {},
    }),
    S3StreamTimeoutError
  );
  assert.equal(transformCanceled, true);
});

test('trickling response streams are canceled at their total deadline', async () => {
  let controller;
  let canceled = false;
  let totalDeadlineCallback;
  let nextTimerId = 0;
  const timers = new Map();
  const stream = new ReadableStream({
    start(value) {
      controller = value;
    },
    cancel() {
      canceled = true;
    },
  });
  const readPromise = __s3BackendInternals.bodyToBytes(stream, {
    streamTimeoutMs: __s3BackendInternals.MAX_TIMEOUT_MS,
    totalStreamTimeoutMs: 1,
    setTimeout(callback, timeoutMs) {
      const id = ++nextTimerId;
      timers.set(id, callback);
      if (timeoutMs === __s3BackendInternals.MIN_TIMEOUT_MS) {
        totalDeadlineCallback = callback;
      }
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });

  controller.enqueue(new Uint8Array([1]));
  await Promise.resolve();
  controller.enqueue(new Uint8Array([2]));
  await Promise.resolve();
  assert.equal(typeof totalDeadlineCallback, 'function');
  totalDeadlineCallback();

  await assert.rejects(
    readPromise,
    (error) => error instanceof S3StreamTimeoutError
      && error.reason === 'deadline'
      && error.timeoutMs === __s3BackendInternals.MIN_TIMEOUT_MS
  );
  assert.equal(canceled, true);
});

test('download deadlines scale with Content-Length and honor explicit limits', () => {
  const tenMiB = 10 * 1024 * 1024;
  assert.equal(
    __s3BackendInternals.downloadStreamTimeout(
      tenMiB,
      null,
      __s3BackendInternals.DEFAULT_REQUEST_TIMEOUT_MS
    ),
    70_000
  );
  assert.equal(
    __s3BackendInternals.downloadStreamTimeout(tenMiB, null, 12_345, true),
    12_345
  );
  assert.equal(
    __s3BackendInternals.downloadStreamTimeout(
      null,
      tenMiB,
      __s3BackendInternals.DEFAULT_REQUEST_TIMEOUT_MS
    ),
    70_000
  );
});

test('S3 client and commands honor exact bucket/CNAME endpoint mode', async () => {
  const endpointConfig = {
    ...TEST_CONFIG,
    providerPreset: 'aliyun-oss',
    endpoint: 'https://bucket.storage.example.test',
    bucketEndpoint: true,
    forcePathStyle: false,
  };
  const sdkClient = __s3BackendInternals.createClient(endpointConfig);
  try {
    assert.equal(sdkClient.config.bucketEndpoint, true);
    assert.equal(sdkClient.config.forcePathStyle, false);
  } finally {
    sdkClient.destroy();
  }

  const client = new FakeClient(async () => ({ Body: new Uint8Array([1]), ContentLength: 1 }));
  const backend = createS3Backend(endpointConfig, { client });
  await backend.getBytes('object');
  assert.equal(client.commands[0].input.Bucket, 'https://bucket.storage.example.test');

  const bucketlessConfig = { ...endpointConfig };
  delete bucketlessConfig.bucket;
  const bucketlessClient = new FakeClient(async () => ({
    Body: new Uint8Array([1]),
    ContentLength: 1,
  }));
  const bucketlessBackend = createS3Backend(bucketlessConfig, { client: bucketlessClient });
  await bucketlessBackend.getBytes('object');
  assert.equal(
    bucketlessClient.commands[0].input.Bucket,
    'https://bucket.storage.example.test'
  );

  const resolvedRequests = [];
  const middlewareClient = __s3BackendInternals.createClient(bucketlessConfig, {
    requestHandler: {
      handle: async (request) => {
        resolvedRequests.push(request);
        return {
          response: {
            statusCode: 200,
            headers: {},
            body: Readable.from([]),
          },
        };
      },
    },
  });
  try {
    await middlewareClient.send(new PutObjectCommand({
      Bucket: bucketlessConfig.endpoint,
      Key: 'nested/object',
      Body: new Uint8Array([1]),
    }));
    assert.equal(resolvedRequests[0].protocol, 'https:');
    assert.equal(resolvedRequests[0].hostname, 'bucket.storage.example.test');
    assert.equal(resolvedRequests[0].path, '/nested/object');
  } finally {
    middlewareClient.destroy();
  }
});

test('backend construction rejects invalid provider configuration before use', () => {
  const client = new FakeClient(async () => ({}));
  assert.throws(
    () => createS3Backend({ ...TEST_CONFIG, providerPreset: 'custom', endpoint: '' }, { client }),
    /requires an explicit endpoint/
  );
  assert.throws(
    () => createS3Backend({
      ...TEST_CONFIG,
      providerPreset: 'custom',
      endpoint: 'https://access:secret@storage.example.test',
    }, { client }),
    /must not contain credentials/
  );
  assert.equal(client.commands.length, 0);
});

test('Aliyun public-endpoint rejection explains the required CNAME configuration', async () => {
  const client = new FakeClient(async () => {
    throw awsError('PublicEndpointForbidden', 403);
  });
  const backend = createS3Backend({
    ...TEST_CONFIG,
    providerPreset: 'aliyun-oss',
    region: 'cn-beijing',
  }, { client });

  await assert.rejects(
    backend.getBytes('object'),
    /Bind an HTTPS custom CNAME.*Bucket\/CNAME endpoint mode/i
  );
});

test('putJson writes compact JSON, applies conditions, and returns version metadata', async () => {
  const client = new FakeClient(async (command) => {
    assert.equal(command.constructor.name, 'PutObjectCommand');
    assert.deepEqual(command.input, {
      Bucket: 'test-bucket',
      Key: 'manifest.json',
      Body: '{"version":2,"files":{}}',
      ContentType: 'application/json',
      IfMatch: '"old-etag"',
    });
    return { ETag: '"new-etag"', VersionId: 'version-2' };
  });
  const backend = createS3Backend(TEST_CONFIG, { client });

  assert.deepEqual(
    await backend.putJson('manifest.json', { version: 2, files: {} }, { ifMatch: '"old-etag"' }),
    { etag: '"new-etag"', versionId: 'version-2' }
  );
});

test('putBytes forwards Uint8Array and Blob bodies without copying', async () => {
  const bodies = [];
  const client = new FakeClient(async (command) => {
    bodies.push(command.input.Body);
    return {};
  });
  const backend = createS3Backend(TEST_CONFIG, { client });
  const bytes = new Uint8Array([1, 2, 3]);
  const blob = new Blob(['blob body'], { type: 'text/plain' });

  await backend.putBytes('bytes', bytes, 'application/octet-stream', { ifNoneMatch: '*' });
  await backend.putBytes('blob', blob, { contentType: 'text/plain', ifMatch: '"etag"' });

  assert.strictEqual(bodies[0], bytes);
  assert.strictEqual(bodies[1], blob);
  assert.equal(client.commands[0].input.IfNoneMatch, '*');
  assert.equal(client.commands[1].input.IfMatch, '"etag"');
  assert.equal(client.commands[1].input.ContentType, 'text/plain');
});

test('conditional delete forwards If-Match', async () => {
  const client = new FakeClient(async (command) => {
    assert.equal(command.constructor.name, 'DeleteObjectCommand');
    assert.deepEqual(command.input, {
      Bucket: 'test-bucket',
      Key: 'manifests/old.json',
      IfMatch: '"old-etag"',
    });
    return {};
  });
  const backend = createS3Backend(TEST_CONFIG, { client });

  await backend.delete('manifests/old.json', { ifMatch: '"old-etag"' });
});

test('conditional GET exposes bytes and response metadata', async () => {
  const lastModified = new Date('2026-07-15T00:00:00.000Z');
  const body = new Uint8Array([4, 5, 6]);
  const client = new FakeClient(async (command) => ({
    Body: body,
    ETag: '"etag-1"',
    LastModified: lastModified,
    ContentLength: body.byteLength,
    VersionId: 'version-1',
    $metadata: { httpStatusCode: 200 },
    input: command.input,
  }));
  const backend = createS3Backend(TEST_CONFIG, { client });

  const result = await backend.getBytesWithMetadata('object', {
    ifMatch: '"required-etag"',
    ifNoneMatch: '"cached-etag"',
    maxBytes: 3,
  });

  assert.strictEqual(result.bytes, body);
  assert.equal(result.etag, '"etag-1"');
  assert.equal(result.lastModified, lastModified);
  assert.equal(result.contentLength, 3);
  assert.equal(result.versionId, 'version-1');
  assert.equal(result.statusCode, 200);
  assert.equal(result.exists, true);
  assert.equal(result.notModified, false);
  assert.deepEqual(client.commands[0].input, {
    Bucket: 'test-bucket',
    Key: 'object',
    IfMatch: '"required-etag"',
    IfNoneMatch: '"cached-etag"',
  });
});

test('getJsonWithMetadata returns the stable integration shape', async () => {
  const data = { version: 2 };
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const modified = new Date('2026-07-15T01:00:00.000Z');
  const client = new FakeClient(async () => ({
    Body: bytes,
    ETag: '"json-etag"',
    LastModified: modified,
    ContentLength: bytes.byteLength,
  }));
  const backend = createS3Backend(TEST_CONFIG, { client });

  assert.deepEqual(await backend.getJsonWithMetadata('manifest.json'), {
    data,
    etag: '"json-etag"',
    lastModified: modified,
    contentLength: bytes.byteLength,
    notModified: false,
    exists: true,
  });
});

test('304 and 404 responses are represented without losing their distinction', async () => {
  const notModifiedClient = new FakeClient(async () => {
    throw awsError('NotModified', 304, {
      etag: '"cached-etag"',
      'last-modified': 'Wed, 15 Jul 2026 00:00:00 GMT',
    });
  });
  const missingClient = new FakeClient(async () => {
    throw awsError('NoSuchKey', 404);
  });
  const notModifiedBackend = createS3Backend(TEST_CONFIG, { client: notModifiedClient });
  const missingBackend = createS3Backend(TEST_CONFIG, { client: missingClient });

  assert.deepEqual(await notModifiedBackend.getJsonWithMetadata('manifest.json', { cached: true }), {
    data: { cached: true },
    etag: '"cached-etag"',
    lastModified: new Date('2026-07-15T00:00:00.000Z'),
    contentLength: null,
    notModified: true,
    exists: true,
  });
  assert.deepEqual(await missingBackend.getJsonWithMetadata('manifest.json', { empty: true }), {
    data: { empty: true },
    etag: null,
    lastModified: null,
    contentLength: null,
    notModified: false,
    exists: false,
  });
  assert.equal(await missingBackend.getBytes('missing'), null);
  assert.deepEqual(await missingBackend.getJson('missing', { fallback: true }), { fallback: true });
});

test('maxBytes rejects advertised and streamed oversized bodies', async () => {
  const advertisedClient = new FakeClient(async () => ({
    Body: new Uint8Array([1, 2, 3, 4]),
    ContentLength: 4,
  }));
  const advertisedBackend = createS3Backend(TEST_CONFIG, { client: advertisedClient });

  await assert.rejects(
    advertisedBackend.getBytes('large', { maxBytes: 3 }),
    (err) => err instanceof S3ObjectTooLargeError
      && err.maxBytes === 3
      && err.receivedBytes === 4
  );

  let canceled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3, 4]));
    },
    cancel() {
      canceled = true;
    },
  });

  await assert.rejects(
    __s3BackendInternals.bodyToBytes(stream, { maxBytes: 3 }),
    S3ObjectTooLargeError
  );
  assert.equal(canceled, true);
});

test('a short stream does not retain a large advertised backing buffer', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([7]));
      controller.close();
    },
  });

  const bytes = await __s3BackendInternals.bodyToBytes(stream, {
    maxBytes: 64 * 1024 * 1024,
    contentLength: 64 * 1024 * 1024,
  });

  assert.deepEqual([...bytes], [7]);
  assert.equal(bytes.buffer.byteLength, 1);
});

test('error helpers recognize AWS and S3-compatible conditional responses', () => {
  const notModified = awsError('Unknown', 304);
  const missing = awsError('NoSuchKey', 404);
  const precondition = awsError('PreconditionFailed', 412);
  const conflict = awsError('ConditionalRequestConflict', 409);
  const describedConflict = awsError('Conflict', 409);
  describedConflict.message = 'A conflicting conditional request is already in progress';
  const genericConflict = awsError('Conflict', 409);
  const operationAborted = awsError('OperationAborted', 409);
  operationAborted.message = 'A conflicting operation is currently in progress';
  const unsupported = awsError('NotImplemented', 501);
  const alternateCode = awsError('Error', 400);
  alternateCode.Code = 'InvalidRequest';
  alternateCode.message = 'The If-Match conditional header is not supported';
  const invalidArgument = awsError('InvalidArgument', 400);
  invalidArgument.message = 'The If-None-Match header is unsupported';

  assert.equal(isNotModifiedError(notModified), true);
  assert.equal(isNotFoundError(missing), true);
  assert.equal(isPreconditionFailedError(precondition), true);
  assert.equal(isPreconditionFailed(precondition), true);
  assert.equal(isConditionalRequestConflictError(conflict), true);
  assert.equal(isConditionalRequestConflictError(describedConflict), true);
  assert.equal(isConditionalRequestConflictError(genericConflict), false);
  assert.equal(isConditionalRequestConflictError(operationAborted), false);
  assert.equal(isConditionalWriteConflictError(precondition), true);
  assert.equal(isConditionalWriteConflictError(conflict), true);
  assert.equal(isConditionalRequestUnsupported(unsupported), true);
  assert.equal(isConditionalRequestUnsupported(awsError('MethodNotAllowed', 405)), true);
  assert.equal(isConditionalRequestUnsupported(alternateCode), true);
  assert.equal(isConditionalRequestUnsupported(invalidArgument), true);
  assert.equal(isConditionalRequestUnsupported(precondition), false);
  assert.equal(isNotFoundError(awsError('NoSuchBucket', 404)), false);
  assert.equal(isNotFoundError(awsError('AccessDenied', 404)), false);
  assert.equal(isNotFoundError(awsError('UnknownError', 404)), false);
  const genericMissingBucket = awsError('NotFound', 404);
  genericMissingBucket.Code = 'NoSuchBucket';
  assert.equal(isNotFoundError(genericMissingBucket), false);
});

test('connection test uses scoped put/get/delete and always deletes an uploaded probe', async () => {
  const key = 'cherry-agent/.sync/test-probe';
  let stored = null;
  const client = new FakeClient(async (command) => {
    if (command.constructor.name === 'PutObjectCommand') {
      stored = command.input.Body;
      return { ETag: '"probe-etag"' };
    }
    if (command.constructor.name === 'GetObjectCommand') {
      return { Body: stored, ContentLength: stored.byteLength };
    }
    if (command.constructor.name === 'DeleteObjectCommand') {
      stored = null;
      return {};
    }
    throw new Error(`Unexpected command: ${command.constructor.name}`);
  });
  const backend = createS3Backend(TEST_CONFIG, { client });

  assert.equal(await backend.test(key), true);
  assert.deepEqual(client.commands.map((command) => command.constructor.name), [
    'PutObjectCommand',
    'GetObjectCommand',
    'DeleteObjectCommand',
  ]);
  assert.equal(client.commands[0].input.Key, key);
  assert.equal(client.commands[0].input.IfNoneMatch, undefined);
  assert.equal(client.commands[1].input.Key, key);
  assert.equal(client.commands[2].input.Key, key);
  assert.equal(stored, null);
});

test('connection test deletes the probe when verification fails', async () => {
  let deleted = false;
  const client = new FakeClient(async (command) => {
    if (command.constructor.name === 'PutObjectCommand') return {};
    if (command.constructor.name === 'GetObjectCommand') {
      return { Body: new Uint8Array([0]), ContentLength: 1 };
    }
    if (command.constructor.name === 'DeleteObjectCommand') {
      deleted = true;
      return {};
    }
    throw new Error('Unexpected command');
  });
  const backend = createS3Backend(TEST_CONFIG, { client });

  await assert.rejects(backend.test('probe'), /unexpected content/i);
  assert.equal(deleted, true);
});

test('object listing follows continuation tokens and normalizes metadata', async () => {
  const client = new FakeClient(async (command) => {
    assert.equal(command.constructor.name, 'ListObjectsV2Command');
    if (!command.input.ContinuationToken) {
      return {
        Contents: [{
          Key: 'cherry-agent/manifests/a.json',
          ETag: '"a"',
          Size: 12,
          LastModified: '2026-07-15T00:00:00.000Z',
        }],
        IsTruncated: true,
        NextContinuationToken: 'page-2',
      };
    }
    assert.equal(command.input.ContinuationToken, 'page-2');
    return {
      Contents: [{ Key: 'cherry-agent/manifests/b.json', Size: 8 }],
      IsTruncated: false,
    };
  });
  const backend = createS3Backend(TEST_CONFIG, { client });

  assert.deepEqual(await backend.list('cherry-agent/manifests/'), [
    {
      key: 'cherry-agent/manifests/a.json',
      etag: '"a"',
      size: 12,
      lastModified: new Date('2026-07-15T00:00:00.000Z'),
    },
    {
      key: 'cherry-agent/manifests/b.json',
      etag: null,
      size: 8,
      lastModified: null,
    },
  ]);
});

test('object listing clamps the first page to the requested object limit', async () => {
  let calls = 0;
  const client = new FakeClient(async (command) => {
    calls += 1;
    assert.equal(command.constructor.name, 'ListObjectsV2Command');
    assert.equal(command.input.MaxKeys, 1);
    return {
      Contents: [{ Key: 'cherry-agent/manifests/a.json', Size: 12 }],
      IsTruncated: true,
      NextContinuationToken: 'unneeded-page',
    };
  });
  const backend = createS3Backend(TEST_CONFIG, { client });

  assert.equal((await backend.list('cherry-agent/manifests/', { maxObjects: 1 })).length, 1);
  assert.equal(calls, 1);
});

test('object listing rejects repeated continuation tokens', async () => {
  const client = new FakeClient(async (command) => ({
    Contents: [{
      Key: command.input.ContinuationToken
        ? 'cherry-agent/manifests/b.json'
        : 'cherry-agent/manifests/a.json',
    }],
    IsTruncated: true,
    NextContinuationToken: 'repeated-token',
  }));
  const backend = createS3Backend(TEST_CONFIG, { client });

  await assert.rejects(
    backend.list('cherry-agent/manifests/'),
    /repeated a continuation token/i
  );
  assert.equal(client.commands.length, 2);
});

test('object listing rejects truncated pages that make no object progress', async () => {
  const client = new FakeClient(async () => ({
    Contents: [],
    IsTruncated: true,
    NextContinuationToken: 'next-page',
  }));
  const backend = createS3Backend(TEST_CONFIG, { client });

  await assert.rejects(
    backend.list('cherry-agent/manifests/'),
    /made no object progress/i
  );
  assert.equal(client.commands.length, 1);
});
