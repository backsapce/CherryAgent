/**
 * Skills are progressive instructions stored as Markdown.
 *
 * Tier 1: the system prompt gets a compact catalog.
 * Tier 2: the `skill` tool reads one SKILL.md when it is relevant.
 * Tier 3: references are read by name instead of dumping every file.
 */

import yaml from 'js-yaml';
import {
  listSkillDirs,
  readSkillFile,
  writeSkillFile,
  listSkillRefs,
  readSkillRef,
  listAgentSkillDirs,
  readAgentSkillFile,
  writeAgentSkillFile,
  deleteAgentSkillDir,
  listAgentSkillRefs,
  readAgentSkillRef,
  writeAgentSkillRef,
} from '../vfs/opfs.js';
import config from '../config/config.js';

const MAX_SKILL_CONTENT_CHARS = 60_000;
const MAX_REFERENCE_CHARS = 80_000;

const DEFAULT_SKILLS = [
  {
    name: 'skill-creator',
    content: `---
name: skill-creator
description: Use when creating or improving VertexAgent skills. Helps write concise trigger descriptions, progressive instructions, and optional reference files.
version: 2.0.0
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
5. Create or update the skill by writing files under workspace/<active-agent>/skills/: write <skill-name>/SKILL.md for the skill and <skill-name>/references/<file> for optional references.
`,
  },
];

// ─── Public API ─────────────────────────────────────────────────────────────

export async function ensureDefaultSkills() {
  const existing = await listSkillDirs();
  const existingNames = new Set(existing.map((dir) => dir.name));
  for (const skill of DEFAULT_SKILLS) {
    const existingContent = existingNames.has(skill.name)
      ? await readSkillFile(skill.name, 'SKILL.md')
      : null;
    if (!existingContent || existingContent.includes('Use the skill tool to upsert the SKILL.md')) {
      await writeSkillFile(skill.name, 'SKILL.md', skill.content);
    }
  }
}

/**
 * List all skills. Agent-local skills override global skills with the same name.
 * @param {string} [agentId]
 */
export async function listSkills(agentId) {
  await ensureDefaultSkills();
  const merged = new Map();
  for (const skill of await listSkillsFromGlobal()) {
    merged.set(skill.name, skill);
  }
  if (agentId) {
    for (const skill of await listSkillsFromAgent(agentId)) {
      merged.set(skill.name, skill);
    }
  }
  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Search skills by query.
 * @param {string} query
 * @param {string} [agentId]
 */
export async function searchSkills(query, agentId) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const skills = await listEnabledSkills(agentId);
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
 * @param {{ includeReferences?: boolean, referenceName?: string }} [options]
 */
export async function getSkill(name, agentId, options = {}) {
  const resolved = await resolveSkill(name, agentId);
  if (!resolved) return null;

  if (options.referenceName) {
    const content = await readReference(resolved, options.referenceName);
    if (content == null) return null;
    return {
      ...resolved.skill,
      content: formatReferenceContent(resolved.skill.name, options.referenceName, content),
      referenceName: options.referenceName,
    };
  }

  let content = truncateText(resolved.content, MAX_SKILL_CONTENT_CHARS);
  if (resolved.skill.references.length > 0) {
    content += `\n\n## Available References\n${resolved.skill.references.map((ref) => `- ${ref.name}`).join('\n')}`;
  }

  if (options.includeReferences) {
    const refs = [];
    for (const ref of resolved.skill.references) {
      const refContent = await readReference(resolved, ref.name);
      if (refContent != null) refs.push({ name: ref.name, content: truncateText(refContent, MAX_REFERENCE_CHARS) });
    }
    if (refs.length) {
      content += '\n\n## Reference Files\n';
      for (const ref of refs) {
        content += `\n### ${ref.name}\n${ref.content}\n`;
      }
    }
  }

  return {
    ...resolved.skill,
    content,
  };
}

/**
 * Create a skill.
 * @param {string} name
 * @param {string} content
 * @param {string} [agentId]
 */
export async function createSkill(name, content, agentId) {
  const sanitized = normalizeSkillName(name);
  validateSkillContent(sanitized, content);
  requireAgentSkillWorkspace(agentId);
  await writeAgentSkillFile(agentId, sanitized, 'SKILL.md', content);
  return sanitized;
}

/**
 * Update a skill.
 * @param {string} name
 * @param {string} content
 * @param {string} [agentId]
 */
export async function updateSkill(name, content, agentId) {
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
  const safeContent = truncateText(String(content || ''), MAX_REFERENCE_CHARS);
  if (!safeContent.trim()) throw new Error('Reference content is required.');
  requireAgentSkillWorkspace(agentId);
  await ensureAgentSkillExists(agentId, skillName);
  await writeAgentSkillRef(agentId, skillName, refName, safeContent);
  return refName;
}

/**
 * Delete a skill.
 * @param {string} name
 * @param {string} [agentId]
 */
export async function deleteSkill(name, agentId) {
  const sanitized = normalizeSkillName(name);
  requireAgentSkillWorkspace(agentId);
  await deleteAgentSkillDir(agentId, sanitized);
}

export async function getDisabledSkills() {
  const disabled = config.get('skills.disabled') || [];
  return new Set(disabled);
}

export async function setSkillEnabled(name, enabled) {
  const disabledSet = await getDisabledSkills();
  if (enabled) disabledSet.delete(name);
  else disabledSet.add(name);
  await config.set('skills.disabled', Array.from(disabledSet).sort());
}

export async function isSkillEnabled(name) {
  return !(await getDisabledSkills()).has(name);
}

export async function listAllSkills(includeDisabled = true, agentId) {
  const skills = await listSkills(agentId);
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
export async function buildSkillsSection(agentId) {
  const skills = await listEnabledSkills(agentId);
  if (!skills.length) return '';

  const list = skills
    .map((skill) => {
      const refs = skill.references?.length
        ? ` refs=[${skill.references.map((ref) => ref.name).join(', ')}]`
        : '';
      return `- ${skill.name}: ${skill.description}${refs}`;
    })
    .join('\n');

  return [
    '<skill_catalog>',
    'Available skills are listed below. Skills are stored in browser OPFS, not in the sandbox runtime and not inside workspace/<active-agent>/files/. Global skills are read-only to AI tools. Use the `skill` tool with action "read" before applying detailed skill instructions; create or edit active-agent skills only by writing files under workspace/<active-agent>/skills/.',
    list,
    '</skill_catalog>',
  ].join('\n');
}

// ─── Internal loading ───────────────────────────────────────────────────────

async function listEnabledSkills(agentId) {
  const disabledSet = await getDisabledSkills();
  return (await listSkills(agentId)).filter((skill) => !disabledSet.has(skill.name));
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
      content,
      meta,
      refs,
    }));
  }
  return skills;
}

