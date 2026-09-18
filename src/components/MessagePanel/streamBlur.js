// Codex-style streaming reveal: while a message streams, rehype wraps each
// word (and each CJK character, which carries no word boundaries) in a span.
// Words that already existed keep their DOM identity across re-renders, so the
// blur-in CSS animation only plays for freshly appended words; when streaming
// ends the markdown is re-rendered without this plugin, leaving a clean tree.

// CJK radicals through compat ideographs render as one glyph per token; every
// other script streams per whitespace-delimited run.
const STREAM_TOKEN_PATTERN = /[\u2E80-\u9FFF\uF900-\uFAFF]|[^\s\u2E80-\u9FFF\uF900-\uFAFF]+|\s+/gu;

export const STREAM_BLUR_WORD_CLASS = 'stream-blur-word';

export function splitStreamTokens(value) {
  const text = String(value || '');
  if (!text) return [];
  const pieces = [];
  let consumed = 0;
  for (const match of text.matchAll(STREAM_TOKEN_PATTERN)) {
    if (match.index > consumed) {
      pieces.push({ type: 'word', value: text.slice(consumed, match.index) });
    }
    consumed = match.index + match[0].length;
    pieces.push(/^\s+$/.test(match[0])
      ? { type: 'space', value: match[0] }
      : { type: 'word', value: match[0] });
  }
  if (consumed < text.length) {
    pieces.push({ type: 'word', value: text.slice(consumed) });
  }
  return pieces;
}

function wrapTextNode(value) {
  const pieces = splitStreamTokens(value);
  let changed = false;
  const nodes = pieces.map((piece) => {
    if (piece.type === 'space') return { type: 'text', value: piece.value };
    changed = true;
    return {
      type: 'element',
      tagName: 'span',
      properties: { className: [STREAM_BLUR_WORD_CLASS] },
      children: [{ type: 'text', value: piece.value }],
    };
  });
  return changed ? nodes : null;
}

export function rehypeStreamWords() {
  return (tree) => {
    const visit = (node) => {
      if (!Array.isArray(node.children)) return;
      for (const child of node.children) {
        if (child.children) visit(child);
      }
      const next = [];
      let changed = false;
      for (const child of node.children) {
        if (child.type === 'text' && child.value) {
          const replacement = wrapTextNode(child.value);
          if (replacement) {
            next.push(...replacement);
            changed = true;
            continue;
          }
        }
        next.push(child);
      }
      if (changed) node.children = next;
    };
    visit(tree);
  };
}
