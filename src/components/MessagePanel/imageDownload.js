const IMAGE_EXTENSION_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
};

function basename(path) {
  const name = String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.trim() || '';
  return [...name]
    .filter((character) => {
      const code = character.codePointAt(0);
      return code >= 32 && code !== 127;
    })
    .join('');
}

function hasExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1;
}

export function imageDownloadName(reference, mimeType = '') {
  const suppliedName = basename(reference?.name);
  const pathName = basename(reference?.path);
  const baseName = hasExtension(suppliedName)
    ? suppliedName
    : (hasExtension(pathName) ? pathName : (suppliedName || pathName || 'image'));

  if (hasExtension(baseName)) return baseName;

  const normalizedMime = String(mimeType || reference?.mime_type || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  const extension = IMAGE_EXTENSION_BY_MIME[normalizedMime];
  return extension ? `${baseName.replace(/\.+$/, '') || 'image'}.${extension}` : baseName;
}
