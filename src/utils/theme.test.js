import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const src = new URL('../', import.meta.url);
const palette = readFileSync(new URL('theme.css', src), 'utf-8');
const tokens = new Set(Array.from(palette.matchAll(/^\s*(--[\w-]+)\s*:/gm), ([, token]) => token));
const cssFiles = readdirSync(src, { recursive: true }).filter(path => path.endsWith('.css') && path !== 'theme.css');

function parseCss(path) {
  return readFileSync(new URL(path, src), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
}

test('component styles use defined theme tokens', () => {
  for (const path of cssFiles) {
    for (const [, token] of parseCss(path).matchAll(/var\((--(?:color|code|usage|button|shadow|text|bg)-[\w-]+)/g)) {
      assert.ok(tokens.has(token), `${path}: ${token} is missing from theme.css`);
    }
  }
});

test('component styles keep literal palette colors in theme.css', () => {
  const color = /#[\da-f]{3,8}(?![\w-])|\b(?:rgba?|hsla?|hwb|(?:ok)?lch|(?:ok)?lab)\(|\b(?:black|white)\b/i;
  for (const path of cssFiles) {
    for (const [, property, value] of parseCss(path).matchAll(/(?:^|\n)\s*([\w-]+):\s*([^;{}]+);/g)) {
      // Alpha masks use color syntax for opacity, not to paint the UI.
      if (property.endsWith('mask-image') || property === 'white-space') continue;
      assert.doesNotMatch(value, color, `${path}: ${property} should use a theme token`);
    }
  }
});
