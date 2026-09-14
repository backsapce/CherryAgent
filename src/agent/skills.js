/**
 * Skills are progressive instructions stored as Markdown.
 *
 * Tier 1: the system prompt gets a compact catalog.
 * Tier 2: the `skill` tool reads one SKILL.md when it is relevant.
 * Tier 3: references are read by name instead of dumping every file.
 */

import {
  listSkillDirs,
  readSkillFile,
  writeSkillFile,
  listSkillRefs,
  readSkillRef,
  listAgentSkillDirs,
  readAgentSkillFile,
  writeAgentSkillFile,
  listAgentSkillRefs,
  readAgentSkillRef,
  writeAgentSkillRef,
} from '../vfs/opfs.js';
import {
  listFiles,
  readFileText,
} from '../models/agent.js';
import config from '../config/config.js';
import {
  MAX_SKILL_CONTENT_CHARS,
  MAX_SKILL_REFERENCE_CHARS,
  formatReferenceContent,
  normalizeReferenceName,
  normalizeSkillName,
  parseFrontmatter,
  safeDirectorySkillName,
  scoreSkill,
  truncateText,
  validateSkillContent,
} from './skillCore.js';

const RUNTIME_SKILL_CATALOG_TIMEOUT_MS = 20_000;

const DEFAULT_SKILLS = [
  {
    name: 'skill-creator',
    content: `---
name: skill-creator
description: Use when creating or improving CherryAgent skills. Helps write concise trigger descriptions, progressive instructions, and optional reference files.
version: 2.1.0
---

# Skill Creator

Use this skill when the user asks to create, revise, or organize a skill.

## Principles

- A skill is a reusable procedure for a specific class of tasks.
- The description is the trigger. Write it so the agent knows exactly when to load the skill.
- Keep SKILL.md focused on the workflow. Put long examples, schemas, and templates in references.
- Skills should tell the agent what to do, what to avoid, and what final output shape is expected.

## Recommended Structure

\`\`\`markdown
---
name: concise-skill-name
description: Use when ...
version: 1.0.0
---

# Concise Skill Name

## When To Use

## Workflow

## Output

## Constraints
\`\`\`

## Workflow

1. Choose a lowercase hyphenated name.
2. Draft frontmatter with a trigger-oriented description.
3. Write the shortest complete procedure.
4. Add reference files only when details are too large or optional.
5. Create or update the skill with the \`skill\` tool's \`write\` action. Write SKILL.md content without \`reference_name\`; write one optional reference by including \`reference_name\`.
`,
  },
];

// ─── Public API ─────────────────────────────────────────────────────────────

// Checking the shipped default skills needs an OPFS directory scan plus a
// read per skill; it runs on every listSkills() call (once per agent turn).
// One check per page load is enough: a user-deleted default stays deleted
// until reload, and a fresh write still lands on the next session.
let defaultSkillsEnsured = null;

export function ensureDefaultSkills() {
  defaultSkillsEnsured ??= ensureDefaultSkillsUncached();
  return defaultSkillsEnsured;
}

/** Test hook: the suite swaps in a fresh virtual OPFS root per case. */
export function resetDefaultSkillsCache() {
  defaultSkillsEnsured = null;
}

async function ensureDefaultSkillsUncached() {
  const existing = await listSkillDirs();
  const existingNames = new Set(existing.map((dir) => dir.name));
  for (const skill of DEFAULT_SKILLS) {
    const existingContent = existingNames.has(skill.name)
      ? await readSkillFile(skill.name, 'SKILL.md')
      : null;
    if (
      !existingContent
      || existingContent.includes('Use the skill tool to upsert the SKILL.md')
      || existingContent.includes('Create or update the skill by writing files under workspace/<active-agent>/skills/')
    ) {
      await writeSkillFile(skill.name, 'SKILL.md', skill.content);
    }
  }
}

