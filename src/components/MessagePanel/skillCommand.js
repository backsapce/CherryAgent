/**
 * Return the slash-command fragment currently being edited at the start of
 * the composer. Once whitespace is entered, the command is considered chosen.
 */
export function getSkillCommandRange(value, caret) {
  const text = String(value || '');
  const position = Math.max(0, Math.min(Number.isFinite(caret) ? caret : text.length, text.length));
  const match = text.slice(0, position).match(/^\/([^\s/]*)$/u);
  if (!match) return null;
  return { start: 0, end: position, query: match[1] };
}

