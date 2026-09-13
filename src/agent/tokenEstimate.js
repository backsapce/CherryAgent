/**
 * CJK-aware token estimation.
 *
 * A flat "chars / 4" heuristic matches English prose but overestimates the
 * capacity of CJK text by roughly 3-4x (one CJK character is close to one
 * token). Mixing both scripts — common in this app's user base — needs the
 * two classes counted separately: ~1 token per CJK character, ~1 token per
 * 4 non-CJK characters. Overestimating cost slightly is deliberate: packing
 * decisions must stay on the conservative side of the model's real window.
 */

const CJK_CLASS_RE = /[\u1100-\u11FF\u2E80-\u303F\u3040-\u30FF\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/g;

export function estimateTextTokens(text) {
  const value = String(text || '');
  if (!value) return 0;
  const cjkMatches = value.match(CJK_CLASS_RE);
  const cjkChars = cjkMatches ? cjkMatches.length : 0;
  const otherChars = value.length - cjkChars;
  return cjkChars + Math.ceil(otherChars / 4);
}
