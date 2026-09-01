const IMAGE_MIME_TYPES = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

export function imageMimeFromFileName(fileName = '') {
  const extension = String(fileName).split('.').pop()?.toLowerCase();
  return IMAGE_MIME_TYPES[extension] || '';
}

export function isImageFile(fileName = '') {
  return Boolean(imageMimeFromFileName(fileName));
}

export function directoryImageNames(entries = []) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => entry?.type === 'file' && isImageFile(entry.name))
    .map((entry) => entry.name);
}

export function ensureImageBlobType(blob, fileName) {
  const inferredType = imageMimeFromFileName(fileName);
  if (!inferredType || blob.type?.toLowerCase().startsWith('image/')) return blob;
  return new Blob([blob], { type: inferredType });
}