/**
 * List all skills in precedence order. OPFS workspace skills override OPFS
 * global skills, and skills in the selected agent runtime override both.
 * @param {string} [agentId]
 * @param {{ agentUrl?: string|null, signal?: AbortSignal|null, runtimeCatalogTimeoutMs?: number }} [options]
 */
async function listSkills(agentId, options = {}) {
  await ensureDefaultSkills();
  const merged = new Map();
  for (const skill of await listSkillsFromGlobal()) {
    merged.set(skill.name, skill);
  }
  if (agentId) {
    for (const skill of await listSkillsFromWorkspace(agentId)) {
      merged.set(skill.name, skill);
    }
  }
  if (options.agentUrl) {
    for (const skill of await listSkillsFromRuntimeAgent(options.agentUrl, {
      signal: options.signal,
      runtimeCatalogTimeoutMs: options.runtimeCatalogTimeoutMs,
    })) {
      merged.set(skill.name, skill);
    }
  }
  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Search skills by query.
 * @param {string} query
 * @param {string} [agentId]
 * @param {{ agentUrl?: string|null, signal?: AbortSignal|null }} [options]
 */
export async function searchSkills(query, agentId, options = {}) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const skills = await listEnabledSkills(agentId, options);
  if (!terms.length) return skills;
  return skills
    .map((skill) => ({ skill, score: scoreSkill(skill, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .map((item) => item.skill);
}

/**
 * Load a skill. References are listed by default and loaded only when requested.
 * @param {string} name
 * @param {string} [agentId]
 * @param {{ referenceName?: string, agentUrl?: string|null, signal?: AbortSignal|null }} [options]
 */
export async function readSkill(name, agentId, options = {}) {
  const resolved = await resolveSkill(name, agentId, options);
  if (!resolved) return null;

  if (options.referenceName) {
    const content = await readReference(resolved, options.referenceName);
    if (content == null) return null;
    return formatReferenceContent(resolved.skill.name, options.referenceName, content);
  }

  let content = truncateText(resolved.content, MAX_SKILL_CONTENT_CHARS);
  if (resolved.skill.references.length > 0) {
    content += `\n\n## Available References\n${resolved.skill.references.map((ref) => `- ${ref.name}`).join('\n')}`;
  }

  return content;
}

/**
 * Create or update an active-agent skill.
 * @param {string} name
 * @param {string} content
 * @param {string} [agentId]
 */
export async function writeSkill(name, content, agentId) {
  const sanitized = normalizeSkillName(name);
  validateSkillContent(sanitized, content);
  requireAgentSkillWorkspace(agentId);
  await writeAgentSkillFile(agentId, sanitized, 'SKILL.md', content);
  return sanitized;
}

/**
 * Upsert one reference file for a skill.
 * @param {string} name
 * @param {string} referenceName
 * @param {string} content
 * @param {string} [agentId]
 */
export async function writeSkillReference(name, referenceName, content, agentId) {
  const skillName = normalizeSkillName(name);
  const refName = normalizeReferenceName(referenceName);
  const safeContent = truncateText(String(content || ''), MAX_SKILL_REFERENCE_CHARS);
  if (!safeContent.trim()) throw new Error('Reference content is required.');
  requireAgentSkillWorkspace(agentId);
  await ensureAgentSkillExists(agentId, skillName);
  await writeAgentSkillRef(agentId, skillName, refName, safeContent);
  return refName;
}

async function getDisabledSkills() {
  const disabled = config.get('skills.disabled') || [];
  return new Set(disabled);
}

export async function setSkillEnabled(name, enabled) {
  const skillName = normalizeSkillName(name);
  const disabledSet = await getDisabledSkills();
  if (enabled) disabledSet.delete(skillName);
  else disabledSet.add(skillName);
  await config.set('skills.disabled', Array.from(disabledSet).sort());
}

export async function isSkillEnabled(name) {
  return !(await getDisabledSkills()).has(normalizeSkillName(name));
}

export async function listAllSkills(includeDisabled = true, agentId, options = {}) {
  const skills = await listSkills(agentId, options);
  const disabledSet = await getDisabledSkills();
  return skills
    .filter((skill) => includeDisabled || !disabledSet.has(skill.name))
    .map((skill) => ({
      ...skill,
      enabled: !disabledSet.has(skill.name),
    }));
}

/**
 * Build the prompt catalog for enabled skills.
 * @param {string} [agentId]
 */
export async function buildSkillsSection(agentId, options = {}) {
  const skills = await listEnabledSkills(agentId, {
    agentUrl: options.agentUrl,
    signal: options.signal,
    runtimeCatalogTimeoutMs: options.runtimeCatalogTimeoutMs,
  });
  if (!skills.length) return '';

  const list = skills
    .map((skill) => {
      const refs = skill.references?.length
        ? ` refs=[${skill.references.map((ref) => ref.name).join(', ')}]`
        : '';
      return `- ${skill.name}: ${skill.description}${refs}`;
    })
    .join('\n');

  const location = options.runtimeMode === 'sandbox'
    ? 'OPFS global and workspace skills are synchronized into the sandbox under skills/<skill-name>/ without replacing an existing sandbox skill. The `skill` tool reads and writes only this sandbox skills directory.'
    : 'Available skills are loaded in this order: OPFS global skills, active OPFS workspace skills, then selected agent skills. Later sources override earlier same-named skills. Use the `skill` tool with action "read" before applying detailed instructions. Its "write" action always creates or edits a skill in the active OPFS workspace.';

  return [
    '<skill_catalog>',
    location,
    list,
    '</skill_catalog>',
  ].join('\n');
}

/**
 * Snapshot enabled OPFS-owned skills for a sandbox runtime. Workspace skills
 * retain their normal precedence over global skills. Skills already in the
 * sandbox are intentionally not part of this snapshot.
 * @param {string} [agentId]
 * @param {{ signal?: AbortSignal|null }} [options]
 * @returns {Promise<Array<{ path: string, content: string }>>}
 */
export async function buildSandboxSkillFiles(agentId, options = {}) {
  throwIfSkillAborted(options.signal);
  const files = [];
  for (const skill of await listEnabledSkills(agentId)) {
    throwIfSkillAborted(options.signal);
    const resolved = await resolveSkill(skill.name, agentId);
    throwIfSkillAborted(options.signal);
    if (!resolved) continue;
    files.push({ path: `skills/${skill.name}/SKILL.md`, content: resolved.content });
    for (const ref of resolved.skill.references) {
      throwIfSkillAborted(options.signal);
      const content = await readReference(resolved, ref.name);
      throwIfSkillAborted(options.signal);
      if (content != null) {
        files.push({ path: `skills/${skill.name}/references/${ref.name}`, content });
      }
    }
  }
  return files;
}

// ─── Internal loading ───────────────────────────────────────────────────────

async function listEnabledSkills(agentId, options = {}) {
  const disabledSet = await getDisabledSkills();
  return (await listSkills(agentId, options)).filter((skill) => !disabledSet.has(skill.name));
}

async function listSkillsFromGlobal() {
  const dirs = await listSkillDirs();
  const skills = [];
  for (const dir of dirs) {
    const content = await readSkillFile(dir.name, 'SKILL.md');
    if (!content) continue;
    const meta = parseFrontmatter(content);
    const refs = await listSkillRefs(dir.name);
    skills.push(buildSkillRecord({
      dirName: dir.name,
      source: 'global',
      meta,
      refs,
    }));
  }
  return skills;
}

async function listSkillsFromWorkspace(agentId) {
  const dirs = await listAgentSkillDirs(agentId);
  const skills = [];
  for (const dir of dirs) {
    const content = await readAgentSkillFile(agentId, dir.name, 'SKILL.md');
    if (!content) continue;
    const meta = parseFrontmatter(content);
    const refs = await listAgentSkillRefs(agentId, dir.name);
    skills.push(buildSkillRecord({
      dirName: dir.name,
      source: 'workspace',
      meta,
      refs,
    }));
  }
  return skills;
}

async function listSkillsFromRuntimeAgent(agentUrl, options = {}) {
  const deadline = createRuntimeCatalogDeadline(
    options.signal,
    options.runtimeCatalogTimeoutMs
  );
  try {
    return await loadSkillsFromRuntimeAgent(agentUrl, {
      ...options,
      signal: deadline.signal,
    });
  } catch (error) {
    // A catalog timeout should not prevent the run from starting with its
    // browser-owned skills. Explicit caller cancellation must still stop it.
    rethrowIfAborted(error, options.signal);
    return [];
  } finally {
    deadline.dispose();
  }
}

async function loadSkillsFromRuntimeAgent(agentUrl, options = {}) {
  const requestOptions = options.signal ? { signal: options.signal } : {};
  let dirs;
  try {
    dirs = directoryEntries(await listFiles('skills', agentUrl, requestOptions))
      .filter((entry) => entry.type === 'directory');
  } catch (error) {
    rethrowIfAborted(error, options.signal);
    return [];
  }

  // Load runtime skills concurrently so one unreachable skill directory does
  // not multiply the per-request deadline across the whole catalog.
  const skills = await Promise.all(dirs.map(async (dir) => {
    const skillName = safeDirectorySkillName(dir.name);
    if (!skillName) return null;
    try {
      const [content, skillEntries] = await Promise.all([
        readFileText(`skills/${skillName}/SKILL.md`, agentUrl, requestOptions),
        listFiles(`skills/${skillName}`, agentUrl, requestOptions),
      ]);
      if (!content) return null;
      const refs = await listRuntimeAgentSkillRefs(
        agentUrl,
        skillName,
        directoryEntries(skillEntries),
        options
      );
      return buildSkillRecord({
        dirName: skillName,
        source: 'agent',
        meta: parseFrontmatter(content),
        refs,
      });
    } catch (error) {
      rethrowIfAborted(error, options.signal);
      // A partially written or concurrently removed agent skill is skipped.
      return null;
    }
  }));
  return skills.filter(Boolean);
}

async function listRuntimeAgentSkillRefs(agentUrl, skillName, skillEntries, options = {}) {
  const requestOptions = options.signal ? { signal: options.signal } : {};
  let entries = skillEntries;
  if (!Array.isArray(entries)) {
    try {
      entries = directoryEntries(await listFiles(`skills/${skillName}`, agentUrl, requestOptions));
    } catch (error) {
      rethrowIfAborted(error, options.signal);
      return [];
    }
  }
  const hasReferencesDirectory = entries.some((entry) => (
    entry.type === 'directory' && entry.name === 'references'
  ));
  if (!hasReferencesDirectory) return [];
  try {
    return directoryEntries(await listFiles(
      `skills/${skillName}/references`,
      agentUrl,
      requestOptions
    ))
      .filter((entry) => entry.type !== 'directory')
      .map((entry) => ({ name: entry.name }));
  } catch (error) {
    rethrowIfAborted(error, options.signal);
    return [];
  }
}

function rethrowIfAborted(error, signal) {
  if (signal?.aborted) throw signal.reason || error;
}

function throwIfSkillAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason || new DOMException('Aborted', 'AbortError');
}

function createRuntimeCatalogDeadline(parentSignal, requestedTimeoutMs) {
  const parsedTimeoutMs = Number(requestedTimeoutMs);
  const timeoutMs = Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0
    ? Math.floor(parsedTimeoutMs)
    : RUNTIME_SKILL_CATALOG_TIMEOUT_MS;
  const controller = new AbortController();
  const relayAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) relayAbort();
  else parentSignal?.addEventListener('abort', relayAbort, { once: true });
  const timerId = setTimeout(() => {
    const error = new Error(`Runtime skill catalog timed out after ${timeoutMs} ms.`);
    error.name = 'TimeoutError';
    error.code = 'RUNTIME_SKILL_CATALOG_TIMEOUT';
    controller.abort(error);
  }, timeoutMs);

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timerId);
      parentSignal?.removeEventListener('abort', relayAbort);
    },
  };
}

