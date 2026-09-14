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
  isSkillEnabled,
  readSkill,
  searchSkills,
  writeSkill,
  writeSkillReference,
} from './skills.js';
import { wakeupDelayToSeconds } from './wakeup.js';
import { truncateMiddle } from './toolObservation.js';
import { formatSkills } from './skillCore.js';
import {
  ABSOLUTE_READ_FILE_MAX_BYTES,
  DEFAULT_READ_FILE_MAX_BYTES,
  TOOL_PARAMETER_SCHEMAS,
  formatCommandResult,
} from './toolSchemas.js';
import { formatBytes, imageMimeFromPath, splitFilePath } from '../utils/misc.js';
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
  proxyWebFetch,
  proxyWebSearch,
} from '../models/agent.js';
import {
  fetchWebPage,
  formatWebPageForModel,
} from './webFetch.js';
import search, {
  formatSearchResults,
  runWebSearch,
} from '../models/search.js';
import {
  getAgentFileInfo,
  listAgentFiles,
  readAgentFile,
  writeAgentFile,
} from '../vfs/opfs.js';
import config from '../config/config.js';
import llm from '../models/llm.js';
import { getAgent, listAgents } from '../agents/agents.js';

const ABSOLUTE_IMAGE_MAX_SOURCE_BYTES = 25 * 1024 * 1024;
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
  return truncateMiddle(text, TOOL_RESULT_MAX_CHARS, 'tool result truncated');
}

// ─── Built-in tools ─────────────────────────────────────────────────────────

function clampReadLimit(maxBytes) {
  const parsed = Number(maxBytes);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_READ_FILE_MAX_BYTES;
  return Math.min(Math.floor(parsed), ABSOLUTE_READ_FILE_MAX_BYTES);
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

async function findSandboxListedFile(path, ctx) {
  const { parent, name } = splitFilePath(path);
  const listing = await listFiles(parent, ctx?.agentUrl, { signal: ctx?.signal });
  const entries = Array.isArray(listing) ? listing : listing?.children;
  return entries?.find((entry) => entry.name === name) || null;
}

function rethrowIfToolAborted(error, signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

/** Web tools can route through a real agent server; E2B exposes no proxy. */
function canProxyThroughAgentServer(ctx) {
  return Boolean(ctx?.agentUrl && ctx.agentUrl !== E2B_AGENT_ID);
}

async function assertReadableFileSize(path, maxBytes, lookupEntry, readToolName, listToolName) {
  const entry = await lookupEntry().catch(() => null);

  if (!entry) return null;
  if (entry.type === 'directory') return `Cannot read ${path}: it is a directory.`;
  if (Number.isFinite(entry.size) && entry.size > maxBytes) {
    return oversizedFileMessage(path, entry.size, maxBytes, readToolName, listToolName);
  }
  return null;
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
    parameters: TOOL_PARAMETER_SCHEMAS.execute_command,
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
    return formatCommandResult(result);
  },
});

const managedCommandAvailable = (ctx) => !!ctx?.agentUrl && ctx.agentUrl !== E2B_AGENT_ID;

registry.register({
  name: 'start_command',
  category: 'shell',
  schema: {
    description:
      'Start a managed BACKGROUND shell command and return immediately with a job_id, WITHOUT waiting. Use this only when the turn must not block on the job now — a server, watcher, or other work whose result a later get_command/wait_command call or a schedule_wakeup continuation will consume. When you want to run a long command and report its result, call wait_command with the command instead: it starts the job and waits in one call. Do not add nohup, &, disown, screen, tmux, or shell timeout wrappers; the server owns the process, logs, and cancellation.',
    parameters: TOOL_PARAMETER_SCHEMAS.start_command,
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
    parameters: TOOL_PARAMETER_SCHEMAS.get_command,
  },
  checkAvailable: managedCommandAvailable,
  async handler({ job_id: jobId, cursor = 0 }, ctx) {
    return JSON.stringify(await getCommand(jobId, ctx.agentUrl, cursor, ctx?.signal), null, 2);
  },
});

