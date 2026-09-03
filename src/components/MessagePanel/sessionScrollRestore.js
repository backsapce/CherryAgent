// In-app session switches should keep each chat history's scroll position
// where the user left it. Nothing persists across browser reloads; the state
// lives in an in-memory Map inside MessagePanel.
//
// Positions are anchored to the message at the top of the viewport instead of
// a raw pixel offset: `.message` uses `content-visibility: auto`, so heights
// of offscreen messages are estimates and a pixel scrollTop cannot be
// restored reliably across re-renders.

/**
 * Decide how the message list should be positioned when a session becomes
 * active. A session the user left scrolled up restores its exact window;
 * anything else (never visited, or left pinned to the latest message) pins
 * the list to the bottom so fresh replies are visible.
 *
 * @param {object|null} savedState last recorded state for the session
 * @param {number} pageSize default number of trailing messages to render
 * @returns {{shouldAutoScroll: boolean, visibleMessageCount: number, restoreScrollTop: number|null}}
 */
export function resolveSessionScrollSwitch(savedState, pageSize) {
  if (savedState && !savedState.atBottom) {
    return {
      shouldAutoScroll: false,
      visibleMessageCount: savedState.visibleMessageCount,
      restoreScrollTop: typeof savedState.scrollTop === 'number' ? savedState.scrollTop : 0,
    };
  }
  return {
    shouldAutoScroll: true,
    visibleMessageCount: pageSize,
    restoreScrollTop: null,
  };
}

/**
 * Clamp a restored scrollTop to the current scrollable range so content that
 * shrank since the position was recorded (edited/retried messages) cannot
 * leave the list over-scrolled.
 */
export function clampRestoredScrollTop(scrollTop, scrollHeight, clientHeight) {
  const maxScrollTop = Math.max(0, (scrollHeight || 0) - (clientHeight || 0));
  return Math.min(Math.max(0, scrollTop || 0), maxScrollTop);
}

/**
 * Whether a message element is really rendered or merely occupying its
 * content-visibility: auto placeholder. Only really rendered elements have
 * trustworthy geometry for scroll anchoring.
 *
 * Browsers without the contentVisibilityAuto option ignore it and report
 * placeholder elements as visible; callers then behave as before the guard
 * existed, which is still safe.
 */
export function isContentVisibilityRendered(element) {
  if (typeof element?.checkVisibility !== 'function') return true;
  return element.checkVisibility({
    checkOpacity: false,
    checkVisibilityCSS: true,
    contentVisibilityAuto: false,
  });
}