function directoryEntries(listing) {
  if (Array.isArray(listing)) return listing;
  return Array.isArray(listing?.children) ? listing.children : [];
}

async function resolveSkill(name, agentId, options = {}) {
  const skillName = normalizeSkillName(name);
  if (options.agentUrl) {
    const requestOptions = options.signal ? { signal: options.signal } : {};
    try {
      const agentContent = await readFileText(
        `skills/${skillName}/SKILL.md`,
        options.agentUrl,
        requestOptions
      );
      if (agentContent) {
        const refs = await listRuntimeAgentSkillRefs(
          options.agentUrl,
          skillName,
          undefined,
          options
        );
        return {
          content: agentContent,
          source: 'agent',
          agentUrl: options.agentUrl,
          signal: options.signal,
          skill: buildSkillRecord({
            dirName: skillName,
            source: 'agent',
            meta: parseFrontmatter(agentContent),
            refs,
          }),
        };
      }
    } catch (error) {
      rethrowIfAborted(error, options.signal);
      // Fall through to the OPFS workspace/global sources.
    }
  }

  if (agentId) {
    const workspaceContent = await readAgentSkillFile(agentId, skillName, 'SKILL.md');
    if (workspaceContent) {
      const refs = await listAgentSkillRefs(agentId, skillName);
      return {
        content: workspaceContent,
        source: 'workspace',
        agentId,
        skill: buildSkillRecord({
          dirName: skillName,
          source: 'workspace',
          meta: parseFrontmatter(workspaceContent),
          refs,
        }),
      };
    }
  }

  const content = await readSkillFile(skillName, 'SKILL.md');
  if (!content) return null;
  const refs = await listSkillRefs(skillName);
  return {
    content,
    source: 'global',
    skill: buildSkillRecord({
      dirName: skillName,
      source: 'global',
      meta: parseFrontmatter(content),
      refs,
    }),
  };
}

