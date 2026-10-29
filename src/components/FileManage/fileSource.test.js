import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDefaultFileSource } from './fileSource.js';

test('getDefaultFileSource returns null when agent list or id is missing', () => {
  assert.equal(getDefaultFileSource(null, 'agent-1'), null);
  assert.equal(getDefaultFileSource(undefined, 'agent-1'), null);
  assert.equal(getDefaultFileSource([{ id: 'agent-1' }], null), null);
  assert.equal(getDefaultFileSource([{ id: 'agent-1' }], undefined), null);
  assert.equal(getDefaultFileSource([{ id: 'agent-1' }], ''), null);
});

test('getDefaultFileSource defaults to remote for sandbox-runtime agents', () => {
  const agents = [
    { id: 'agent-1', runtimeMode: 'sandbox', sandboxUrl: 'https://192.168.1.10:3099' },
  ];
  assert.equal(getDefaultFileSource(agents, 'agent-1'), 'remote');
});

test('getDefaultFileSource defaults to local for browser-runtime agents', () => {
  const agents = [
    { id: 'agent-1', runtimeMode: 'browser', sandboxUrl: 'https://192.168.1.10:3099' },
  ];
  assert.equal(getDefaultFileSource(agents, 'agent-1'), 'local');
});

test('getDefaultFileSource falls back to local when runtime mode is unset', () => {
  const agents = [
    { id: 'agent-1', sandboxUrl: 'https://192.168.1.10:3099' },
  ];
  assert.equal(getDefaultFileSource(agents, 'agent-1'), 'local');
});

test('getDefaultFileSource ignores a sandbox runtime without a sandbox URL', () => {
  const agents = [
    { id: 'agent-1', runtimeMode: 'sandbox', sandboxUrl: null },
  ];
  assert.equal(getDefaultFileSource(agents, 'agent-1'), 'local');
});

test('getDefaultFileSource falls back to local for unknown agent ids', () => {
  const agents = [
    { id: 'agent-1', runtimeMode: 'sandbox', sandboxUrl: 'https://192.168.1.10:3099' },
  ];
  assert.equal(getDefaultFileSource(agents, 'agent-2'), 'local');
});