async function listSkillsFromAgent(agentId) {
  const dirs = await listAgentSkillDirs(agentId);
  const skills = [];
  for (const dir of dirs) {
    const content = await readAgentSkillFile(agentId, dir.name, 'SKILL.md');
    if (!content) continue;
    const meta = parseFrontmatter(content);
    const refs = await listAgentSkillRefs(agentId, dir.name);
    skills.push(buildSkillRecord({
      dirName: dir.name,
      source: 'agent',
      content,
      meta,
      refs,
    }));
  }
  return skills;
}

async function resolveSkill(name, agentId) {
  const skillName = normalizeSkillName(name);
  if (agentId) {
    const agentContent = await readAgentSkillFile(agentId, skillName, 'SKILL.md');
    if (agentContent) {
      const refs = await listAgentSkillRefs(agentId, skillName);
      return {
        content: agentContent,
        source: 'agent',
        agentId,
        skill: buildSkillRecord({
          dirName: skillName,
          source: 'agent',
          content: agentContent,
          meta: parseFrontmatter(agentContent),
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
      content,
      meta: parseFrontmatter(content),
      refs,
    }),
  };
}

async function readReference(resolved, referenceName) {
  const safeName = normalizeReferenceName(referenceName);
  if (resolved.source === 'agent') {
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

function buildSkillRecord({ dirName, source, content, meta, refs }) {
  const name = normalizeSkillName(meta.name || dirName);
  return {
    name,
    description: String(meta.description || 'No description provided').trim(),
    version: String(meta.version || '1.0.0').trim(),
    source,
    references: (refs || []).map((ref) => ({ name: ref.name })).sort((a, b) => a.name.localeCompare(b.name)),
    contentLength: content.length,
  };
}

// ─── Frontmatter and validation ─────────────────────────────────────────────

function parseFrontmatter(content) {
  const match = String(content || '').match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  try {
    const parsed = yaml.load(match[1]);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return parseSimpleFrontmatter(match[1]);
  }
}

function parseSimpleFrontmatter(frontmatter) {
  const result = {};
  for (const line of frontmatter.split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = value;
  }
  return result;
}

function validateSkillContent(name, content) {
  const text = String(content || '').trim();
  if (!text) throw new Error('Skill content is required.');
  if (text.length > MAX_SKILL_CONTENT_CHARS) {
    throw new Error(`Skill content is too large (${text.length}/${MAX_SKILL_CONTENT_CHARS} chars). Move details into references.`);
  }
  const meta = parseFrontmatter(text);
  if (!meta.name || !meta.description) {
    throw new Error('Skill content must include YAML frontmatter with name and description.');
  }
  if (normalizeSkillName(meta.name) !== name) {
    throw new Error(`Skill frontmatter name "${meta.name}" must match "${name}".`);
  }
}

function normalizeSkillName(name) {
  const normalized = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error('Skill name is required.');
  return normalized.slice(0, 80);
}

function normalizeReferenceName(name) {
  const normalized = String(name || '')
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('/');
  if (!normalized || normalized.includes('..')) throw new Error('Reference name is invalid.');
  return normalized.slice(0, 160);
}

function scoreSkill(skill, terms) {
  const haystack = `${skill.name} ${skill.description} ${skill.references?.map((ref) => ref.name).join(' ')}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (skill.name.toLowerCase() === term) score += 8;
    if (skill.name.toLowerCase().includes(term)) score += 4;
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

function formatReferenceContent(skillName, referenceName, content) {
  return [
    `# Reference: ${skillName}/${referenceName}`,
    '',
    truncateText(content, MAX_REFERENCE_CHARS),
  ].join('\n');
}

function truncateText(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}
