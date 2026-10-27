import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, Fragment } from 'react';
import { optionText, readSelectOptions } from './selectOptions.js';

const option = (props, children) => createElement('option', props, children);

describe('readSelectOptions', () => {
  it('reads value, content and text from plain options', () => {
    const options = readSelectOptions([
      option({ value: 'a' }, 'Alpha'),
      option({ value: 'b' }, 'Beta'),
    ]);
    assert.deepEqual(options.map((o) => o.value), ['a', 'b']);
    assert.deepEqual(options.map((o) => o.text), ['Alpha', 'Beta']);
    assert.equal(options[0].content, 'Alpha');
    assert.equal(options[0].disabled, false);
    assert.equal(options[0].group, null);
  });

  it('derives the value from the text content when value is omitted', () => {
    const options = readSelectOptions([option({}, 'Auto')]);
    assert.equal(options[0].value, 'Auto');
    assert.equal(options[0].text, 'Auto');
  });

  it('keeps disabled options in the list', () => {
    const options = readSelectOptions([
      option({ value: 'x' }, 'X'),
      option({ value: 'y', disabled: true }, 'Y'),
    ]);
    assert.equal(options[1].disabled, true);
    assert.equal(options[0].disabled, false);
  });

  it('preserves optgroup labels as group hints', () => {
    const options = readSelectOptions([
      createElement('optgroup', { label: 'Group A' }, [
        option({ value: '1' }, 'One'),
        option({ value: '2' }, 'Two'),
      ]),
      option({ value: '3' }, 'Three'),
    ]);
    assert.equal(options[0].group, 'Group A');
    assert.equal(options[1].group, 'Group A');
    assert.equal(options[2].group, null);
  });

  it('walks into fragments and skips null/boolean children', () => {
    const includeHidden = false;
    const options = readSelectOptions([
      includeHidden && option({ value: 'never' }, 'Never'),
      createElement(Fragment, null, option({ value: 'real' }, 'Real')),
      null,
    ]);
    assert.equal(options.length, 1);
    assert.equal(options[0].value, 'real');
  });

  it('accepts numbers and expression children as labels', () => {
    const options = readSelectOptions([option({ value: 5 }, 5)]);
    assert.equal(options[0].value, 5);
    assert.equal(options[0].text, '5');
  });

  it('reuses element keys and mints stable fallback keys', () => {
    const options = readSelectOptions([
      option({ key: 'first', value: 'a' }, 'A'),
      option({ value: 'b' }, 'B'),
    ]);
    assert.equal(options[0].key, 'first');
    assert.match(options[1].key, /^option-/);
  });
});

describe('optionText', () => {
  it('flattens nested children into a string', () => {
    const text = optionText(['Hello ', createElement('b', null, 'wor', ['ld']), 42]);
    assert.equal(text, 'Hello world42');
  });

  it('returns empty string for empty-ish nodes', () => {
    assert.equal(optionText(null), '');
    assert.equal(optionText(undefined), '');
    assert.equal(optionText(true), '');
    assert.equal(optionText({}), '');
  });
});
