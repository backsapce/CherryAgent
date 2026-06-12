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
import { downloadE2bFile, downloadRemoteFile, executeCommand, listFiles, readFileText, writeFile } from '../models/agent';
import {
  getAgentFileInfo,
  getAgentSkillFileInfo,
  listAgentFiles,
  listAgentSkillFiles,
  readAgentFile,
  readAgentFileBlob,
  readAgentSkillPath,
  writeAgentFile,
  writeAgentSkillPath,
} from '../vfs/opfs';
import config from '../config/config';
import { getAgent, listAgents, updateAgentConfig } from '../agents/agents.js';

const DEFAULT_READ_FILE_MAX_BYTES = 256 * 1024;
const ABSOLUTE_READ_FILE_MAX_BYTES = 1024 * 1024;
const DEFAULT_IMAGE_MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const ABSOLUTE_IMAGE_MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const DEFAULT_IMAGE_MAX_DIMENSION = 1024;
const ABSOLUTE_IMAGE_MAX_DIMENSION = 2048;
const DEFAULT_IMAGE_QUALITY = 0.82;
const MAX_IMAGE_DATA_URL_BYTES = 1_500_000;
const E2B_AGENT_ID = '__e2b__';
const TOOL_RESULT_MAX_CHARS = 80_000;

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
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n[tool result truncated: ${text.length - TOOL_RESULT_MAX_CHARS} chars omitted]`;
}

// ─── Built-in tools ─────────────────────────────────────────────────────────

function clampReadLimit(maxBytes) {
  const parsed = Number(maxBytes);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_READ_FILE_MAX_BYTES;
  return Math.min(Math.floor(parsed), ABSOLUTE_READ_FILE_MAX_BYTES);
}

function clampImageSourceLimit(maxBytes) {
  const parsed = Number(maxBytes);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_IMAGE_MAX_SOURCE_BYTES;
  return Math.min(Math.floor(parsed), ABSOLUTE_IMAGE_MAX_SOURCE_BYTES);
}

function clampImageDimension(maxDimension) {
  const parsed = Number(maxDimension);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_IMAGE_MAX_DIMENSION;
  return Math.min(Math.floor(parsed), ABSOLUTE_IMAGE_MAX_DIMENSION);
}

function clampImageQuality(quality) {
  const parsed = Number(quality);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_IMAGE_QUALITY;
  return Math.min(Math.max(parsed, 0.1), 0.95);
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

function getImageOutputType(format) {
  return ['image/jpeg', 'image/png', 'image/webp'].includes(format) ? format : 'image/jpeg';
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read image data URL'));
    reader.readAsDataURL(blob);
  });
}

function loadImageElement(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Unsupported or corrupt image file'));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas, outputType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error(`Could not encode image as ${outputType}`));
    }, outputType, quality);
  });
}

async function resizeImageBlob(blob, options = {}) {
  const sourceType = isSupportedImageMime(blob.type)
    ? blob.type
    : inferImageMimeFromPath(options.path);
  if (!isSupportedImageMime(sourceType)) {
    return { error: `Unsupported image type: ${blob.type || 'unknown'}` };
  }

  const maxDimension = clampImageDimension(options.maxDimension);
  const quality = clampImageQuality(options.quality);
  const outputType = getImageOutputType(options.outputFormat);
  const sourceBlob = blob.type === sourceType ? blob : new Blob([blob], { type: sourceType });
  const image = await loadImageElement(sourceBlob);
  const originalWidth = image.naturalWidth || image.width;
  const originalHeight = image.naturalHeight || image.height;
  if (!originalWidth || !originalHeight) {
    return { error: 'Could not determine image dimensions.' };
  }

  const scale = Math.min(1, maxDimension / Math.max(originalWidth, originalHeight));
  const width = Math.max(1, Math.round(originalWidth * scale));
  const height = Math.max(1, Math.round(originalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return { error: 'Could not prepare image canvas.' };
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  const resizedBlob = await canvasToBlob(canvas, outputType, quality);
  const dataUrl = await blobToDataUrl(resizedBlob);
  if (new Blob([dataUrl]).size > MAX_IMAGE_DATA_URL_BYTES) {
    return {
      error: `Refusing to return image data URL: encoded result is ${formatBytes(new Blob([dataUrl]).size)}, above ${formatBytes(MAX_IMAGE_DATA_URL_BYTES)}. Try a smaller max_dimension or lower quality.`,
    };
  }

  return {
    dataUrl,
    originalWidth,
    originalHeight,
    width,
    height,
    inputBytes: blob.size,
    outputBytes: resizedBlob.size,
    mimeType: outputType,
  };
}

async function readSandboxImageBlob(path, ctx) {
  if (ctx?.agentUrl === E2B_AGENT_ID) {
    return downloadE2bFile(path);
  }
  return downloadRemoteFile(path, ctx?.agentUrl);
}

async function readBrowserImageBlob(path, ctx) {
  return readAgentFileBlob(ctx.agentId, path);
}

async function readImageToolResult(path, blob, options) {
  const maxSourceBytes = clampImageSourceLimit(options.maxSourceBytes);
  if (blob.size > maxSourceBytes) {
    return `Refusing to read image ${path}: file is ${formatBytes(blob.size)}, above the image source limit of ${formatBytes(maxSourceBytes)}.`;
  }

  const result = await resizeImageBlob(blob, { ...options, path });
  if (result.error) return result.error;
  return JSON.stringify({
    path,
    mime_type: result.mimeType,
    original_width: result.originalWidth,
    original_height: result.originalHeight,
    width: result.width,
    height: result.height,
    input_bytes: result.inputBytes,
    output_bytes: result.outputBytes,
    data_url: result.dataUrl,
  });
}

registry.register({
  name: 'execute_command',
  category: 'shell',
  schema: {
    description:
      'Execute a shell command in the selected sandbox runtime. Commands can only see the sandbox filesystem/workdir, not browser OPFS, the active agent files area, AGENTS.md, memory, or skills unless you explicitly copy content into the sandbox.',
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
      requireStreaming: true,
      signal: ctx?.signal,
      onStdout: (chunk) => ctx?.onToolUpdate?.({ stdout: chunk }),
      onStderr: (chunk) => ctx?.onToolUpdate?.({ stderr: chunk }),
    });
    let out = `Exit code: ${result.code}`;
    if (result.platform || result.shell || result.cwd || result.filesRoot) {
      out += `\nEnvironment: platform=${result.platform || 'unknown'}, shell=${result.shell || 'unknown'}, cwd=${result.cwd || 'unknown'}, filesRoot=${result.filesRoot || 'unknown'}`;
    }
    if (result.stdout) out += `\nStdout:\n${result.stdout}`;
    if (result.stderr) out += `\nStderr:\n${result.stderr}`;
    return out;
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
  name: 'read_browser_image',
  category: 'files',
  readOnly: true,
  parallelSafe: true,
  schema: {
    description:
      'Read an image from workspace/<active-agent>/files/ in browser OPFS and return a compact data URL with metadata. This cannot read OPFS root or sandbox files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Image path relative to workspace/<active-agent>/files/.',
        },
        max_dimension: {
          type: 'number',
          description: `Maximum width or height in pixels. Defaults to ${DEFAULT_IMAGE_MAX_DIMENSION} and is capped at ${ABSOLUTE_IMAGE_MAX_DIMENSION}.`,
        },
        quality: {
          type: 'number',
          description: `Encoding quality for jpeg/webp from 0.1 to 0.95. Defaults to ${DEFAULT_IMAGE_QUALITY}.`,
        },
        output_format: {
          type: 'string',
          enum: ['image/jpeg', 'image/png', 'image/webp'],
          description: 'Output image MIME type. Defaults to image/jpeg.',
        },
        max_source_bytes: {
          type: 'number',
          description: `Maximum source file size to read. Defaults to ${DEFAULT_IMAGE_MAX_SOURCE_BYTES} bytes and is capped at ${ABSOLUTE_IMAGE_MAX_SOURCE_BYTES} bytes.`,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  checkAvailable: (ctx) => !!ctx?.agentId,
  async handler({ path, max_dimension: maxDimension, quality, output_format: outputFormat, max_source_bytes: maxSourceBytes }, ctx) {
    try {
      const blob = await readBrowserImageBlob(path, ctx);
      return await readImageToolResult(path, blob, {
        maxDimension,
        quality,
        outputFormat,
        maxSourceBytes,
      });
    } catch (err) {
      return `Error reading browser image ${path}: ${err.message}`;
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
      'List files in the sandbox runtime workdir used by execute_command. This is NOT browser OPFS, NOT workspace/<active-agent>/files/, and does not contain AGENTS.md, memory, skills, or UI-selected browser files unless you explicitly copy them there.',
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
      'Read a text file from the sandbox runtime workdir used by execute_command. Use read_browser_file for files under workspace/<active-agent>/files/.',
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
  name: 'read_sandbox_image',
  category: 'sandbox-files',
  readOnly: true,
  parallelSafe: true,
  schema: {
    description:
      'Read an image from the sandbox runtime workdir and return a compact data URL with metadata. Use read_browser_image for images under workspace/<active-agent>/files/.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Sandbox workdir image path.',
        },
        max_dimension: {
          type: 'number',
          description: `Maximum width or height in pixels. Defaults to ${DEFAULT_IMAGE_MAX_DIMENSION} and is capped at ${ABSOLUTE_IMAGE_MAX_DIMENSION}.`,
        },
        quality: {
          type: 'number',
          description: `Encoding quality for jpeg/webp from 0.1 to 0.95. Defaults to ${DEFAULT_IMAGE_QUALITY}.`,
        },
        output_format: {
          type: 'string',
          enum: ['image/jpeg', 'image/png', 'image/webp'],
          description: 'Output image MIME type. Defaults to image/jpeg.',
        },
        max_source_bytes: {
          type: 'number',
          description: `Maximum source file size to read. Defaults to ${DEFAULT_IMAGE_MAX_SOURCE_BYTES} bytes and is capped at ${ABSOLUTE_IMAGE_MAX_SOURCE_BYTES} bytes.`,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  checkAvailable: (ctx) => !!ctx?.agentUrl,
  async handler({ path, max_dimension: maxDimension, quality, output_format: outputFormat, max_source_bytes: maxSourceBytes }, ctx) {
    try {
      const blob = await readSandboxImageBlob(path, ctx);
      return await readImageToolResult(path, blob, {
        maxDimension,
        quality,
        outputFormat,
        maxSourceBytes,
      });
    } catch (err) {
      return `Error reading sandbox image ${path}: ${err.message}`;
    }
  },
});

registry.register({
  name: 'write_sandbox_file',
  category: 'sandbox-files',
  schema: {
    description:
      'Write a text file to the sandbox runtime workdir used by execute_command. This does not update browser OPFS or workspace/<active-agent>/files/.',
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
- The sandbox filesystem is only the runtime workdir for execute_command.
- Use browser file tools for persistent files under workspace/<active-agent>/files/ and sandbox file tools for command-runtime files.

Do not answer with a promise like "I will inspect/read/create/run". If the next step needs a tool, call the tool in the same response.

Use the selected workspace and memory. Use tools when they materially help. Do not ask the user questions; if something is ambiguous, make a conservative assumption and state it.`;

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

  await updateAgentConfig(subAgent.id, {
    llmProfileId: ctx.llmProfileId,
    sandboxUrl: ctx.agentUrl || null,
  });

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
