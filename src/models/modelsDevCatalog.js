import { waitWithAbort } from '../utils/misc.js';

const CATALOG_URL = 'https://models.dev/api.json';
const CATALOG_TIMEOUT_MS = 5_000;

let catalogPromise;

async function fetchCatalog() {
  const controller = new AbortController();
  const { signal } = controller;
  const timeout = setTimeout(() => controller.abort(new Error('models.dev catalog timed out')), CATALOG_TIMEOUT_MS);
  try {
    return await waitWithAbort(fetch(CATALOG_URL, { signal }).then((response) => {
      if (!response.ok) throw new Error(`models.dev error ${response.status}`);
      return response.json();
    }), signal);
  } finally {
    clearTimeout(timeout);
  }
}

export function loadModelsDevCatalog() {
  if (!catalogPromise) {
    const pending = fetchCatalog().catch((error) => {
      if (catalogPromise === pending) catalogPromise = null;
      throw error;
    });
    catalogPromise = pending;
  }
  return catalogPromise;
}

/** Test hook: drop the cached catalog so fetch can be re-mocked. */
export function resetModelsDevCatalog() { catalogPromise = null; }
