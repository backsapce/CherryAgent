import { syncBackendIdentity } from '../../sync/syncManager.js';
import { normalizeProviderPreset } from '../../sync/providerPresets.js';

function providerPresetOrDefault(value) {
  try {
    return normalizeProviderPreset(value);
  } catch {
    return 's3';
  }
}

export function manifestModeFor(value = {}) {
  return providerPresetOrDefault(value.providerPreset) === 'aliyun-oss'
    ? 'sharded'
    : (value.manifestMode === 'sharded' ? 'sharded' : 'conditional');
}

export function hasEstablishedSyncDestination(value = {}) {
  return value.bucketEndpoint === true
    ? Boolean(String(value.endpoint || '').trim())
    : Boolean(String(value.bucket || '').trim());
}

export function sameSyncDestination(left = {}, right = {}) {
  try {
    return syncBackendIdentity(left) === syncBackendIdentity(right);
  } catch {
    // An incomplete Settings form is not an established destination yet.
    return false;
  }
}

export function manifestModeChangeLocked(saved = {}, candidate = {}) {
  return hasEstablishedSyncDestination(saved)
    && sameSyncDestination(saved, candidate)
    && manifestModeFor(saved) !== manifestModeFor(candidate);
}
