/**
 * Tool Registry — central hub for all agent tools.
 *
 * Inspired by Hermes Agent's ToolRegistry pattern.
 * Each tool has a name, JSON schema (OpenAI function-calling format), and an async handler.
 *
 * Usage:
 *   import { registry } from './agent/tools';
 *   registry.register({ name: 'my_tool', schema, handler });
 *   const result = await registry.dispatch('my_tool', { arg: 'value' }, agentContext);
 */

import {
  clearMemory,
  deleteMemoryEntry,
  listMemoryEntries,
  upsertMemoryEntry,
} from './memory.js';
import {
  getSkill,
  searchSkills,
} from './skills.js';
import {
  E2B_AGENT_ID,
  executeCommand,
  getCommand,
  listFiles,
  readFileText,
  startCommand,
  stopCommand,
  waitCommand,
  writeFile,
} from '../models/agent.js';
import {
  getAgentFileInfo,
  getAgentSkillFileInfo,
  listAgentFiles,
  listAgentSkillFiles,
  readAgentFile,
  readAgentSkillPath,
  writeAgentFile,
  writeAgentSkillPath,
} from '../vfs/opfs.js';
import config from '../config/config.js';
import { getAgent, listAgents } from '../agents/agents.js';

const DEFAULT_READ_FILE_MAX_BYTES = 256 * 1024;
const ABSOLUTE_READ_FILE_MAX_BYTES = 1024 * 1024;
const ABSOLUTE_IMAGE_MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const TOOL_RESULT_MAX_CHARS = 80_000;
const TOOL_RESULT_HEAD_RATIO = 0.62;

// ─── Registry singleton ─────────────────────────────────────────────────────

const _tools = new Map();

export const registry = {
  /** Register a tool. */
  register(tool) {
    _tools.set(tool.name, {
      category: 'general',
      readOnly: false,
      parallelSafe: false,
      ...tool,
    });
  },

  /** Get a tool by name. */
  get(name) {
    return _tools.get(name) || null;
  },

  /** Get all registered tools as an array. */
  getAll() {
    return Array.from(_tools.values());
  },

  /** Get tool schemas for LLM request (OpenAI function-calling format). */
  getSchemas() {
    return Array.from(_tools.values()).map((t) => ({
      name: t.name,
      description: t.schema.description,
      parameters: t.schema.parameters,
    }));
  },

  /** Dispatch a tool call by name with arguments. */
  async dispatch(name, args, context) {
    const tool = _tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    if (!isToolEnabled(name)) {
      throw new Error(`Tool disabled: ${name}`);
    }
    if (tool.checkAvailable && !tool.checkAvailable(context)) {
      throw new Error(`Tool not available: ${name}`);
    }
    const validation = validateToolArgs(tool, args);
    if (!validation.ok) {
      throw new Error(`Invalid arguments for ${name}: ${validation.message}`);
    }
    const result = await tool.handler(validation.args, context);
    return capToolResult(result);
  },

  /** Whether a tool can safely run concurrently with other parallel-safe calls. */
  canRunInParallel(name) {
    return _tools.get(name)?.parallelSafe === true;
  },

  /** Check if any tools are registered. */
  hasTools() {
    return _tools.size > 0;
  },
};

// ─── Tool enablement ───────────────────────────────────────────────────────

export function getDisabledTools() {
  const disabled = config.get('tools.disabled') || [];
  return new Set(disabled);
}

export async function setToolEnabled(name, enabled) {
  const disabledSet = getDisabledTools();
  if (enabled) {
    disabledSet.delete(name);
  } else {
    disabledSet.add(name);
  }
  await config.set('tools.disabled', Array.from(disabledSet));
}

export function isToolEnabled(name) {
  return !getDisabledTools().has(name);
}

export function listAllTools() {
  const disabledSet = getDisabledTools();
  return registry.getAll().map((tool) => ({
    name: tool.name,
    description: tool.schema.description,
    category: tool.category,
    readOnly: tool.readOnly,
    enabled: !disabledSet.has(tool.name),
  }));
}

export function getEnabledToolSchemas(context = {}) {
  const disabledSet = getDisabledTools();
  return registry
    .getAll()
    .filter((tool) => !disabledSet.has(tool.name))
    .filter((tool) => !tool.checkAvailable || tool.checkAvailable(context))
    .map((tool) => ({
      name: tool.name,
      description: tool.schema.description,
      parameters: tool.schema.parameters,
    }));
}

