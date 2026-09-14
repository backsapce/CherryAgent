import { imageMimeFromPath } from '../../utils/misc.js';

export function imageMimeFromFileName(fileName = '') {
  return imageMimeFromPath(fileName);
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
