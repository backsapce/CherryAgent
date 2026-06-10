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

import { clearMemory, loadMemory, MEMORY_MAX, saveMemory, saveUser, USER_MAX } from './memory.js';
import { createSkill, deleteSkill, getSkill, listSkills, updateSkill } from './skills.js';
import { downloadE2bFile, downloadRemoteFile, executeCommand, listFiles, readFileText, writeFile } from '../models/agent';
import { getAgentFileInfo, listAgentFiles, loadFiles, readAgentFile, readAgentFileBlob, readPathBlob, writeAgentFile } from '../vfs/opfs';
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

// ─── Registry singleton ─────────────────────────────────────────────────────

const _tools = new Map();

export const registry = {
  /** Register a tool. */
  register(tool) {
    _tools.set(tool.name, tool);
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
    return tool.handler(args, context);
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

function oversizedFileMessage(path, size, maxBytes) {
  return [
    `Refusing to read ${path}: file is ${formatBytes(size)}, which exceeds the read_file safety limit of ${formatBytes(maxBytes)}.`,
    'Use list_files to inspect metadata, or use execute_command with a targeted command such as sed/head/tail to read a smaller range.',
  ].join('\n');
}

function splitParentPath(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  const name = parts.pop() || '';
  return { parent: parts.join('/'), name };
}

async function findListedFile(path, ctx) {
  const { parent, name } = splitParentPath(path);
  const listing = ctx?.agentId && !ctx?.agentUrl
    ? await listAgentFiles(ctx.agentId, parent)
    : await listFiles(parent, ctx?.agentUrl);
  const entries = Array.isArray(listing) ? listing : listing?.children;
  return entries?.find((entry) => entry.name === name) || null;
}

async function assertReadableFileSize(path, maxBytes, ctx) {
  const entry = ctx?.agentId && !ctx?.agentUrl
    ? await getAgentFileInfo(ctx.agentId, path).catch(() => null)
    : await findListedFile(path, ctx).catch(() => null);

  if (!entry) return null;
  if (entry.type === 'directory') return `Cannot read ${path}: it is a directory.`;
  if (Number.isFinite(entry.size) && entry.size > maxBytes) {
    return oversizedFileMessage(path, entry.size, maxBytes);
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

async function readAgentImageBlob(path, ctx) {
  if (ctx?.agentId && !ctx?.agentUrl) {
    return readAgentFileBlob(ctx.agentId, path);
  }
  if (ctx?.agentUrl === E2B_AGENT_ID) {
    return downloadE2bFile(path);
  }
  return downloadRemoteFile(path, ctx?.agentUrl);
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
  schema: {
    description:
      'Execute a shell command on the selected sandbox host. Commands run in that host OS shell, so use syntax appropriate for the returned platform/shell.',
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
  name: 'read_file',
  schema: {
    description:
      'Read the contents of a file from the active agent file root. Use this to examine files, check configuration, or inspect source code.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to read, relative to the agent file root',
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
  checkAvailable: (ctx) => !!ctx?.agentUrl || !!ctx?.agentId,
  async handler({ path, max_bytes: maxBytesArg }, ctx) {
    try {
      const maxBytes = clampReadLimit(maxBytesArg);
      const sizeError = await assertReadableFileSize(path, maxBytes, ctx);
      if (sizeError) return sizeError;

      if (ctx?.agentId && !ctx?.agentUrl) {
        // Local browser mode: read from agent workspace
        const content = await readAgentFile(ctx.agentId, path);
        return content ?? `File not found: ${path}`;
      }
      // Remote sandbox mode
      const content = await readFileText(path, ctx.agentUrl);
      const contentSize = new Blob([content]).size;
      if (contentSize > maxBytes) {
        return oversizedFileMessage(path, contentSize, maxBytes);
      }
      return content;
    } catch (err) {
      return `Error reading file ${path}: ${err.message}`;
    }
  },
});

registry.register({
  name: 'read_image_file',
  schema: {
    description:
      'Read an image from the active agent file root, resize it to a vision-model-friendly size, and return a compact data URL with image metadata. Use this instead of read_file for png, jpg, jpeg, webp, gif, svg, or bmp files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the image file to read, relative to the agent file root',
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
  checkAvailable: (ctx) => !!ctx?.agentUrl || !!ctx?.agentId,
  async handler({ path, max_dimension: maxDimension, quality, output_format: outputFormat, max_source_bytes: maxSourceBytes }, ctx) {
    try {
      const blob = await readAgentImageBlob(path, ctx);
      return await readImageToolResult(path, blob, {
        maxDimension,
        quality,
        outputFormat,
        maxSourceBytes,
      });
    } catch (err) {
      return `Error reading image file ${path}: ${err.message}`;
    }
  },
});

registry.register({
  name: 'write_file',
  schema: {
    description:
      'Write content to a file in the active agent file root. Creates the file if it does not exist, overwrites if it does.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to write, relative to the agent file root',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  checkAvailable: (ctx) => !!ctx?.agentUrl || !!ctx?.agentId,
  async handler({ path, content }, ctx) {
    try {
      if (ctx?.agentId && !ctx?.agentUrl) {
        // Local browser mode: write to agent workspace
        await writeAgentFile(ctx.agentId, path, content);
        return `Successfully wrote to ${path}`;
      }
      // Remote sandbox mode
      await writeFile(path, content, ctx.agentUrl);
      return `Successfully wrote to ${path}`;
    } catch (err) {
      return `Error writing file ${path}: ${err.message}`;
    }
  },
});

registry.register({
  name: 'list_files',
  schema: {
    description:
      'List files and directories in the active agent file root. Use this to explore directory contents.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to list, relative to the agent file root (empty for root)',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  checkAvailable: (ctx) => !!ctx?.agentUrl || !!ctx?.agentId,
  async handler({ path = '' }, ctx) {
    try {
      if (ctx?.agentId && !ctx?.agentUrl) {
        // Local browser mode: list from agent workspace
        const result = await listAgentFiles(ctx.agentId, path);
        return formatFileTree(result, 0);
      }
      // Remote sandbox mode
      const result = await listFiles(path, ctx.agentUrl);
      return formatFileTree(result, 0);
    } catch (err) {
      return `Error listing files: ${err.message}`;
    }
  },
});

registry.register({
  name: 'list_local_files',
  schema: {
    description:
      'List files and directories stored in the browser (OPFS). Use this to see locally saved files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Subdirectory path to list (empty for root)',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  async handler({ path = '' }, ctx) {
    try {
      if (ctx?.agentId) {
        // Agent workspace: list from agent's files dir
        const result = await listAgentFiles(ctx.agentId, path);
        return formatFileTree(result, 0);
      }
      // Fall back to global files dir
      const result = await loadFiles(path || undefined);
      return formatFileTree(result.children || result, 0);
    } catch (err) {
      return `Error listing local files: ${err.message}`;
    }
  },
});

registry.register({
  name: 'read_local_file',
  schema: {
    description:
      'Read the contents of a file stored in the browser (OPFS). Use this to examine locally saved files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file (relative to OPFS root)',
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
  async handler({ path, max_bytes: maxBytesArg }, ctx) {
    try {
      const maxBytes = clampReadLimit(maxBytesArg);
      if (ctx?.agentId) {
        // Agent workspace: read from agent's files dir
        const fileInfo = await getAgentFileInfo(ctx.agentId, path).catch(() => null);
        if (fileInfo?.size > maxBytes) {
          return oversizedFileMessage(path, fileInfo.size, maxBytes);
        }
        const content = await readAgentFile(ctx.agentId, path);
        return content ?? `File not found: ${path}`;
      }
      // Fall back to global files dir
      const file = await readPathBlob(path);
      if (file.size > maxBytes) {
        return oversizedFileMessage(path, file.size, maxBytes);
      }
      return file.text();
    } catch (err) {
      return `Error reading local file ${path}: ${err.message}`;
    }
  },
});

registry.register({
  name: 'read_local_image',
  schema: {
    description:
      'Read an image stored in the browser (OPFS), resize it to a vision-model-friendly size, and return a compact data URL with image metadata. Use this instead of read_local_file for png, jpg, jpeg, webp, gif, svg, or bmp files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the image file relative to OPFS root',
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
  async handler({ path, max_dimension: maxDimension, quality, output_format: outputFormat, max_source_bytes: maxSourceBytes }, ctx) {
    try {
      const blob = ctx?.agentId
        ? await readAgentFileBlob(ctx.agentId, path)
        : await readPathBlob(path);
      return await readImageToolResult(path, blob, {
        maxDimension,
        quality,
        outputFormat,
        maxSourceBytes,
      });
    } catch (err) {
      return `Error reading local image ${path}: ${err.message}`;
    }
  },
});

// Memory tools — these are intercepted before dispatch since they need memory state
registry.register({
  name: 'write_memory',
  schema: {
    description:
      'Write a note to your memory. Use this to record important information about the environment, project conventions, tool quirks, or user preferences that should be remembered across sessions.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description:
            'The memory entry to save. Keep it concise and informative.',
        },
        type: {
          type: 'string',
          enum: ['memory', 'user'],
          description:
            'Type of memory: "memory" for project/environment notes, "user" for user profile and preferences',
        },
      },
      required: ['content', 'type'],
      additionalProperties: false,
    },
  },
  async handler({ content, type }, ctx) {
    try {
      const agentId = ctx?.agentId;
      if (type === 'user') {
        await saveUser(content, agentId);
        return `Saved to USER.md (${content.length}/${USER_MAX} chars)`;
      }
      await saveMemory(content, agentId);
      return `Saved to MEMORY.md (${content.length}/${MEMORY_MAX} chars)`;
    } catch (err) {
      return `Error saving memory: ${err.message}`;
    }
  },
});

registry.register({
  name: 'read_memory',
  schema: {
    description:
      'Read your current memory notes and user profile. Use this to recall previously saved information.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['memory', 'user', 'both'],
          description: 'Which memory to read: "memory", "user", or "both"',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  async handler({ type = 'both' }, ctx) {
    const data = await loadMemory(ctx?.agentId);
    if (type === 'memory') return data.memory || 'MEMORY.md is empty.';
    if (type === 'user') return data.user || 'USER.md is empty.';
    let out = '';
    if (data.memory) out += `=== MEMORY.md ===\n${data.memory}\n\n`;
    if (data.user) out += `=== USER.md ===\n${data.user}\n`;
    return out || 'Both memory files are empty.';
  },
});

registry.register({
  name: 'clear_memory',
  schema: {
    description:
      'Clear all memory notes. Use this with caution — this cannot be undone.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['memory', 'user', 'both'],
          description: 'Which memory to clear',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  async handler({ type = 'both' }, ctx) {
    await clearMemory(type, ctx?.agentId);
    return `Cleared ${type === 'both' ? 'all memory' : type === 'memory' ? 'MEMORY.md' : 'USER.md'}.`;
  },
});

// Skill tools — intercepted before dispatch
registry.register({
  name: 'skills_list',
  schema: {
    description: 'List all available skills with their names and descriptions. Skills provide specialized knowledge and procedures for specific tasks.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  async handler(_args, ctx) {
    const skills = await listSkills(ctx?.agentId);
    if (skills.length === 0)
      return 'No skills installed. Use the skill_manage tool to create one.';
    return skills
      .map((s) => `- **${s.name}**: ${s.description}`)
      .join('\n');
  },
});

registry.register({
  name: 'skill_view',
  schema: {
    description:
      'Load the full instructions for a skill. Use this when you need detailed procedures for a specific task.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The skill name (exact match)',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  async handler({ name }, ctx) {
    const skill = await getSkill(name, ctx?.agentId);
    if (!skill) return `Skill "${name}" not found.`;
    return skill.content;
  },
});

registry.register({
  name: 'skill_manage',
  schema: {
    description:
      'Create, update, or delete skills. Use this to manage your skill library.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'delete'],
          description: 'Action to perform',
        },
        name: {
          type: 'string',
          description: 'Skill name (identifier, no spaces)',
        },
        content: {
          type: 'string',
          description:
            'SKILL.md content (required for create/update). Include YAML frontmatter with name, description, version.',
        },
      },
      required: ['action', 'name'],
      additionalProperties: false,
    },
  },
  async handler({ action, name, content }, ctx) {
    try {
      const agentId = ctx?.agentId;
      if (action === 'create') {
        if (!content) return 'Error: content is required for create.';
        await createSkill(name, content, agentId);
        return `Skill "${name}" created.`;
      }
      if (action === 'update') {
        if (!content) return 'Error: content is required for update.';
        await updateSkill(name, content, agentId);
        return `Skill "${name}" updated.`;
      }
      if (action === 'delete') {
        await deleteSkill(name, agentId);
        return `Skill "${name}" deleted.`;
      }
      return `Unknown action: ${action}`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },
});

registry.register({
  name: 'spawn_agent',
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
    return node.map((f) => `${'  '.repeat(depth)}${f.type === 'directory' ? '📁' : '📄'} ${f.name}`).join('\n');
  }
  if (!node || !node.children) return '(empty)';
  const indent = '  '.repeat(depth);
  return node.children
    .map((child) => {
      const icon = child.type === 'directory' ? '📁' : '📄';
      let line = `${indent}${icon} ${child.name}`;
      if (child.children?.length) {
        line += '\n' + formatFileTree(child, depth + 1);
      }
      return line;
    })
    .join('\n');
}

const SUB_AGENT_SYSTEM_PROMPT = `You are a delegated VertexAgent agent run.

Work on the assigned task independently and return a concise final report with:
- What you did or found
- Files you changed, if any
- Any blockers, risks, or follow-up needed

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
