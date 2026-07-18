const THINKING_TAG_RE = /<\s*(\/?)\s*think(?:ing)?\s*>/gi;
const THINKING_TAG_PREFIXES = [
  '<think>',
  '<thinking>',
  '</think>',
  '</thinking>',
];

export function createTaggedReasoningParser() {
  return {
    mode: 'reasoning',
    pending: '',
    part: 0,
    sawOpeningTag: false,
    sawClosingTag: false,
  };
}

/**
 * Consume provider reasoning text that may contain literal thinking tags.
 * Tags can be split across stream chunks, and providers may emit more than
 * one tagged thinking section before the final answer.
 */
export function consumeTaggedReasoning(parser, chunk, options = {}) {
  const next = { ...createTaggedReasoningParser(), ...parser };
  let value = `${next.pending}${chunk || ''}`;
  next.pending = '';

  if (!options.final) {
    const pendingIndex = trailingThinkingTagPrefixIndex(value);
    if (pendingIndex >= 0) {
      next.pending = value.slice(pendingIndex);
      value = value.slice(0, pendingIndex);
    }
  }

  const emissions = [];
  let cursor = 0;
  THINKING_TAG_RE.lastIndex = 0;
  for (let match = THINKING_TAG_RE.exec(value); match; match = THINKING_TAG_RE.exec(value)) {
    appendEmission(emissions, next.mode, value.slice(cursor, match.index), next.part);

    const mode = match[1] ? 'text' : 'reasoning';
    if (match[1]) next.sawClosingTag = true;
    else next.sawOpeningTag = true;
    if (mode !== next.mode) {
      next.mode = mode;
      next.part += 1;
    }
    cursor = match.index + match[0].length;
  }
  appendEmission(emissions, next.mode, value.slice(cursor), next.part);

  return { parser: next, emissions };
}

/** Parse tagged content already stored in older transcript entries. */
export function splitTaggedReasoningContent(content) {
  const { parser, emissions } = consumeTaggedReasoning(
    createTaggedReasoningParser(),
    String(content || ''),
    { final: true },
  );
  return {
    thinking: emissions
      .filter((item) => item.type === 'reasoning')
      .map((item) => item.text)
      .join(''),
    text: emissions
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join(''),
    closed: parser.sawClosingTag,
  };
}

function appendEmission(emissions, type, text, part) {
  if (!text) return;
  const previous = emissions.at(-1);
  if (previous?.type === type && previous.part === part) previous.text += text;
  else emissions.push({ type, text, part });
}

function trailingThinkingTagPrefixIndex(value) {
  const index = value.lastIndexOf('<');
  if (index < 0) return -1;
  const tail = value.slice(index);
  if (tail.includes('>')) return -1;
  const normalized = tail.replace(/\s/g, '').toLowerCase();
  return THINKING_TAG_PREFIXES.some((tag) => tag.startsWith(normalized)) ? index : -1;
}