async function readReference(resolved, referenceName) {
  const safeName = normalizeReferenceName(referenceName);
  if (resolved.source === 'agent') {
    try {
      return await readFileText(
        `skills/${resolved.skill.name}/references/${safeName}`,
        resolved.agentUrl,
        resolved.signal ? { signal: resolved.signal } : {}
      );
    } catch (error) {
      rethrowIfAborted(error, resolved.signal);
      return null;
    }
  }
  if (resolved.source === 'workspace') {
    return readAgentSkillRef(resolved.agentId, resolved.skill.name, safeName);
  }
  return readSkillRef(resolved.skill.name, safeName);
}

function requireAgentSkillWorkspace(agentId) {
  if (!agentId) {
    throw new Error('Skill modifications require an active agent workspace. Global skills are read-only to AI tools.');
  }
}

async function ensureAgentSkillExists(agentId, skillName) {
  const agentContent = await readAgentSkillFile(agentId, skillName, 'SKILL.md');
  if (agentContent) return;

  const globalContent = await readSkillFile(skillName, 'SKILL.md');
  if (!globalContent) {
    throw new Error(`Skill "${skillName}" does not exist. Upsert SKILL.md before writing references.`);
  }
  await writeAgentSkillFile(agentId, skillName, 'SKILL.md', globalContent);
  for (const ref of await listSkillRefs(skillName)) {
    const content = await readSkillRef(skillName, ref.name);
    if (content != null) await writeAgentSkillRef(agentId, skillName, ref.name, content);
  }
}

function buildSkillRecord({ dirName, source, meta, refs }) {
  const name = normalizeSkillName(meta.name || dirName);
  return {
    name,
    description: String(meta.description || 'No description provided').trim(),
    version: String(meta.version || '1.0.0').trim(),
    source,
    references: (refs || []).map((ref) => ({ name: ref.name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
