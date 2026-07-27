export const SHOW_HIDDEN_FILES_CONFIG_PATH = 'general.showHiddenFiles';

export function normalizeShowHiddenFiles(value) {
  return value === true;
}

export function isHiddenEntryName(name) {
  return String(name || '').startsWith('.');
}

export function pathContainsHiddenEntry(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .some(isHiddenEntryName);
}

export function filterHiddenFileEntries(listing, showHiddenFiles = false) {
  if (normalizeShowHiddenFiles(showHiddenFiles) || listing == null) return listing;

  if (Array.isArray(listing)) {
    return listing
      .filter((entry) => !isHiddenEntryName(entry?.name))
      .map((entry) => filterHiddenFileEntries(entry, false));
  }

  if (typeof listing !== 'object') return listing;

  const filtered = { ...listing };
  if (Array.isArray(listing.children)) {
    filtered.children = filterHiddenFileEntries(listing.children, false);
  }
  return filtered;
}
