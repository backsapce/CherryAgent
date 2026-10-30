import test from 'node:test';
import assert from 'node:assert/strict';
import { dataRootDir, ROOT_DIR } from './dataRoot.js';

test('stable and dev bases keep the default data root', () => {
  assert.equal(dataRootDir('/CherryAgent/'), 'cherry-agent');
  assert.equal(dataRootDir('/'), 'cherry-agent');
  assert.equal(dataRootDir(undefined), 'cherry-agent');
});

test('nested base paths get an isolated data root', () => {
  assert.equal(dataRootDir('/CherryAgent/test/'), 'cherry-agent-test');
  assert.equal(dataRootDir('/CherryAgent/preview-x/'), 'cherry-agent-preview-x');
});

test('node (no import.meta.env) falls back to the stable root', () => {
  assert.equal(ROOT_DIR, 'cherry-agent');
});
