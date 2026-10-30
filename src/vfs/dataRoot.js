/**
 * Per-deployment OPFS data root directory name.
 *
 * Browser storage (OPFS, localStorage, Cache Storage) is partitioned per
 * ORIGIN, not per path. Two deployments served from the same origin — e.g.
 * the stable site at /CherryAgent/ and the test site at /CherryAgent/test/
 * on backsapce.github.io — would otherwise open the exact same OPFS
 * directory, sharing (and potentially migrating/rewriting) each other's
 * sessions, files, skills, memory, and settings.
 *
 * The first base path segment names the site itself (the repo on Pages) and
 * is stripped; any remaining segments identify the deployment variant:
 *   /CherryAgent/        → cherry-agent      (stable, unchanged)
 *   /                    → cherry-agent      (dev server, custom domain)
 *   /CherryAgent/test/   → cherry-agent-test (per-push test deployment)
 */

const STABLE_ROOT = 'cherry-agent';

export function dataRootDir(baseUrl) {
  const parts = String(baseUrl || '/').split('/').filter(Boolean);
  const variant = parts
    .slice(1)
    .join('-')
    .replace(/[^A-Za-z0-9._-]+/g, '-');
  return variant ? `${STABLE_ROOT}-${variant}` : STABLE_ROOT;
}

// import.meta.env is undefined under `node --test`; fall back to '/' there.
export const ROOT_DIR = dataRootDir(import.meta.env && import.meta.env.BASE_URL);
