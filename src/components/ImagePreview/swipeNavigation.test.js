import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveImageSwipe } from './swipeNavigation.js';

test('maps horizontal image swipes to previous and next navigation', () => {
  assert.equal(resolveImageSwipe({ deltaX: 72, deltaY: 8, hasPrevious: true, hasNext: true }), -1);
  assert.equal(resolveImageSwipe({ deltaX: -72, deltaY: 8, hasPrevious: true, hasNext: true }), 1);
});

test('ignores short, vertical, and unavailable image swipes', () => {
  assert.equal(resolveImageSwipe({ deltaX: 30, deltaY: 2, hasPrevious: true, hasNext: true }), 0);
  assert.equal(resolveImageSwipe({ deltaX: 64, deltaY: 60, hasPrevious: true, hasNext: true }), 0);
  assert.equal(resolveImageSwipe({ deltaX: 72, deltaY: 4, hasPrevious: false, hasNext: true }), 0);
  assert.equal(resolveImageSwipe({ deltaX: -72, deltaY: 4, hasPrevious: true, hasNext: false }), 0);
});

