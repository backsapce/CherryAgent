import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampRestoredScrollTop,
  isContentVisibilityRendered,
  resolveSessionScrollSwitch,
} from './sessionScrollRestore.js';

test('a session left scrolled up restores its exact position and window', () => {
  const plan = resolveSessionScrollSwitch(
    { scrollTop: 1234, visibleMessageCount: 260, atBottom: false },
    100
  );

  assert.deepEqual(plan, {
    shouldAutoScroll: false,
    visibleMessageCount: 260,
    restoreScrollTop: 1234,
  });
});

test('a session left pinned to the latest message returns to the bottom', () => {
  const plan = resolveSessionScrollSwitch(
    { scrollTop: 9999, visibleMessageCount: 300, atBottom: true },
    100
  );

  assert.deepEqual(plan, {
    shouldAutoScroll: true,
    visibleMessageCount: 100,
    restoreScrollTop: null,
  });
});

test('a never-visited session pins to the bottom with the default page size', () => {
  const plan = resolveSessionScrollSwitch(null, 40);

  assert.deepEqual(plan, {
    shouldAutoScroll: true,
    visibleMessageCount: 40,
    restoreScrollTop: null,
  });
});

test('a restored scrollTop inside the scrollable range is kept as-is', () => {
  assert.equal(clampRestoredScrollTop(800, 5000, 900), 800);
});

test('a restored scrollTop is clamped when history shrank since it was saved', () => {
  // Edited/retried messages can reduce the scrollable height; never
  // over-scroll past the new bottom.
  assert.equal(clampRestoredScrollTop(4000, 2000, 900), 1100);
});

test('a restored scrollTop clamps to zero when the list fits in the viewport', () => {
  assert.equal(clampRestoredScrollTop(500, 800, 900), 0);
});

test('invalid restored scroll values fall back to the top', () => {
  assert.equal(clampRestoredScrollTop(-50, 5000, 900), 0);
  assert.equal(clampRestoredScrollTop(NaN, 5000, 900), 0);
});

test('an element without checkVisibility support is treated as rendered', () => {
  assert.equal(isContentVisibilityRendered({}), true);
  assert.equal(isContentVisibilityRendered(null), true);
});

test('elements skipped by content-visibility auto are not usable anchors', () => {
  const seen = [];
  const placeholder = {
    checkVisibility(options) {
      seen.push(options);
      return false;
    },
  };
  const rendered = {
    checkVisibility() {
      return true;
    },
  };

  assert.equal(isContentVisibilityRendered(placeholder), false);
  assert.equal(isContentVisibilityRendered(rendered), true);
  assert.deepEqual(seen, [{
    checkOpacity: false,
    checkVisibilityCSS: true,
    contentVisibilityAuto: false,
  }]);
});
