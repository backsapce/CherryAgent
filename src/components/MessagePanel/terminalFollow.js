/**
 * Stick-to-bottom detection for tool terminals.
 *
 * Live command output used to call `scrollToBottom()` on every flush, which
 * made it impossible to scroll up while a command was still streaming. The
 * terminal should follow new output only while the viewport is already at
 * (or near) the bottom; once the user scrolls up, new output must not yank
 * the view back down.
 *
 * Returns true (keep following) when the viewport is at the bottom, when the
 * terminal has no rows yet (not opened/fitted), or when the xterm internals
 * are unreachable — fail open so live output never appears frozen.
 */
export function isTerminalAtBottom(terminal) {
  try {
    if (!terminal || !Number.isFinite(terminal.rows) || terminal.rows <= 0) return true;
    const buffer = terminal.buffer?.active;
    if (!buffer || !Number.isFinite(buffer.viewportY)) return true;
    return buffer.viewportY >= buffer.length - terminal.rows;
  } catch {
    return true;
  }
}
