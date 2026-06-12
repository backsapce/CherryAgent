/**
 * Agent Management — multi-agent workspace system.
 *
 * Each agent has its own isolated workspace in OPFS:
 *   vertex-agent/workspace/agent-xxxxxx/
 *     meta.json     — { id, name, createdAt }
 *     AGENTS.md     — agent identity: whoami, capabilities, workspace context
 *     memory/       — MEMORY.md, USER.md
 *     skills/       — agent-specific skills
 *     files/        — agent-scoped files for tool execution
 *
 * Global skills (vertex-agent/skills/) are shared across all agents.
 * Sessions and messages remain global.
 *
 * Usage:
 *   import { ensureDefaultAgent, listAgents, createAgent, getWorkspaceDir } from './agents/agents';
 */

import config from '../config/config.js';
import { notifyOpfsMutation, writeAgentAgentsFile, readAgentAgentsFile } from '../vfs/opfs.js';

const ROOT_DIR = 'vertex-agent';
const WORKSPACE_DIR = 'workspace';

function normalizeAgent(agent) {
  return {
    id: agent.id,
    name: agent.name || agent.id,
    createdAt: agent.createdAt || new Date().toISOString(),
    updatedAtMs: Number.isFinite(agent.updatedAtMs) ? agent.updatedAtMs : null,
    llmProfileId: agent.llmProfileId || null,
    sandboxUrl: agent.sandboxUrl || null,
  };
}

function touchAgent(agent, patch = {}) {
  return normalizeAgent({
    ...agent,
    ...patch,
    updatedAtMs: Date.now(),
  });
}

// ─── OPFS helpers ─────────────────────────────────────────────────────────────

async function getRootDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ROOT_DIR, { create: true });
}

async function getDirectory(...pathParts) {
  let dir = await getRootDir();
  for (const part of pathParts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
}

async function readJSON(dirHandle, filename) {
  try {
    const fh = await dirHandle.getFileHandle(filename);
    const file = await fh.getFile();
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}

async function writeJSON(dirHandle, filename, data) {
  const fh = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fh.createWritable();
  await writable.write(JSON.stringify(data, null, 2));
  await writable.close();
}

async function writeWorkspaceJSON(agentId, filename, data) {
  const wsDir = await getWorkspaceDir(agentId);
  await writeJSON(wsDir, filename, data);
  notifyOpfsMutation(`${WORKSPACE_DIR}/${agentId}/${filename}`, 'write');
}

/**
 * Get the workspace directory name for a given agent ID.
 * Uses the stable agent ID as the directory name (not the display name).
 * @param {string} agentId
 * @returns {Promise<string>}
 */
export async function getWorkspaceDirName(agentId) {
  return agentId;
}

// ─── ID generation ────────────────────────────────────────────────────────────

/** Generate a random 6-char alphanumeric ID. */
export function generateAgentId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return `agent-${out}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensure at least one default agent exists. Creates one on first startup.
 * @returns {Promise<string>} The default agent ID
 */
export async function ensureDefaultAgent() {
  while (!config.initialized) await new Promise((r) => setTimeout(r, 50));

  const agents = (config.get('agentsList') || []).map(normalizeAgent);
  if (agents.length > 0) {
    // Agent already exists — ensure its workspace and AGENTS.md exist too (for upgrades)
    await ensureAgentWorkspace(agents[0].id, agents[0].name);
    await config.set('agentsList', agents);
    return agents[0].id;
  }

  const id = generateAgentId();
  const agent = touchAgent({ id, name: id, createdAt: new Date().toISOString() });
  await config.set('agentsList', [agent]);

  await ensureAgentWorkspace(id, id);
  await writeWorkspaceJSON(id, 'meta.json', agent);

  return id;
}

/**
 * List all agents.
 * @returns {Promise<Array<{ id: string, name: string, createdAt: string }>>}
 */
export async function listAgents() {
  while (!config.initialized) await new Promise((r) => setTimeout(r, 50));
  return (config.get('agentsList') || []).map(normalizeAgent);
}

/**
 * Get a single agent by ID.
 * @param {string} id
 * @returns {Promise<{ id: string, name: string, createdAt: string }|null>}
 */
export async function getAgent(id) {
  const agents = await listAgents();
  return agents.find((a) => a.id === id) || null;
}

/**
 * Create a new agent with workspace.
 * @param {string} [name] — optional display name (defaults to agent-xxxxxx)
 * @returns {Promise<{ id: string, name: string, createdAt: string }>}
 */
export async function createAgent(name) {
  const id = generateAgentId();
  const agentName = name || id;
  const agent = touchAgent({ id, name: agentName, createdAt: new Date().toISOString() });

  const agents = await listAgents();
  agents.push(agent);
  await config.set('agentsList', agents);

  await ensureAgentWorkspace(id, agentName);
  await writeWorkspaceJSON(id, 'meta.json', agent);

  return agent;
}

/**
 * Delete an agent and its workspace.
 * @param {string} id
 */
export async function deleteAgent(id) {
  const agents = await listAgents();
  const remaining = agents.filter((a) => a.id !== id);
  await config.set('agentsList', remaining);

  // Remove workspace directory
  try {
    const root = await getRootDir();
    const wsDir = await root.getDirectoryHandle(WORKSPACE_DIR);
    await wsDir.removeEntry(id, { recursive: true });
    notifyOpfsMutation(`${WORKSPACE_DIR}/${id}`, 'delete');
  } catch {
    // workspace may not exist
    notifyOpfsMutation(`${WORKSPACE_DIR}/${id}`, 'delete');
  }
}

/**
 * Update an agent's display name.
 * Workspace directory uses stable agent ID, so no rename needed.
 * @param {string} id
 * @param {string} name
 */
export async function updateAgentName(id, name) {
  const agents = await listAgents();
  const updated = agents.map((a) => (a.id === id ? touchAgent(a, { name }) : a));
  await config.set('agentsList', updated);

  // Update meta.json with new name
  try {
    const wsDir = await getWorkspaceDir(id);
    const existing = await readJSON(wsDir, 'meta.json');
    if (existing) {
      await writeWorkspaceJSON(id, 'meta.json', touchAgent(existing, { name }));
    }
  } catch {
    // workspace may not exist yet
  }

  // Update AGENTS.md with new name
  try {
    const agentsContent = await readAgentAgentsFile(id);
    if (agentsContent) {
      const updatedContent = agentsContent
        .replace(/^name:.*$/m, `name: ${name}`)
        .replace(/^# Agent:.*$/m, `# Agent: ${name}`)
        .replace(/\*\*Name:\*\*.*$/m, `**Name:** ${name}`);
      await writeAgentAgentsFile(id, updatedContent);
    }
  } catch {
    // AGENTS.md may not exist yet
  }
}