registry.register({
  name: 'wait_command',
  category: 'shell',
  schema: {
    description:
      'Start a managed background command and wait for it in ONE call: pass the command (foreground form, no & or nohup) and this call starts the job, blocks until it finishes or emits logs, and returns the full result including job_id and nextCursor. Or pass job_id (with cursor from the previous result) to keep waiting on an existing job. Returns early on completion or new output, so size wait_seconds (default 30, at most 7 days) to the expected remaining time instead of a tight loop of short re-waits; the user sees the remaining wait time while it runs. Use start_command instead only when the turn must not wait now (fire-and-forget, or a schedule_wakeup continuation will check the job later).',
    parameters: TOOL_PARAMETER_SCHEMAS.wait_command,
  },
  checkAvailable: managedCommandAvailable,
  async handler({ command, job_id: jobId, cursor = 0, wait_seconds: waitSeconds = 30 }, ctx) {
    if (command && jobId) {
      throw new Error('wait_command: pass either command (start a new job and wait) or job_id (wait on an existing job), not both.');
    }
    if (command) {
      const job = await startCommand(command, ctx.agentUrl, ctx?.signal);
      return JSON.stringify(await waitCommand(job.job_id, ctx.agentUrl, {
        cursor: 0,
        waitMs: waitSeconds * 1000,
        signal: ctx?.signal,
      }), null, 2);
    }
    if (!jobId) {
      throw new Error('wait_command: pass command (start a new job and wait) or job_id (wait on an existing job).');
    }
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
    parameters: TOOL_PARAMETER_SCHEMAS.stop_command,
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
      const sizeError = await assertReadableFileSize(
        path, maxBytes, () => getAgentFileInfo(ctx.agentId, path), 'read_browser_file', 'list_browser_files'
      );
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
      const mimeType = info.type || imageMimeFromPath(path);
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
  name: 'list_sandbox_files',
  category: 'sandbox-files',
  readOnly: true,
  parallelSafe: true,
  schema: {
    description:
      'List files in the sandbox runtime workdir used by command tools. This is NOT browser OPFS or workspace/<active-agent>/files/. Use the skill tool, not generic file tools, for skills/. Other browser-owned files are unavailable unless explicitly copied.',
    parameters: TOOL_PARAMETER_SCHEMAS.list_sandbox_files,
  },
  checkAvailable: (ctx) => !!ctx?.agentUrl,
  async handler({ path = '' }, ctx) {
    try {
      const result = await listFiles(path, ctx.agentUrl, { signal: ctx.signal });
      return formatFileTree(result, 0);
    } catch (err) {
      rethrowIfToolAborted(err, ctx.signal);
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
    parameters: TOOL_PARAMETER_SCHEMAS.read_sandbox_file,
  },
  checkAvailable: (ctx) => !!ctx?.agentUrl,
  async handler({ path, max_bytes: maxBytesArg }, ctx) {
    try {
      const maxBytes = clampReadLimit(maxBytesArg);
      const sizeError = await assertReadableFileSize(
        path, maxBytes, () => findSandboxListedFile(path, ctx), 'read_sandbox_file', 'list_sandbox_files'
      );
      if (sizeError) return sizeError;
      const content = await readFileText(path, ctx.agentUrl, { signal: ctx.signal });
      const contentSize = new Blob([content]).size;
      if (contentSize > maxBytes) {
        return oversizedFileMessage(path, contentSize, maxBytes, 'read_sandbox_file', 'list_sandbox_files');
      }
      return content;
    } catch (err) {
      rethrowIfToolAborted(err, ctx.signal);
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
    parameters: TOOL_PARAMETER_SCHEMAS.display_sandbox_image,
  },
  checkAvailable: (ctx) => !!ctx?.agentUrl,
  async handler({ path }, ctx) {
    try {
      const entry = await findSandboxListedFile(path, ctx);
      if (!entry || entry.type === 'directory') return `Sandbox image not found: ${path}`;
      const mimeType = imageMimeFromPath(path);
      if (!isSupportedImageMime(mimeType)) return `Unsupported image type: ${mimeType || 'unknown'}`;
      if (Number.isFinite(entry.size) && entry.size > ABSOLUTE_IMAGE_MAX_SOURCE_BYTES) {
        return `Refusing to display image ${path}: file is ${formatBytes(entry.size)}, above ${formatBytes(ABSOLUTE_IMAGE_MAX_SOURCE_BYTES)}.`;
      }
      return imageReferenceResult('sandbox', path, { name: entry.name, mimeType, size: entry.size });
    } catch (err) {
      rethrowIfToolAborted(err, ctx.signal);
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
    parameters: TOOL_PARAMETER_SCHEMAS.write_sandbox_file,
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
  name: 'web_search',
  category: 'web',
  readOnly: true,
  parallelSafe: true,
  schema: {
    description:
      'Search the web and return compact results: title, URL, and a short snippet per result — never full page content. Use it whenever a question needs current or otherwise external information instead of guessing. After answering from results, cite the used sources as markdown links. When a snippet is not enough, call web_fetch on the result URL to read the full page.',
    parameters: TOOL_PARAMETER_SCHEMAS.web_search,
  },
  checkAvailable: () => search.isConfigured(),
  async handler(args, ctx) {
    const runtimeConfig = search.getRuntimeConfig();
    if (!runtimeConfig) {
      return 'Web search is not configured. Set up a search provider in Settings → Web Search.';
    }
    try {
      const result = await runWebSearch(runtimeConfig, args, { signal: ctx?.signal });
      return formatSearchResults(result);
    } catch (err) {
      rethrowIfToolAborted(err, ctx?.signal);
      // Some providers (notably self-hosted SearXNG) are not CORS-reachable
      // from the browser. Retry through the authenticated agent server before
      // giving up; if that also fails, the direct error is the clearer one.
      if (canProxyThroughAgentServer(ctx)) {
        try {
          const proxied = await proxyWebSearch(ctx.agentUrl, runtimeConfig, args, ctx?.signal);
          return formatSearchResults(proxied);
        } catch (proxyErr) {
          rethrowIfToolAborted(proxyErr, ctx?.signal);
        }
      }
      return `Web search error: ${err.message}`;
    }
  },
});

registry.register({
  name: 'web_fetch',
  category: 'web',
  readOnly: true,
  parallelSafe: true,
  schema: {
    description:
      'Fetch one web page and return its readable text. HTML is converted to text with headings and links preserved; binary content (images, PDFs, archives) is rejected. http URLs are upgraded to https and only http(s) is supported. Successful fetches are cached for a short time, so re-reading a URL is cheap. Prefer this over shell curl for reading public pages.',
    parameters: TOOL_PARAMETER_SCHEMAS.web_fetch,
  },
  async handler({ url, max_chars: maxChars }, ctx) {
    try {
      if (canProxyThroughAgentServer(ctx)) {
        try {
          const page = await proxyWebFetch(ctx.agentUrl, url, {
            maxChars,
            signal: ctx?.signal,
          });
          return formatWebPageForModel(page);
        } catch (err) {
          rethrowIfToolAborted(err, ctx?.signal);
          // Proxy transport failures (old server without the endpoint,
          // server offline) fall through to a direct browser fetch, which
          // still works for CORS-enabled sites.
        }
      }
      const page = await fetchWebPage(url, {
        maxChars,
        signal: ctx?.signal,
      });
      return formatWebPageForModel(page);
    } catch (err) {
      rethrowIfToolAborted(err, ctx?.signal);
      return `Error fetching ${url}: ${err.message}`;
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
  schema: {
    description:
      'List and read progressive skills merged from OPFS global skills, the active OPFS workspace, and the selected agent skills, in that precedence order. Later same-named skills override earlier ones. In browser runtime, write always creates or updates a skill in the active OPFS workspace. Read references individually only when needed.',
    parameters: TOOL_PARAMETER_SCHEMAS.skill,
  },
  async handler(args, ctx) {
    try {
      const agentId = ctx?.agentId;
      if (args.action === 'list') {
        const skills = await searchSkills(args.query || '', agentId, {
          agentUrl: ctx?.agentUrl,
          signal: ctx?.signal,
        });
        return formatSkills(skills);
      }
      if (args.action === 'read') {
        if (!args.name) return 'Skill error: name is required for read.';
        if (!(await isSkillEnabled(args.name))) {
          return `Skill is disabled: ${args.name}`;
        }
        const content = await readSkill(args.name, agentId, {
          referenceName: args.reference_name,
          agentUrl: ctx?.agentUrl,
          signal: ctx?.signal,
        });
        return content ?? `Skill or reference not found: ${args.name}${args.reference_name ? `/${args.reference_name}` : ''}`;
      }
      if (args.action === 'write') {
        if (!args.name) return 'Skill error: name is required for write.';
        if (!args.content?.trim()) return 'Skill error: content is required for write.';
        if (!agentId) return 'Skill error: write requires an active agent workspace.';
        if (args.reference_name) {
          const referenceName = await writeSkillReference(
            args.name,
            args.reference_name,
            args.content,
            agentId
          );
          return `Successfully wrote skill reference ${args.name}/${referenceName}.`;
        }
        const skillName = await writeSkill(args.name, args.content, agentId);
        return `Successfully wrote skill ${skillName}.`;
      }
      return `Unknown skill action: ${args.action}`;
    } catch (err) {
      rethrowIfToolAborted(err, ctx?.signal);
      return `Skill error: ${err.message}`;
    }
  },
});

registry.register({
  name: 'schedule_wakeup',
  category: 'automation',
  schema: {
    description:
      'Schedule one future continuation of the current conversation. Express the delay in its natural unit; do not convert minutes or hours to seconds (for example, 10 minutes is delay=10 and unit="minutes"). Use this instead of blocking or repeatedly polling during a long-running task. When the delay expires, the saved prompt is added to this conversation and the agent runs again. If the task is still pending after waking, schedule another wake-up. The browser page must be open to fire on time; an overdue wake-up fires once when the app is opened again.',
    parameters: TOOL_PARAMETER_SCHEMAS.schedule_wakeup,
  },
  checkAvailable: (ctx) => typeof ctx?.scheduleWakeup === 'function',
  async handler({ delay, unit, prompt }, ctx) {
    const delaySeconds = wakeupDelayToSeconds(delay, unit);
    const wakeup = await ctx.scheduleWakeup({ delaySeconds, prompt });
    return JSON.stringify({
      scheduled: true,
      wakeup_id: wakeup.id,
      delay: { value: delay, unit },
      delay_seconds: delaySeconds,
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
      'Run one or more focused tasks through existing agent workspaces and return one result per task; a failed task never cancels or hides its siblings. Tasks assigned to the same agent run sequentially to protect that workspace, while different agent workspaces run in parallel. If no agent_id or agent_name is provided, run as the current/default agent. A delegated agent uses its own configured model profile when it has one, otherwise the caller profile. This tool cannot create new agents. For multiple related tasks, send them in one call with shared_context so requests share the same prompt prefix for better provider cache hits.',
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
    const requestedTasks = normalizeSpawnTasks({ task, tasks, agentId, agentName });
    if (requestedTasks.length === 0) {
      return 'Error running delegated agent task: provide task or tasks.';
    }
    const boundedRounds = Math.min(Math.max(Number(maxRounds) || 4, 1), 6);
    const results = await runSpawnedAgents(requestedTasks, sharedContext, boundedRounds, ctx);
    return results.join('\n\n---\n\n');
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

const SUB_AGENT_SYSTEM_PROMPT = `You are a delegated CherryAgent agent run.

Work on the assigned task independently and return a concise final report with:
- What you did or found
- Files you changed, if any
- Any blockers, risks, or follow-up needed

Filesystem model:
- Browser OPFS is the durable agent storage backend, but browser file tools can only access workspace/<active-agent>/files/.
- Browser file tools cannot access OPFS root, other agents, AGENTS.md, memory, or skills by path.
- The skill tool merges OPFS global skills, active OPFS workspace skills, then selected agent skills. Browser-runtime writes always go to the active OPFS workspace skills directory.
- The sandbox filesystem is the selected agent runtime workdir and remains separate from browser OPFS outside the skill catalog.
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

async function runSpawnedAgents(requestedTasks, sharedContext, maxRounds, ctx) {
  const entries = await Promise.all(requestedTasks.map(async (item, index) => {
    try {
      return { index, item, agent: await resolveSpawnAgent(item, ctx) };
    } catch (err) {
      return { index, item, error: err };
    }
  }));

  const results = new Array(entries.length);
  const groups = new Map();
  for (const entry of entries) {
    if (entry.error) {
      results[entry.index] = spawnFailureResult(entry.item, ctx, entry.error);
      continue;
    }
    const group = groups.get(entry.agent.id) || [];
    group.push(entry);
    groups.set(entry.agent.id, group);
  }

  // Tasks sharing one agent workspace run sequentially so their file and
  // memory writes cannot race; distinct workspaces stay parallel.
  await Promise.allSettled(Array.from(groups.values()).map(async (group) => {
    for (const entry of group) {
      if (ctx.signal?.aborted) {
        results[entry.index] = spawnFailureResult(entry.item, ctx, new DOMException('Aborted', 'AbortError'));
        continue;
      }
      try {
        results[entry.index] = await runSpawnedAgent(entry, entries.length, sharedContext, maxRounds, ctx);
      } catch (err) {
        results[entry.index] = spawnFailureResult(entry.item, ctx, err);
      }
    }
  }));

  return results.map((result, index) => (
    result || spawnFailureResult(entries[index].item, ctx, new Error('Delegated agent run did not complete.'))
  ));
}

async function resolveSpawnAgent(item, ctx) {
  if (item.agentId) {
    const agent = await getAgent(item.agentId);
    if (!agent) throw new Error(`Agent not found: ${item.agentId}`);
    return agent;
  }
  if (item.agentName) {
    const agents = await listAgents();
    const matches = agents.filter((agent) => agent.name === item.agentName);
    if (matches.length === 0) throw new Error(`Agent not found: ${item.agentName}`);
    if (matches.length > 1) {
      throw new Error(
        `Multiple agents are named "${item.agentName}" (${matches.map((agent) => agent.id).join(', ')}). Pass agent_id to select one.`
      );
    }
    return matches[0];
  }
  const agent = await getAgent(ctx.agentId);
  if (!agent) throw new Error(`Current agent not found: ${ctx.agentId}`);
  return agent;
}

function spawnTaskLabel(item, ctx) {
  if (item.agentId) return item.agentId;
  if (item.agentName) return item.agentName;
  return ctx?.agentName || 'the current agent';
}

function spawnFailureResult(item, ctx, err) {
  return `Delegated agent task for ${spawnTaskLabel(item, ctx)} failed: ${err?.message || String(err)}`;
}

async function runSpawnedAgent(entry, total, sharedContext, maxRounds, ctx) {
  const { runAgentLoop } = await import('./loop.js');
  const subAgent = entry.agent;
  const profile = resolveSpawnProfile(subAgent, ctx);
  const messages = buildSubAgentMessages(sharedContext, entry.item.task, entry.index, total);

  const result = await runAgentLoop({
    messages,
    systemPrompt: SUB_AGENT_SYSTEM_PROMPT,
    agentUrl: ctx.agentUrl || null,
    agentId: subAgent.id,
    llmProfileId: profile.llmProfileId,
    provider: profile.provider,
    model: profile.model,
    contextWindow: profile.contextWindow,
    signal: ctx.signal,
    maxRounds,
    subAgentDepth: (ctx.subAgentDepth || 0) + 1,
    onEvent: createSpawnProgressReporter(subAgent, ctx),
    // Delegate approval to the same interactive channel the parent uses.
    onPermissionRequest: ctx.onPermissionRequest,
  });

  ctx.recordSubAgentUsage?.(result.usage);

  const toolSummary = result.toolCalls?.length
    ? `\n\nAgent tool calls:\n${result.toolCalls.map((tc) => `- ${tc.name}: ${tc.status}`).join('\n')}`
    : '';

  return `Agent ${subAgent.name} (${subAgent.id}) completed.\n\n${result.content || '(no final content)'}${toolSummary}`;
}

/**
 * A delegated agent keeps its own configured model profile when it has a
 * usable one; otherwise it inherits the caller's frozen profile.
 */
function resolveSpawnProfile(subAgent, ctx) {
  const fallback = {
    llmProfileId: ctx.llmProfileId,
    provider: ctx.provider,
    model: ctx.model,
    contextWindow: ctx.contextWindow,
  };
  const ownProfileId = subAgent?.llmProfileId;
  if (!ownProfileId || ownProfileId === ctx.llmProfileId) return fallback;
  const profile = llm.getActiveConfig(ownProfileId);
  if (!profile?.id || !profile.configured) return fallback;
  return {
    llmProfileId: ownProfileId,
    provider: profile.provider || ctx.provider,
    model: profile.model || ctx.model,
    contextWindow: profile.contextWindow || ctx.contextWindow,
  };
}

function createSpawnProgressReporter(subAgent, ctx) {
  if (typeof ctx.onToolUpdate !== 'function') return undefined;
  return (event) => {
    let line = null;
    if (event.type === 'tool-call') {
      line = `[${subAgent.name}] tool ${event.toolName}${event.summary ? ` (${event.summary})` : ''}`;
    } else if (event.type === 'run-finish') {
      line = `[${subAgent.name}] finished (${event.modelCallCount || 1} model calls)`;
    } else if (event.type === 'run-error') {
      line = `[${subAgent.name}] error: ${event.error?.message || 'unknown error'}`;
    }
    if (line) ctx.onToolUpdate({ stdout: `${line}\n` });
  };
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