function validateToolArgs(tool, args) {
  const schema = tool.schema?.parameters || {};
  const value = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  if (value._raw) {
    return { ok: false, message: 'arguments were not valid JSON' };
  }

  const properties = schema.properties || {};
  const required = schema.required || [];
  for (const name of required) {
    if (value[name] === undefined || value[name] === null) {
      return { ok: false, message: `missing required property "${name}"` };
    }
  }

  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(properties));
    for (const name of Object.keys(value)) {
      if (!allowed.has(name)) {
        delete value[name];
      }
    }
  }

  for (const [name, prop] of Object.entries(properties)) {
    if (value[name] === undefined || value[name] === null) continue;
    const actual = Array.isArray(value[name]) ? 'array' : typeof value[name];
    const expected = prop.type;
    if (expected === 'integer') {
      if (!Number.isInteger(Number(value[name]))) {
        return { ok: false, message: `"${name}" must be an integer` };
      }
      value[name] = Number(value[name]);
    } else if (expected === 'number') {
      if (!Number.isFinite(Number(value[name]))) {
        return { ok: false, message: `"${name}" must be a number` };
      }
      value[name] = Number(value[name]);
    } else if (expected && expected !== actual) {
      return { ok: false, message: `"${name}" must be ${expected}` };
    }
    if (prop.enum && !prop.enum.includes(value[name])) {
      return { ok: false, message: `"${name}" must be one of ${prop.enum.join(', ')}` };
    }
  }

  return { ok: true, args: value };
}

function capToolResult(result) {
  const text = typeof result === 'string'
    ? result
    : result == null
      ? ''
      : JSON.stringify(result, null, 2);
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  return truncateMiddle(text, TOOL_RESULT_MAX_CHARS, 'tool result truncated');
}

function truncateMiddle(text, maxChars, label = 'truncated') {
  const value = String(text || '');
  if (value.length <= maxChars) return value;

  let marker = `\n[${label}]\n`;
  let available = Math.max(1, maxChars - marker.length);
  let headChars = Math.ceil(available * TOOL_RESULT_HEAD_RATIO);
  let tailChars = Math.max(0, available - headChars);
  let omitted = Math.max(0, value.length - headChars - tailChars);

  marker = `\n[${label}: ${omitted} chars omitted from middle]\n`;
  available = Math.max(1, maxChars - marker.length);
  headChars = Math.ceil(available * TOOL_RESULT_HEAD_RATIO);
  tailChars = Math.max(0, available - headChars);

  return `${value.slice(0, headChars)}${marker}${value.slice(value.length - tailChars)}`;
}

// ─── Built-in tools ─────────────────────────────────────────────────────────

function clampReadLimit(maxBytes) {
  const parsed = Number(maxBytes);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_READ_FILE_MAX_BYTES;
  return Math.min(Math.floor(parsed), ABSOLUTE_READ_FILE_MAX_BYTES);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function oversizedFileMessage(path, size, maxBytes, readToolName, listToolName) {
  const nextStep = listToolName === 'list_sandbox_files'
    ? 'For sandbox files, use execute_command with a targeted command such as sed/head/tail to read a smaller range.'
    : 'For active-agent browser files, use a smaller file, select/copy a smaller excerpt, or explicitly copy the needed content into the sandbox before using shell commands.';
  return [
    `Refusing to read ${path}: file is ${formatBytes(size)}, which exceeds the ${readToolName} safety limit of ${formatBytes(maxBytes)}.`,
    `Use ${listToolName} to inspect metadata. ${nextStep}`,
  ].join('\n');
}

function splitParentPath(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  const name = parts.pop() || '';
  return { parent: parts.join('/'), name };
}

async function findSandboxListedFile(path, ctx) {
  const { parent, name } = splitParentPath(path);
  const listing = await listFiles(parent, ctx?.agentUrl);
  const entries = Array.isArray(listing) ? listing : listing?.children;
  return entries?.find((entry) => entry.name === name) || null;
}

async function assertBrowserReadableFileSize(path, maxBytes, ctx) {
  const entry = await getAgentFileInfo(ctx.agentId, path).catch(() => null);

  if (!entry) return null;
  if (entry.type === 'directory') return `Cannot read ${path}: it is a directory.`;
  if (Number.isFinite(entry.size) && entry.size > maxBytes) {
    return oversizedFileMessage(path, entry.size, maxBytes, 'read_browser_file', 'list_browser_files');
  }
  return null;
}

async function assertSkillReadableFileSize(path, maxBytes, ctx) {
  const entry = await getAgentSkillFileInfo(ctx.agentId, path).catch(() => null);

  if (!entry) return null;
  if (entry.type === 'directory') return `Cannot read ${path}: it is a directory.`;
  if (Number.isFinite(entry.size) && entry.size > maxBytes) {
    return oversizedFileMessage(path, entry.size, maxBytes, 'read_skill_file', 'list_skill_files');
  }
  return null;
}

async function assertSandboxReadableFileSize(path, maxBytes, ctx) {
  const entry = await findSandboxListedFile(path, ctx).catch(() => null);

  if (!entry) return null;
  if (entry.type === 'directory') return `Cannot read ${path}: it is a directory.`;
  if (Number.isFinite(entry.size) && entry.size > maxBytes) {
    return oversizedFileMessage(path, entry.size, maxBytes, 'read_sandbox_file', 'list_sandbox_files');
  }
  return null;
}

function inferImageMimeFromPath(path) {
  const extension = String(path || '').split('.').pop()?.toLowerCase();
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'svg') return 'image/svg+xml';
  if (extension === 'bmp') return 'image/bmp';
  return '';
}

