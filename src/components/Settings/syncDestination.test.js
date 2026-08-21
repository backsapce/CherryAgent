import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasEstablishedSyncDestination,
  manifestModeChangeLocked,
  sameSyncDestination,
} from './syncDestination.js';

const cnameDestination = {
  providerPreset: 'custom',
  endpoint: 'https://sync.example.test',
  bucketEndpoint: true,
  bucket: '',
  prefix: 'cherry-agent',
  manifestMode: 'conditional',
};

test('a bucket/CNAME endpoint is established without a cosmetic bucket name', () => {
  assert.equal(hasEstablishedSyncDestination(cnameDestination), true);
  assert.equal(
    manifestModeChangeLocked(cnameDestination, {
      ...cnameDestination,
      manifestMode: 'sharded',
    }),
    true
  );
});

test('changing a cosmetic bucket label cannot bypass a CNAME mode lock', () => {
  const renamed = {
    ...cnameDestination,
    bucket: 'ignored-cosmetic-label',
    manifestMode: 'sharded',
  };
  assert.equal(sameSyncDestination(cnameDestination, renamed), true);
  assert.equal(manifestModeChangeLocked(cnameDestination, renamed), true);
});

test('a different physical destination does not lock manifest mode', () => {
  assert.equal(manifestModeChangeLocked(cnameDestination, {
    ...cnameDestination,
    endpoint: 'https://other.example.test',
    manifestMode: 'sharded',
  }), false);
});

test('incomplete custom destination forms remain editable', () => {
  assert.equal(sameSyncDestination(
    cnameDestination,
    { providerPreset: 'custom', bucketEndpoint: true, endpoint: '' }
  ), false);
});
