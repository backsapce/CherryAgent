export function normalizeFileManagerPath(path) {
  return String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/');
}

export function joinFileManagerPath(...parts) {
  return normalizeFileManagerPath(
    parts
      .filter((part) => part !== null && part !== undefined && String(part).length > 0)
      .join('/')
  );
}
