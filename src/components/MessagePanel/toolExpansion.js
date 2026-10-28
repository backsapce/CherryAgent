/**
 * Tri-state expansion for tool blocks.
 *
 * Live `execute_command` blocks auto-open so the terminal is visible while a
 * command runs. That auto-open must never swallow the user's click: once the
 * header is clicked, the user's choice wins even while the command is still
 * running (clicking a running block collapses it; clicking again reopens).
 *
 * userExpanded === null  → no click yet, follow the run (`autoExpanded`)
 * userExpanded === true/false → the user clicked; use it verbatim
 */

export function resolveToolExpanded(userExpanded, autoExpanded) {
  return userExpanded ?? Boolean(autoExpanded);
}

export function toggleToolExpanded(userExpanded, autoExpanded) {
  return !resolveToolExpanded(userExpanded, autoExpanded);
}
