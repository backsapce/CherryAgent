import { Children, isValidElement } from 'react';

/**
 * Extract a plain-text label from an <option>'s children, mirroring how the
 * native control derives its visible text (strings/numbers concatenated in
 * document order).
 */
export function optionText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(optionText).join('');
  if (isValidElement(node)) return optionText((node.props || {}).children);
  return '';
}

/**
 * Flatten <option> / <optgroup> children into a plain option model the custom
 * Select renders as a themed listbox. Semantics mirror the native control:
 *  - an option without an explicit `value` uses its text content as value
 *  - `disabled` options stay in the list but cannot be picked
 *  - <optgroup label> is preserved as a group hint on its options
 */
export function readSelectOptions(children) {
  const options = [];
  let anonymousKeySeed = 0;

  const pushOption = (element, group) => {
    const props = element.props || {};
    const content = props.children !== undefined ? props.children : null;
    const value = props.value !== undefined ? props.value : optionText(content);
    options.push({
      value,
      content,
      text: optionText(content),
      disabled: Boolean(props.disabled),
      group: group || null,
      key: element.key != null ? element.key : `option-${anonymousKeySeed++}`,
    });
  };

  const walk = (nodes, group) => {
    Children.forEach(nodes, (node) => {
      if (node === null || node === undefined || typeof node === 'boolean') return;
      if (!isValidElement(node)) return;
      const props = node.props || {};
      if (node.type === 'option') {
        pushOption(node, group);
      } else if (node.type === 'optgroup') {
        walk(props.children, props.label || '');
      } else if (node.type === Symbol.for('react.fragment')) {
        walk(props.children, group);
      }
    });
  };

  walk(children, null);
  return options;
}
