import assert from 'node:assert/strict';
import test from 'node:test';

import { imageDownloadName } from './imageDownload.js';

test('uses the image source filename instead of the blob URL identifier', () => {
  assert.equal(
    imageDownloadName({ name: 'generated-poster.png', path: 'outputs/generated-poster.png' }, 'image/png'),
    'generated-poster.png',
  );
});

test('uses the path filename when metadata name lacks an extension', () => {
  assert.equal(
    imageDownloadName({ name: 'generated-poster', path: 'outputs/generated-poster.webp' }, 'image/webp'),
    'generated-poster.webp',
  );
});

test('adds an extension inferred from the image MIME type', () => {
  assert.equal(
    imageDownloadName({ name: 'generated-poster', path: 'outputs/generated-poster' }, 'image/jpeg; charset=binary'),
    'generated-poster.jpg',
  );
});

test('supports Windows-style source paths and a safe fallback name', () => {
  assert.equal(imageDownloadName({ path: String.raw`outputs\chart.svg` }, 'image/svg+xml'), 'chart.svg');
  assert.equal(imageDownloadName({}, 'image/png'), 'image.png');
});