/**
 * Update an agent's runtime defaults.
 * @param {string} id
 * @param {{ llmProfileId?: string|null, sandboxUrl?: string|null }} patch
 */
export async function updateAgentConfig(id, patch) {
  const agents = await listAgents();
  const updated = agents.map((a) => (
    a.id === id
      ? touchAgent({
          ...a,
          ...patch,
          llmProfileId: Object.prototype.hasOwnProperty.call(patch, 'llmProfileId')
            ? (patch.llmProfileId || null)
            : a.llmProfileId,
          sandboxUrl: Object.prototype.hasOwnProperty.call(patch, 'sandboxUrl')
            ? (patch.sandboxUrl || null)
            : a.sandboxUrl,
        })
      : a
  ));
  await config.set('agentsList', updated);

  try {
    const wsDir = await getWorkspaceDir(id);
    const existing = await readJSON(wsDir, 'meta.json');
    if (existing) {
      await writeWorkspaceJSON(id, 'meta.json', touchAgent(existing, patch));
    }
  } catch {
    // workspace may not exist yet
  }
}

/**
 * Get the OPFS directory handle for an agent's workspace root.
 * Uses the stable agent ID as the directory name.
 * @param {string} agentId
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function getWorkspaceDir(agentId) {
  const dirName = await getWorkspaceDirName(agentId);
  return getDirectory(WORKSPACE_DIR, dirName);
}

/**
 * Generate default AGENTS.md content for an agent.
 * @param {string} agentId
 * @param {string} name
 * @returns {string}
 */
function defaultAgentsMd(agentId, name) {
  return `---
name: ${name}
id: ${agentId}
created: ${new Date().toISOString()}
---

# Agent: ${name}

You are an AI agent in the VertexAgent system.

## Identity

- **Name:** ${name}
- **ID:** ${agentId}

## Capabilities

You can execute commands, read/write files, manage directories, maintain memory notes, and use skills. Work autonomously to assist the user with their tasks.

## Workspace

Your durable state is stored in browser OPFS, but file tools only access your own files area: workspace/${agentId}/files/.

Browser file tools cannot access OPFS root, other agents, AGENTS.md, memory, or skills by path. Use memory and skill tools for those systems.

If a sandbox is selected, it is a separate runtime filesystem used by shell commands. Your browser files area and sandbox files do not automatically sync. Use browser file tools for persistent files in your own files area, and sandbox file tools for files inside the command runtime.

## Memory

Maintain notes about the user and your work in memory files. Use memory tools to persist important context across sessions.
`;
}

/**
 * Ensure an agent's workspace directories exist.
 * Uses the stable agent ID as the directory name.
 * @param {string} agentId
 * @param {string} [name] — optional display name for AGENTS.md
 */
export async function ensureAgentWorkspace(agentId, name) {
  const dirName = await getWorkspaceDirName(agentId);
  await getDirectory(WORKSPACE_DIR, dirName, 'memory');
  await getDirectory(WORKSPACE_DIR, dirName, 'skills');
  await getDirectory(WORKSPACE_DIR, dirName, 'files');

  // Create default AGENTS.md if it doesn't exist yet
  const existing = await readAgentAgentsFile(agentId);
  if (!existing) {
    await writeAgentAgentsFile(agentId, defaultAgentsMd(agentId, name || dirName));
  }
}
