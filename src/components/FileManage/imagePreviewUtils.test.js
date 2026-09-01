import test from 'node:test';
import assert from 'node:assert/strict';
import { directoryImageNames, ensureImageBlobType, imageMimeFromFileName, isImageFile } from './imagePreviewUtils.js';

test('detects supported image file names without case sensitivity', () => {
  assert.equal(isImageFile('photo.PNG'), true);
  assert.equal(isImageFile('archive.tar.gz'), false);
  assert.equal(imageMimeFromFileName('drawing.svg'), 'image/svg+xml');
  assert.equal(imageMimeFromFileName('portrait.jpeg'), 'image/jpeg');
});

test('adds an inferred image MIME type when a downloaded blob has none', () => {
  const source = new Blob(['image bytes']);
  const typed = ensureImageBlobType(source, 'photo.webp');
  assert.equal(typed.type, 'image/webp');
});

test('preserves an existing image MIME type', () => {
  const source = new Blob(['image bytes'], { type: 'image/png' });
  assert.equal(ensureImageBlobType(source, 'photo.jpg'), source);
});

test('keeps image files in their directory display order', () => {
  const entries = [
    { type: 'file', name: 'first.png' },
    { type: 'directory', name: 'nested.jpg' },
    { type: 'file', name: 'notes.txt' },
    { type: 'file', name: 'second.WEBP' },
  ];
  assert.deepEqual(directoryImageNames(entries), ['first.png', 'second.WEBP']);
});
