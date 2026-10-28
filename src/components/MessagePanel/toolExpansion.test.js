import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveToolExpanded, toggleToolExpanded } from './toolExpansion.js';

test('resolveToolExpanded follows the run until the user clicks', () => {
  assert.equal(resolveToolExpanded(null, true), true, 'auto-open while running');
  assert.equal(resolveToolExpanded(null, false), false, 'auto-collapsed when idle');
});

test('resolveToolExpanded lets the user click win over forced expansion', () => {
  assert.equal(resolveToolExpanded(false, true), false, 'user collapsed a running block');
  assert.equal(resolveToolExpanded(true, false), true, 'user expanded an idle block');
});

test('toggleToolExpanded inverts the effective state from the user’s perspective', () => {
  // First click on a running (auto-opened) block must collapse it.
  assert.equal(toggleToolExpanded(null, true), false);
  // First click on an idle (auto-collapsed) block must open it.
  assert.equal(toggleToolExpanded(null, false), true);
  // Later clicks invert the user's own choice, even while still running.
  assert.equal(toggleToolExpanded(false, true), true);
  assert.equal(toggleToolExpanded(true, true), false);
  assert.equal(toggleToolExpanded(true, false), false);
});
