import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDroppedImage } from './droppedImage.js';

for (const sandboxUrl of [undefined, 'https://sandbox.example', 'e2b']) {
  test(`loads a sandbox image from its original source (${sandboxUrl ?? 'default'})`, async () => {
    const file = await loadDroppedImage({
      source: 'remote', type: 'file', name: 'photo.PNG', path: 'pictures/photo.PNG', sandboxUrl,
    }, {
      downloadFile: async (path, url) => {
        assert.equal(path, 'pictures/photo.PNG');
        assert.equal(url, sandboxUrl ?? null);
        return new Blob(['image bytes'], { type: 'application/octet-stream' });
      },
    });
    assert.equal(file.name, 'photo.PNG');
    assert.equal(file.type, 'image/png');
    assert.equal(await file.text(), 'image bytes');
  });
}

test('loads a browser image from its parent directory', async () => {
  const file = await loadDroppedImage({
    source: 'local', type: 'file', name: 'photo.jpg', parentDir: 'pictures',
  }, {
    getFileBlob: async (name, parentDir) => {
      assert.equal(name, 'photo.jpg');
      assert.equal(parentDir, 'pictures');
      return new Blob(['image bytes'], { type: 'image/jpeg' });
    },
  });
  assert.equal(file.type, 'image/jpeg');
});

test('ignores invalid drag data, directories, and non-image files', async () => {
  for (const item of [null, { type: 'directory', name: 'photo.png' }, { type: 'file', name: 'notes.txt' }]) {
    assert.equal(await loadDroppedImage(item, {}), null);
  }
});