function isSupportedImageMime(type) {
  return ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'image/bmp'].includes(String(type || '').toLowerCase());
}

function imageReferenceResult(source, path, metadata = {}) {
  return JSON.stringify({
    kind: 'image_reference',
    source,
    path,
    ...(metadata.name ? { name: metadata.name } : {}),
    ...(metadata.mimeType ? { mime_type: metadata.mimeType } : {}),
    ...(Number.isFinite(metadata.size) ? { size: metadata.size } : {}),
  });
}

registry.register({
  name: 'execute_command',
  category: 'shell',
  schema: {
    description:
      'Run a SHORT foreground shell command that is expected to finish within 30 seconds. Use it for quick inspection and bounded operations such as pwd, ls, git status, or a small targeted test. NEVER use it for training, servers, watchers, long builds, downloads, migrations, or any command whose duration is unknown or may exceed 30 seconds; use start_command instead. Commands can only see the sandbox filesystem/workdir, not browser OPFS.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  checkAvailable: (ctx) => !!ctx?.agentUrl,
  async handler({ command }, ctx) {
    const result = await executeCommand(command, ctx.agentUrl, {
      stream: true,
      signal: ctx?.signal,
      onStdout: (chunk) => ctx?.onToolUpdate?.({ stdout: chunk }),
      onStderr: (chunk) => ctx?.onToolUpdate?.({ stderr: chunk }),
    });
    ctx?.onToolUpdate?.({
      exitCode: result.code,
      platform: result.platform,
      shell: result.shell,
      cwd: result.cwd,
      filesRoot: result.filesRoot,
    });
    let out = `Exit code: ${result.code}`;
    if (result.status) out += `\nStatus: ${result.status}${Number.isFinite(result.durationMs) ? ` (${result.durationMs} ms)` : ''}`;
    if (result.platform || result.shell || result.cwd || result.filesRoot) {
      out += `\nEnvironment: platform=${result.platform || 'unknown'}, shell=${result.shell || 'unknown'}, cwd=${result.cwd || 'unknown'}, filesRoot=${result.filesRoot || 'unknown'}`;
    }
    if (result.stdout) out += `\nStdout:\n${result.stdout}`;
    if (result.stderr) out += `\nStderr:\n${result.stderr}`;
    return out;
  },
});

const managedCommandAvailable = (ctx) => !!ctx?.agentUrl && ctx.agentUrl !== E2B_AGENT_ID;

registry.register({
  name: 'start_command',
  category: 'shell',
  schema: {
    description:
      'Start a managed BACKGROUND shell command and return immediately with a job_id. Use this instead of execute_command for training, servers, watchers, lengthy builds/tests/downloads/migrations, commands with unknown duration, or anything expected to take 30 seconds or more. Do not add nohup, &, disown, screen, tmux, or shell timeout wrappers; the server owns the process, logs, and cancellation.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The complete foreground-form shell command. Do not append & or nohup.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  checkAvailable: managedCommandAvailable,
  async handler({ command }, ctx) {
    return JSON.stringify(await startCommand(command, ctx.agentUrl, ctx?.signal), null, 2);
  },
});

registry.register({
  name: 'get_command',
  category: 'shell',
  readOnly: true,
  parallelSafe: true,
  schema: {
    description:
      'Read the current status and one incremental log segment for a managed background command. Pass nextCursor from the previous result as cursor so logs are not repeated. This returns immediately.',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The job_id returned by start_command.' },
        cursor: { type: 'integer', minimum: 0, description: 'Log byte cursor; use nextCursor from the previous result. Defaults to 0.' },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  checkAvailable: managedCommandAvailable,
  async handler({ job_id: jobId, cursor = 0 }, ctx) {
    return JSON.stringify(await getCommand(jobId, ctx.agentUrl, cursor, ctx?.signal), null, 2);
  },
});

registry.register({
  name: 'wait_command',
  category: 'shell',
  readOnly: true,
  parallelSafe: true,
  schema: {
    description:
      'Wait up to 30 seconds for new logs or completion of a managed background command. Use only when completion is likely within that brief wait. For training or other work expected to need minutes or hours, call schedule_wakeup instead of repeatedly calling wait_command.',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The job_id returned by start_command.' },
        cursor: { type: 'integer', minimum: 0, description: 'Use nextCursor from the previous result. Defaults to 0.' },
        wait_seconds: { type: 'integer', minimum: 1, maximum: 30, description: 'Maximum wait, from 1 through 30 seconds. Defaults to 30.' },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  checkAvailable: managedCommandAvailable,
  async handler({ job_id: jobId, cursor = 0, wait_seconds: waitSeconds = 30 }, ctx) {
    return JSON.stringify(await waitCommand(jobId, ctx.agentUrl, {
      cursor,
      waitMs: waitSeconds * 1000,
      signal: ctx?.signal,
    }), null, 2);
  },
});

registry.register({
  name: 'stop_command',
  category: 'shell',
  schema: {
    description:
      'Stop a managed background command by job_id. This terminates the entire process tree, first gracefully and then forcibly if needed. Use only when the user requested cancellation or continuing the job is no longer useful.',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The job_id returned by start_command.' },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  checkAvailable: managedCommandAvailable,
  async handler({ job_id: jobId }, ctx) {
    return JSON.stringify(await stopCommand(jobId, ctx.agentUrl, ctx?.signal), null, 2);
  },
});

registry.register({
  name: 'list_browser_files',
  category: 'files',
  readOnly: true,
  parallelSafe: true,
  schema: {
    description:
      'List files in the active agent browser workspace files area: workspace/<active-agent>/files/. This is NOT OPFS root, NOT other agents, NOT AGENTS.md/memory/skills, and NOT the sandbox filesystem.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to workspace/<active-agent>/files/. Empty means that files area root, not OPFS root.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  checkAvailable: (ctx) => !!ctx?.agentId,
  async handler({ path = '' }, ctx) {
    try {
      const result = await listAgentFiles(ctx.agentId, path);
      return formatFileTree(result, 0);
    } catch (err) {
      return `Error listing browser files: ${err.message}`;
    }
  },
});

registry.register({
  name: 'read_browser_file',
  category: 'files',
  readOnly: true,
  parallelSafe: true,
  schema: {
    description:
      'Read a text file from workspace/<active-agent>/files/ in browser OPFS. This cannot read OPFS root, other agents, AGENTS.md, memory, skills, or sandbox files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to workspace/<active-agent>/files/.',
        },
        max_bytes: {
          type: 'number',
          description: `Maximum file size to read. Defaults to ${DEFAULT_READ_FILE_MAX_BYTES} bytes and is capped at ${ABSOLUTE_READ_FILE_MAX_BYTES} bytes.`,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  checkAvailable: (ctx) => !!ctx?.agentId,
  async handler({ path, max_bytes: maxBytesArg }, ctx) {
    try {
      const maxBytes = clampReadLimit(maxBytesArg);
      const sizeError = await assertBrowserReadableFileSize(path, maxBytes, ctx);
      if (sizeError) return sizeError;
      const content = await readAgentFile(ctx.agentId, path);
      return content ?? `Browser file not found: ${path}`;
    } catch (err) {
      return `Error reading browser file ${path}: ${err.message}`;
    }
  },
});

registry.register({
  name: 'display_browser_image',
  category: 'files',
  readOnly: true,
  parallelSafe: true,
  schema: {
    description:
      'Display an image stored in workspace/<active-agent>/files/ in the conversation UI. The tool returns only a durable file reference and never puts image bytes or base64 in the conversation. This cannot display sandbox files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Image path relative to workspace/<active-agent>/files/.',
        },
        alt: {
          type: 'string',
          description: 'Short accessible description of the image.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  checkAvailable: (ctx) => !!ctx?.agentId,
  async handler({ path }, ctx) {
    try {
      const info = await getAgentFileInfo(ctx.agentId, path);
      const mimeType = info.type || inferImageMimeFromPath(path);
      if (!isSupportedImageMime(mimeType)) return `Unsupported image type: ${mimeType || 'unknown'}`;
      if (info.size > ABSOLUTE_IMAGE_MAX_SOURCE_BYTES) {
        return `Refusing to display image ${path}: file is ${formatBytes(info.size)}, above ${formatBytes(ABSOLUTE_IMAGE_MAX_SOURCE_BYTES)}.`;
      }
      return imageReferenceResult('browser', path, { name: info.name, mimeType, size: info.size });
    } catch (err) {
      return `Error displaying browser image ${path}: ${err.message}`;
    }
  },
});

registry.register({
  name: 'write_browser_file',
  category: 'files',
  schema: {
    description:
      'Write a text file only to workspace/<active-agent>/files/ in browser OPFS. This cannot modify OPFS root, other agents, AGENTS.md, memory, skills, or the sandbox workdir.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to workspace/<active-agent>/files/.',
        },
        content: {
          type: 'string',
          description: 'The content to write.',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  checkAvailable: (ctx) => !!ctx?.agentId,
  async handler({ path, content }, ctx) {
    try {
      await writeAgentFile(ctx.agentId, path, content);
      return `Successfully wrote active-agent browser file ${path}`;
    } catch (err) {
      return `Error writing browser file ${path}: ${err.message}`;
    }
  },
});

registry.register({
  name: 'list_skill_files',
  category: 'skills',
  readOnly: true,
  parallelSafe: true,
  schema: {
    description:
      'List files in the active agent skill directory: workspace/<active-agent>/skills/. Use this for explicit skill file editing. Skill files are browser OPFS files, not sandbox files and not workspace/<active-agent>/files/.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to workspace/<active-agent>/skills/. Empty means the skills root.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  checkAvailable: (ctx) => !!ctx?.agentId,
  async handler({ path = '' }, ctx) {
    try {
      const result = await listAgentSkillFiles(ctx.agentId, path);
      return formatFileTree(result, 0);
    } catch (err) {
      return `Error listing skill files: ${err.message}`;
    }
  },
});

registry.register({
  name: 'read_skill_file',
  category: 'skills',
  readOnly: true,
  parallelSafe: true,
  schema: {
    description:
      'Read a text file from workspace/<active-agent>/skills/ in browser OPFS. Use the skill tool for the enabled skill catalog, and this tool only when direct skill file content is needed.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to workspace/<active-agent>/skills/, such as my-skill/SKILL.md or my-skill/references/example.md.',
        },
        max_bytes: {
          type: 'number',
          description: `Maximum file size to read. Defaults to ${DEFAULT_READ_FILE_MAX_BYTES} bytes and is capped at ${ABSOLUTE_READ_FILE_MAX_BYTES} bytes.`,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  checkAvailable: (ctx) => !!ctx?.agentId,
  async handler({ path, max_bytes: maxBytesArg }, ctx) {
    try {
      const maxBytes = clampReadLimit(maxBytesArg);
      const sizeError = await assertSkillReadableFileSize(path, maxBytes, ctx);
      if (sizeError) return sizeError;
      const content = await readAgentSkillPath(ctx.agentId, path);
      return content ?? `Skill file not found: ${path}`;
    } catch (err) {
      return `Error reading skill file ${path}: ${err.message}`;
    }
  },
});

registry.register({
  name: 'write_skill_file',
  category: 'skills',
  schema: {
    description:
      'Write a text file under workspace/<active-agent>/skills/ in browser OPFS. To create a skill, write <skill-name>/SKILL.md. To add references, write <skill-name>/references/<file>. Parent directories are created automatically.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to workspace/<active-agent>/skills/.',
        },
        content: {
          type: 'string',
          description: 'The content to write.',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  checkAvailable: (ctx) => !!ctx?.agentId,
  async handler({ path, content }, ctx) {
    try {
      await writeAgentSkillPath(ctx.agentId, path, content);
      return `Successfully wrote skill file ${path}`;
    } catch (err) {
      return `Error writing skill file ${path}: ${err.message}`;
    }
  },
});

registry.register({
  name: 'list_sandbox_files',
  category: 'sandbox-files',
  readOnly: true,
  parallelSafe: true,
  schema: {
    description:
      'List files in the sandbox runtime workdir used by command tools. This is NOT browser OPFS, NOT workspace/<active-agent>/files/, and does not contain AGENTS.md, memory, skills, or UI-selected browser files unless you explicitly copy them there.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Sandbox workdir directory path to list. Empty means the sandbox files root/workdir.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  checkAvailable: (ctx) => !!ctx?.agentUrl,
  async handler({ path = '' }, ctx) {
    try {
      const result = await listFiles(path, ctx.agentUrl);
      return formatFileTree(result, 0);
    } catch (err) {
      return `Error listing sandbox files: ${err.message}`;
    }
  },
});

registry.register({
  name: 'read_sandbox_file',
  category: 'sandbox-files',
  readOnly: true,
  parallelSafe: true,
  schema: {
    description:
      'Read a text file from the sandbox runtime workdir used by command tools. Use read_browser_file for files under workspace/<active-agent>/files/.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Sandbox workdir file path.',
        },
        max_bytes: {
          type: 'number',
          description: `Maximum file size to read. Defaults to ${DEFAULT_READ_FILE_MAX_BYTES} bytes and is capped at ${ABSOLUTE_READ_FILE_MAX_BYTES} bytes.`,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  checkAvailable: (ctx) => !!ctx?.agentUrl,
  async handler({ path, max_bytes: maxBytesArg }, ctx) {
    try {
      const maxBytes = clampReadLimit(maxBytesArg);
      const sizeError = await assertSandboxReadableFileSize(path, maxBytes, ctx);
      if (sizeError) return sizeError;
      const content = await readFileText(path, ctx.agentUrl);
      const contentSize = new Blob([content]).size;
      if (contentSize > maxBytes) {
        return oversizedFileMessage(path, contentSize, maxBytes, 'read_sandbox_file', 'list_sandbox_files');
      }
      return content;
    } catch (err) {
      return `Error reading sandbox file ${path}: ${err.message}`;
    }
  },
});

registry.register({
  name: 'display_sandbox_image',
  category: 'sandbox-files',
  readOnly: true,
  parallelSafe: true,
  schema: {
    description:
      'Display an image stored in the sandbox runtime workdir in the conversation UI. The tool returns only a sandbox file reference and never puts image bytes or base64 in the conversation. Use display_browser_image for browser files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Sandbox workdir image path.',
        },
        alt: {
          type: 'string',
          description: 'Short accessible description of the image.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  checkAvailable: (ctx) => !!ctx?.agentUrl,
  async handler({ path }, ctx) {
    try {
      const entry = await findSandboxListedFile(path, ctx);
      if (!entry || entry.type === 'directory') return `Sandbox image not found: ${path}`;
      const mimeType = inferImageMimeFromPath(path);
      if (!isSupportedImageMime(mimeType)) return `Unsupported image type: ${mimeType || 'unknown'}`;
      if (Number.isFinite(entry.size) && entry.size > ABSOLUTE_IMAGE_MAX_SOURCE_BYTES) {
        return `Refusing to display image ${path}: file is ${formatBytes(entry.size)}, above ${formatBytes(ABSOLUTE_IMAGE_MAX_SOURCE_BYTES)}.`;
      }
      return imageReferenceResult('sandbox', path, { name: entry.name, mimeType, size: entry.size });
    } catch (err) {
      return `Error displaying sandbox image ${path}: ${err.message}`;
    }
  },
});

registry.register({
  name: 'write_sandbox_file',
  category: 'sandbox-files',
  schema: {
    description:
      'Write a text file to the sandbox runtime workdir used by command tools. This does not update browser OPFS or workspace/<active-agent>/files/.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Sandbox workdir file path.',
        },
        content: {
          type: 'string',
          description: 'The content to write.',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  checkAvailable: (ctx) => !!ctx?.agentUrl,
  async handler({ path, content }, ctx) {
    try {
      await writeFile(path, content, ctx.agentUrl);
      return `Successfully wrote sandbox file ${path}`;
    } catch (err) {
      return `Error writing sandbox file ${path}: ${err.message}`;
    }
  },
});

registry.register({
  name: 'memory',
  category: 'memory',
  readOnly: false,
  parallelSafe: false,
  schema: {
    description:
      'Manage durable memory records stored in browser OPFS with the active agent. This is not sandbox state and not a file under workspace/<active-agent>/files/. Use only for facts, preferences, project conventions, or lessons that should survive future sessions.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'search', 'write', 'delete', 'clear'],
          description: 'Operation to perform.',
        },
        type: {
          type: 'string',
          enum: ['memory', 'user', 'both'],
          description: '"memory" for project/workspace facts, "user" for user preferences/profile, or "both" for read/clear operations.',
        },
        id: {
          type: 'string',
          description: 'Existing memory id to update or delete.',
        },
        query: {
          type: 'string',
          description: 'Search query for list/search.',
        },
        content: {
          type: 'string',
          description: 'Concise memory content for write/update.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for write/update.',
        },
        importance: {
          type: 'string',
          enum: ['low', 'normal', 'high'],
          description: 'Importance for compaction priority.',
        },
        max_entries: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Maximum entries to return for list/search. Defaults to 20.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    try {
      const agentId = ctx?.agentId;
      const action = args.action;
      const type = args.type || (action === 'write' ? 'memory' : 'both');

      if (action === 'list' || action === 'search') {
        const entries = await listMemoryEntries({
          type,
          query: action === 'search' ? args.query : '',
          maxEntries: args.max_entries,
        }, agentId);
        return formatMemoryEntries(entries);
      }

      if (action === 'write') {
        if (type === 'both') return 'Memory error: type must be "memory" or "user" when writing.';
        const record = await upsertMemoryEntry({
          type,
          id: args.id,
          content: args.content,
          tags: args.tags,
          importance: args.importance,
        }, agentId);
        return `Saved ${record.type} memory ${record.id}.`;
      }

      if (action === 'delete') {
        if (!args.id) return 'Memory error: id is required for delete.';
        if (type === 'both') {
          const deletedProject = await deleteMemoryEntry('memory', args.id, agentId);
          const deletedUser = await deleteMemoryEntry('user', args.id, agentId);
          return deletedProject || deletedUser
            ? `Deleted memory ${args.id}.`
            : `Memory ${args.id} not found.`;
        }
        const deleted = await deleteMemoryEntry(type, args.id, agentId);
        return deleted ? `Deleted ${type} memory ${args.id}.` : `Memory ${args.id} not found.`;
      }

      if (action === 'clear') {
        await clearMemory(type, agentId);
        return `Cleared ${type === 'both' ? 'all memory' : `${type} memory`}.`;
      }

      return `Unknown memory action: ${action}`;
    } catch (err) {
      return `Memory error: ${err.message}`;
    }
  },
});

registry.register({
  name: 'skill',
  category: 'skills',
  readOnly: true,
  parallelSafe: true,
  schema: {
    description:
      'List, search, and read progressive skills stored in browser OPFS. This tool does not create, update, or delete skills. To create or edit an active-agent skill, write files under workspace/<active-agent>/skills/ with write_skill_file. Global skills are read-only to AI tools. Skills are not files in the sandbox runtime and not files under workspace/<active-agent>/files/. Read a skill before following its detailed procedure; read references by name only when needed.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'search', 'read'],
          description: 'Skill operation.',
        },
        name: {
          type: 'string',
          description: 'Skill name for read.',
        },
        query: {
          type: 'string',
          description: 'Search query.',
        },
        reference_name: {
          type: 'string',
          description: 'Reference file name to read.',
        },
        include_references: {
          type: 'boolean',
          description: 'For read only: include all reference files. Prefer false unless the references are known to be small and necessary.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    try {
      const agentId = ctx?.agentId;
      if (args.action === 'list') {
        const skills = await searchSkills('', agentId);
        return formatSkills(skills);
      }
      if (args.action === 'search') {
        const skills = await searchSkills(args.query || '', agentId);
        return formatSkills(skills);
      }
      if (args.action === 'read') {
        if (!args.name) return 'Skill error: name is required for read.';
        const skill = await getSkill(args.name, agentId, {
          referenceName: args.reference_name,
          includeReferences: args.include_references,
        });
        return skill ? skill.content : `Skill or reference not found: ${args.name}${args.reference_name ? `/${args.reference_name}` : ''}`;
      }
      return `Unknown skill action: ${args.action}`;
    } catch (err) {
      return `Skill error: ${err.message}`;
    }
  },
});

registry.register({
  name: 'schedule_wakeup',
  category: 'automation',
  schema: {
    description:
      'Schedule one future continuation of the current conversation. Use this instead of blocking or repeatedly polling during a long-running task. When the delay expires, the saved prompt is added to this conversation and the agent runs again. If the task is still pending after waking, schedule another wake-up. The browser page must be open to fire on time; an overdue wake-up fires once when the app is opened again.',
    parameters: {
      type: 'object',
      properties: {
        delay_seconds: {
          type: 'integer',
          minimum: 5,
          maximum: 604800,
          description: 'Seconds from now to wake the agent, from 5 seconds through 7 days.',
        },
        prompt: {
          type: 'string',
          description: 'A self-contained instruction describing what to inspect or continue when the agent wakes.',
        },
      },
      required: ['delay_seconds', 'prompt'],
      additionalProperties: false,
    },
  },
  checkAvailable: (ctx) => typeof ctx?.scheduleWakeup === 'function',
  async handler({ delay_seconds: delaySeconds, prompt }, ctx) {
    const wakeup = await ctx.scheduleWakeup({ delaySeconds, prompt });
    return JSON.stringify({
      scheduled: true,
      wakeup_id: wakeup.id,
      run_at: new Date(wakeup.runAtMs).toISOString(),
      prompt: wakeup.prompt,
    });
  },
});

registry.register({
  name: 'spawn_agent',
  category: 'agents',
  schema: {
    description:
      'Run one or more focused tasks through an existing agent workspace and return their results. If no agent_id or agent_name is provided, run as the current/default agent. This tool cannot create new agents. For multiple related tasks, send them in one call with shared_context so requests share the same prompt prefix for better provider cache hits.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The complete task for one delegated agent run. Use either task or tasks.',
        },
        tasks: {
          type: 'array',
          description: 'Multiple independent tasks to run through agent workspaces. Use this instead of repeated spawn_agent calls when tasks share context.',
          items: {
            type: 'object',
            properties: {
              task: {
                type: 'string',
                description: 'The complete task for this delegated agent run.',
              },
              agent_id: {
                type: 'string',
                description: 'Optional existing agent ID to run this task as.',
              },
              agent_name: {
                type: 'string',
                description: 'Optional existing agent display name to run this task as when agent_id is not provided.',
              },
            },
            required: ['task'],
            additionalProperties: false,
          },
          minItems: 1,
          maxItems: 4,
        },
        shared_context: {
          type: 'string',
          description: 'Optional context prepended identically to every task. Put common repo notes, constraints, and file paths here to improve prompt-cache hits.',
        },
        agent_id: {
          type: 'string',
          description: 'Optional existing agent ID to run as. If omitted with agent_name, the current/default agent is used.',
        },
        agent_name: {
          type: 'string',
          description: 'Optional existing agent display name to run as when agent_id is not provided.',
        },
        max_rounds: {
          type: 'integer',
          minimum: 1,
          maximum: 6,
          description: 'Maximum tool-use rounds for the delegated agent run. Defaults to 4.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  checkAvailable: (ctx) => !!ctx?.agentId && !!ctx?.llmProfileId && (ctx?.subAgentDepth || 0) < 1,
  async handler({ task, tasks, shared_context: sharedContext = '', agent_id: agentId, agent_name: agentName, max_rounds: maxRounds = 4 }, ctx) {
    try {
      const requestedTasks = normalizeSpawnTasks({ task, tasks, agentId, agentName });
      if (requestedTasks.length === 0) {
        return 'Error running delegated agent task: provide task or tasks.';
      }
      const boundedRounds = Math.min(Math.max(Number(maxRounds) || 4, 1), 6);
      const results = await Promise.all(
        requestedTasks.map((item, index) => runSpawnedAgent(item, index, requestedTasks.length, sharedContext, boundedRounds, ctx))
      );

      return results.join('\n\n---\n\n');
    } catch (err) {
      return `Error running delegated agent task: ${err.message}`;
    }
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format a file tree result as a readable string. */
function formatFileTree(node, depth = 0) {
  if (Array.isArray(node)) {
    return node.map((f) => `${'  '.repeat(depth)}${f.type === 'directory' ? '[dir]' : '[file]'} ${f.name}`).join('\n');
  }
  if (!node || !node.children) return '(empty)';
  const indent = '  '.repeat(depth);
  return node.children
    .map((child) => {
      const icon = child.type === 'directory' ? '[dir]' : '[file]';
      let line = `${indent}${icon} ${child.name}`;
      if (child.children?.length) {
        line += '\n' + formatFileTree(child, depth + 1);
      }
      return line;
    })
    .join('\n');
}

function formatMemoryEntries(entries) {
  if (!entries?.length) return 'No memory records found.';
  return entries
    .map((entry) => {
      const tags = entry.tags?.length ? ` tags=${entry.tags.join(',')}` : '';
      return `- ${entry.id} [${entry.type}; ${entry.importance}${tags}; updated ${entry.updatedAt}]\n  ${entry.content}`;
    })
    .join('\n');
}

function formatSkills(skills) {
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

const SUB_AGENT_SYSTEM_PROMPT = `You are a delegated VertexAgent agent run.

Work on the assigned task independently and return a concise final report with:
- What you did or found
- Files you changed, if any
- Any blockers, risks, or follow-up needed

Filesystem model:
- Browser OPFS is the durable agent storage backend, but browser file tools can only access workspace/<active-agent>/files/.
- Browser file tools cannot access OPFS root, other agents, AGENTS.md, memory, or skills by path.
- Use the skill tool for catalog/read operations, and skill file tools for explicit edits under workspace/<active-agent>/skills/.
- The sandbox filesystem is only the runtime workdir for command tools.
- Use browser file tools for persistent files under workspace/<active-agent>/files/ and sandbox file tools for command-runtime files.

Do not answer with a promise like "I will inspect/read/create/run". If the next step needs a tool, call the tool in the same response.

Use the selected workspace and memory. Use tools when they materially help. For CLI work, follow the command selection rules in the base runtime prompt, including start_command for long or uncertain work. Do not ask the user questions; if something is ambiguous, make a conservative assumption and state it.`;

function normalizeSpawnTasks({ task, tasks, agentId, agentName }) {
  if (Array.isArray(tasks) && tasks.length > 0) {
    return tasks
      .slice(0, 4)
      .filter((item) => item?.task?.trim())
      .map((item) => ({
        task: item.task.trim(),
        agentId: item.agent_id || null,
        agentName: item.agent_name?.trim() || null,
      }));
  }
  if (!task?.trim()) return [];
  return [{
    task: task.trim(),
    agentId: agentId || null,
    agentName: agentName?.trim() || null,
  }];
}

async function runSpawnedAgent(item, index, total, sharedContext, maxRounds, ctx) {
  const { runAgentLoop } = await import('./loop.js');

  let subAgent = null;

  if (item.agentId) {
    subAgent = await getAgent(item.agentId);
    if (!subAgent) throw new Error(`Agent not found: ${item.agentId}`);
  } else if (item.agentName) {
    const agents = await listAgents();
    subAgent = agents.find((agent) => agent.name === item.agentName) || null;
    if (!subAgent) throw new Error(`Agent not found: ${item.agentName}`);
  } else {
    subAgent = await getAgent(ctx.agentId);
    if (!subAgent) throw new Error(`Current agent not found: ${ctx.agentId}`);
  }

  const messages = buildSubAgentMessages(sharedContext, item.task, index, total);
  const result = await runAgentLoop({
    messages,
    systemPrompt: SUB_AGENT_SYSTEM_PROMPT,
    agentUrl: ctx.agentUrl || null,
    agentId: subAgent.id,
    llmProfileId: ctx.llmProfileId,
    provider: ctx.provider,
    model: ctx.model,
    contextWindow: ctx.contextWindow,
    signal: ctx.signal,
    maxRounds,
    subAgentDepth: (ctx.subAgentDepth || 0) + 1,
  });

  const toolSummary = result.toolCalls?.length
    ? `\n\nAgent tool calls:\n${result.toolCalls.map((tc) => `- ${tc.name}: ${tc.status}`).join('\n')}`
    : '';

  return `Agent ${subAgent.name} (${subAgent.id}) completed.\n\n${result.content || '(no final content)'}${toolSummary}`;
}

function buildSubAgentMessages(sharedContext, task, index, total) {
  const messages = [];
  const trimmedContext = sharedContext?.trim();
  if (trimmedContext) {
    messages.push({
      role: 'user',
      content: `Shared context for all delegated agent tasks:\n${trimmedContext}`,
    });
  }
  messages.push({
    role: 'user',
    content: total > 1
      ? `Delegated agent task ${index + 1} of ${total}:\n${task}`
      : task,
  });
  return messages;
}
