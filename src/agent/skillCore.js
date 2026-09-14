/**
 * Pure skill parsing, validation, and formatting shared by the browser skill
 * store (skills.js), the tool registry (tools.js), and the sandbox runtime
 * (server/agent-runtime.js). No OPFS or Node imports allowed here.
 */

import yaml from 'js-yaml';
import { truncateText } from '../utils/misc.js';

const MAX_SKILL_CONTENT_CHARS = 60_000;
const MAX_SKILL_REFERENCE_CHARS = 80_000;

export function normalizeSkillName(name) {
  const normalized = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error('Skill name is required.');
  return normalized.slice(0, 80);
}

export function normalizeReferenceName(name) {
  const normalized = String(name || '')
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('/');
  if (!normalized || normalized.includes('..')) throw new Error('Reference name is invalid.');
  return normalized.slice(0, 160);
}

/** A directory name is safe to use as-is only when normalization keeps it identical. */
export function safeDirectorySkillName(name) {
  try {
    const normalized = normalizeSkillName(name);
    return normalized === name ? normalized : null;
  } catch {
    return null;
  }
}

export function parseFrontmatter(content) {
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

export function validateSkillContent(name, content) {
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

export function scoreSkill(skill, terms) {
  const haystack = `${skill.name} ${skill.description} ${skill.references?.map((ref) => ref.name).join(' ')}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (skill.name.toLowerCase() === term) score += 8;
    if (skill.name.toLowerCase().includes(term)) score += 4;
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

/** Format the Tier 1 catalog lines for the system prompt / skill list output. */
export function formatSkills(skills) {
  if (!skills?.length) return 'No skills found.';
  return skills
    .map((skill) => {
      const refs = skill.references?.length
        ? ` refs=[${skill.references.map((ref) => ref.name).join(', ')}]`
        : '';
      return `- ${skill.name} (${skill.source}, v${skill.version}): ${skill.description}${refs}`;
    })
    .join('\n');
}

export function formatReferenceContent(skillName, referenceName, content) {
  return [
    `# Reference: ${skillName}/${referenceName}`,
    '',
    truncateText(content, MAX_SKILL_REFERENCE_CHARS),
  ].join('\n');
}

export { MAX_SKILL_CONTENT_CHARS, MAX_SKILL_REFERENCE_CHARS, truncateText };
