import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLanguageModel } from '../src/models/ai.js';
import { runAgentLoop } from '../src/agent/loop.js';
import { buildWakeupMessage, createWakeup } from '../src/agent/wakeup.js';

const MAX_MESSAGES = 2_000;
const MAX_EVENT_BYTES = 20 * 1024 * 1024;
const MAX_RUNTIME_FILES = 500;
const MAX_RUNTIME_FILE_BYTES = 256 * 1024;
const MAX_RUNTIME_FILES_BYTES = 10 * 1024 * 1024;
const MAX_SANDBOX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_SANDBOX_IMAGES_BYTES = 64 * 1024 * 1024;
const SANDBOX_ATTACHMENTS_MARKER = 'Sandbox attachment files (available to shell commands and sandbox file tools):';

const REMOTE_TOOL_SCHEMAS = [
  {
    name: 'execute_command',
    description: 'Execute a shell command inside the sandbox runtime. The browser, browser OPFS, and browser files are not available.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Shell command to execute.' } },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_sandbox_files',
    description: 'List files in the sandbox runtime. Browser files are not available.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory relative to the sandbox workspace.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'read_sandbox_file',
    description: 'Read a UTF-8 text file from the sandbox runtime.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'display_sandbox_image',
    description: 'Display an image from the sandbox runtime in the browser conversation UI. Returns only a file reference; image bytes and base64 are never included in the conversation.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Image path relative to the sandbox workspace.' },
        alt: { type: 'string', description: 'Short accessible description of the image.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_sandbox_file',
    description: 'Write a UTF-8 text file in the sandbox runtime.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'schedule_wakeup',
    description: 'Schedule one future continuation of this sandbox agent run. Use this instead of blocking or repeatedly polling. The agent server waits without using LLM tokens, then continues with the saved prompt. If the task is still pending after waking, schedule another wake-up.',
    parameters: {
      type: 'object',
      properties: {
        delay_seconds: {
          type: 'integer',
          minimum: 5,
          maximum: 604800,
          description: 'Seconds from now to continue, from 5 seconds through 7 days.',
        },
        prompt: {
          type: 'string',
          description: 'A self-contained instruction describing what to inspect or continue after waking.',
        },
      },
      required: ['delay_seconds', 'prompt'],
      additionalProperties: false,
    },
  },
];

export function createAgentRunManager({ runsDir, execCommand, listFiles, readFile, writeFile, fileExists }) {
  mkdirSync(runsDir, { recursive: true });
  const runs = new Map();
  loadPersistedRuns(runsDir, runs);

  const persist = (run) => {
    const publicRun = serializeRun(run);
    const target = join(runsDir, `${run.id}.json`);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, JSON.stringify(publicRun, null, 2), 'utf8');
    renameSync(temporary, target);
  };

  const emit = (run, event) => {
    run.sequence += 1;
    const stored = { ...event, remoteSequence: run.sequence };
    run.events.push(stored);
    run.updatedAt = new Date().toISOString();
    const eventPath = join(runsDir, `${run.id}.events.ndjson`);
    const line = `${JSON.stringify(stored)}\n`;
    const lineBytes = Buffer.byteLength(line);
    if (run.eventBytes + lineBytes <= MAX_EVENT_BYTES) {
      appendFileSync(eventPath, line, 'utf8');
      run.eventBytes += lineBytes;
    }
  };

  const dispatchTool = createRuntimeToolDispatcher({ execCommand, listFiles, readFile, writeFile });

  const start = (input) => {
    validateRunInput(input);
    const id = `run-${randomUUID()}`;
    const run = {
      id,
      sessionId: String(input.sessionId),
      replyId: input.replyId ? String(input.replyId) : null,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sequence: 0,
      events: [],
      result: null,
      error: null,
      controller: new AbortController(),
      eventBytes: 0,
    };
    runs.set(id, run);
    persist(run);

    Promise.resolve().then(async () => {
      try {
        await materializeRuntimeFiles(input.runtimeContext?.sandboxFiles, { fileExists, readFile, writeFile });
        let runtimeMessages = await materializeMessageImages(input.messages, { fileExists, writeFile });
        const modelConfig = input.modelConfig;
        let result;
        while (true) {
          let scheduledWakeup = null;
          result = await runAgentLoop({
            messages: runtimeMessages,
            systemPrompt: input.systemPrompt || '',
            agentId: input.agentId || null,
            provider: modelConfig.provider,
            model: modelConfig.model,
            contextWindow: modelConfig.contextWindow || undefined,
            maxRounds: input.maxRounds,
            signal: run.controller.signal,
            languageModel: createLanguageModel(modelConfig),
            runtimeContext: normalizeRuntimeContext(input.runtimeContext),
            toolSchemas: REMOTE_TOOL_SCHEMAS,
            dispatchTool,
            scheduleWakeup: async ({ delaySeconds, prompt }) => {
              if (scheduledWakeup) throw new Error('Only one wake-up can be scheduled per agent turn.');
              scheduledWakeup = createWakeup({
                id: `wake-${randomUUID()}`,
                delaySeconds,
                prompt,
              });
              return scheduledWakeup;
            },
            autoSummarize: false,
            runtimeMode: 'sandbox',
            onEvent: (event) => emit(run, event),
          });

          run.result = result;
          if (!scheduledWakeup) break;

          run.status = 'waiting';
          run.wakeup = scheduledWakeup;
          run.updatedAt = new Date().toISOString();
          persist(run);
          await waitForWakeup(scheduledWakeup.runAtMs, run.controller.signal);

          run.status = 'running';
          run.wakeup = null;
          run.updatedAt = new Date().toISOString();
          persist(run);
          runtimeMessages = [
            ...runtimeMessages,
            { role: 'assistant', content: result.content || 'A future continuation was scheduled.' },
            { role: 'user', content: buildWakeupMessage(scheduledWakeup) },
          ];
          if (runtimeMessages.length > MAX_MESSAGES) throw new Error('Scheduled run exceeded the message limit.');
        }
        run.status = 'completed';
        run.result = result;
      } catch (error) {
        run.status = error?.name === 'AbortError' ? 'aborted' : 'error';
        run.error = error?.message || String(error);
      } finally {
        run.updatedAt = new Date().toISOString();
        run.controller = null;
        persist(run);
      }
    });

    return serializeRun(run);
  };

  return {
    start,
    get(id, after = 0) {
      const run = runs.get(id);
      if (!run) return null;
      return { ...serializeRun(run), events: run.events.filter((event) => event.remoteSequence > after) };
    },
    list(sessionId) {
      return [...runs.values()]
        .filter((run) => !sessionId || run.sessionId === String(sessionId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(serializeRun);
    },
    abort(id) {
      const run = runs.get(id);
      if (!run) return null;
      run.controller?.abort();
      return serializeRun(run);
    },
  };
}

function sandboxImageExtension(mimeType) {
  const extensions = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
  };
  return extensions[String(mimeType || '').toLowerCase()] || 'img';
}

function waitForWakeup(runAtMs, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Scheduled wake-up aborted', 'AbortError'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, Math.max(0, runAtMs - Date.now()));
  });
}

function safeAttachmentSegment(value, fallback) {
  const safe = String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return safe || fallback;
}

function decodeImageDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/);
  if (!match) return null;
  const content = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (content.length === 0 || content.length > MAX_SANDBOX_IMAGE_BYTES) return null;
  return { mimeType: match[1].toLowerCase(), content };
}

/**
 * Copy multimodal message images into stable sandbox paths and tell the model
 * where they are. The original image parts remain in the message, so the model
 * can both see the image and pass its local path to command-line tools.
 */
export async function materializeMessageImages(messages = [], { fileExists, writeFile }) {
  let totalBytes = 0;
  const output = [];

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    const images = Array.isArray(message?.images) ? message.images : [];
    const attachmentLines = [];

    for (let imageIndex = 0; imageIndex < images.length; imageIndex += 1) {
      const decoded = decodeImageDataUrl(images[imageIndex]?.dataUrl);
      if (!decoded || totalBytes + decoded.content.length > MAX_SANDBOX_IMAGES_BYTES) continue;
      totalBytes += decoded.content.length;

      const messageId = safeAttachmentSegment(message?.id, `message-${messageIndex + 1}`);
      const originalStem = String(images[imageIndex]?.name || `image-${imageIndex + 1}`).replace(/\.[^.]*$/, '');
      const fileStem = safeAttachmentSegment(originalStem, `image-${imageIndex + 1}`);
      const path = `attachments/${messageId}/${imageIndex + 1}-${fileStem}.${sandboxImageExtension(decoded.mimeType)}`;
      const exists = fileExists ? await fileExists(path) : false;
      if (!exists) await writeFile(path, decoded.content);
      attachmentLines.push(`- Image ${imageIndex + 1}: ${path}`);
    }

    if (attachmentLines.length === 0) {
      output.push(message);
      continue;
    }

    const content = [String(message.content || ''), SANDBOX_ATTACHMENTS_MARKER, ...attachmentLines]
      .filter(Boolean)
      .join('\n\n');
    output.push({ ...message, content });
  }

  return output;
}

export function createRuntimeToolDispatcher({ execCommand, listFiles, readFile, writeFile }) {
  return async (name, input, context) => {
    if (name === 'execute_command') {
      const result = await execCommand(input.command, {
        signal: context?.signal,
        onStdout: (chunk) => context?.onToolUpdate?.({ stdout: chunk }),
        onStderr: (chunk) => context?.onToolUpdate?.({ stderr: chunk }),
      });
      context?.onToolUpdate?.({
        exitCode: result.code,
        platform: result.platform,
        shell: result.shell,
        cwd: result.cwd,
        filesRoot: result.filesRoot,
      });
      return formatCommandResult(result);
    }
    if (name === 'list_sandbox_files') return JSON.stringify(await listFiles(input.path || ''), null, 2);
    if (name === 'read_sandbox_file') return readFile(input.path);
    if (name === 'display_sandbox_image') {
      const { parent, filename } = splitFilePath(input.path);
      const listing = await listFiles(parent);
      const entries = Array.isArray(listing) ? listing : listing?.children;
      const entry = entries?.find((item) => item.name === filename);
      if (!entry || entry.type === 'directory') return `Sandbox image not found: ${input.path}`;
      const mimeType = inferImageMime(input.path);
      if (!mimeType) return `Unsupported image type: ${input.path}`;
      return JSON.stringify({
        kind: 'image_reference',
        source: 'sandbox',
        path: input.path,
        name: entry.name,
        mime_type: mimeType,
        ...(Number.isFinite(entry.size) ? { size: entry.size } : {}),
      });
    }
    if (name === 'write_sandbox_file') {
      await writeFile(input.path, input.content);
      return `Successfully wrote sandbox file ${input.path}`;
    }
    if (name === 'schedule_wakeup') {
      const wakeup = await context?.scheduleWakeup?.({
        delaySeconds: input.delay_seconds,
        prompt: input.prompt,
      });
      if (!wakeup) throw new Error('Wake-up scheduling is unavailable.');
      return JSON.stringify({
        scheduled: true,
        wakeup_id: wakeup.id,
        run_at: new Date(wakeup.runAtMs).toISOString(),
        prompt: wakeup.prompt,
      });
    }
    throw new Error(`Tool is unavailable in sandbox runtime: ${name}`);
  };
}

function splitFilePath(path) {
  const parts = String(path || '').replace(/\\/g, '/').split('/').filter(Boolean);
  const filename = parts.pop() || '';
  return { parent: parts.join('/'), filename };
}

function inferImageMime(path) {
  const extension = String(path || '').split('.').pop()?.toLowerCase();
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'svg') return 'image/svg+xml';
  if (extension === 'bmp') return 'image/bmp';
  return '';
}

function formatCommandResult(result) {
  let output = `Exit code: ${result.code}`;
  if (result.platform || result.shell || result.cwd || result.filesRoot) {
    output += `\nEnvironment: platform=${result.platform || 'unknown'}, shell=${result.shell || 'unknown'}, cwd=${result.cwd || 'unknown'}, filesRoot=${result.filesRoot || 'unknown'}`;
  }
  if (result.stdout) output += `\nStdout:\n${result.stdout}`;
  if (result.stderr) output += `\nStderr:\n${result.stderr}`;
  return output;
}

function validateRunInput(input) {
  if (!input || typeof input !== 'object') throw new Error('Run body must be an object.');
  if (!input.sessionId) throw new Error('sessionId is required.');
  if (!Array.isArray(input.messages) || input.messages.length > MAX_MESSAGES) throw new Error('messages must be a bounded array.');
  const model = input.modelConfig;
  if (!model?.provider || !model?.model || !model?.apiKey) throw new Error('A complete modelConfig is required.');
  validateRuntimeFiles(input.runtimeContext?.sandboxFiles);
}

function validateRuntimeFiles(files = []) {
  if (!Array.isArray(files) || files.length > MAX_RUNTIME_FILES) {
    throw new Error(`runtimeContext.sandboxFiles must contain at most ${MAX_RUNTIME_FILES} files.`);
  }
  let totalBytes = 0;
  for (const file of files) {
    const path = String(file?.path || '');
    const content = file?.content;
    const safePath = path === 'AGENTS.md'
      || (path.startsWith('skills/')
        && !path.includes('\\')
        && !path.includes('\0')
        && path.split('/').every((part) => part && part !== '.' && part !== '..'));
    if (!safePath || typeof content !== 'string') {
      throw new Error('Sandbox snapshot files must be UTF-8 text under AGENTS.md or skills/.');
    }
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_RUNTIME_FILE_BYTES) {
      throw new Error(`Sandbox snapshot file ${path} exceeds ${MAX_RUNTIME_FILE_BYTES} bytes.`);
    }
    totalBytes += bytes;
  }
  if (totalBytes > MAX_RUNTIME_FILES_BYTES) {
    throw new Error(`Sandbox snapshot exceeds ${MAX_RUNTIME_FILES_BYTES} bytes.`);
  }
}

/** Materialize browser-owned startup files without replacing sandbox state. */
export async function materializeRuntimeFiles(files = [], { fileExists, readFile, writeFile }) {
  validateRuntimeFiles(files);
  for (const file of files) {
    let exists = false;
    if (fileExists) {
      exists = await fileExists(file.path);
    } else {
      try {
        await readFile(file.path);
        exists = true;
      } catch {
        exists = false;
      }
    }
    if (!exists) await writeFile(file.path, file.content);
  }
}

function normalizeRuntimeContext(value = {}) {
  return {
    workspaceDirName: value.workspaceDirName || null,
    activeAgent: value.activeAgent ? { id: value.activeAgent.id, name: value.activeAgent.name } : null,
    memorySnapshot: value.memorySnapshot || { memory: null, user: null },
    skillsList: value.skillsList || '',
    agentIdentity: value.agentIdentity || null,
  };
}

function serializeRun(run) {
  return {
    id: run.id,
    sessionId: run.sessionId,
    replyId: run.replyId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    sequence: run.sequence,
    result: run.result,
    error: run.error,
    wakeup: run.wakeup || null,
  };
}

function loadPersistedRuns(runsDir, runs) {
  for (const name of readdirSync(runsDir).filter((entry) => entry.endsWith('.json'))) {
    try {
      const saved = JSON.parse(readFileSync(join(runsDir, name), 'utf8'));
      if (!saved?.id) continue;
      const eventsPath = join(runsDir, `${saved.id}.events.ndjson`);
      const events = existsSync(eventsPath)
        ? readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
        : [];
      runs.set(saved.id, {
        ...saved,
        status: ['running', 'waiting'].includes(saved.status) ? 'interrupted' : saved.status,
        error: ['running', 'waiting'].includes(saved.status) ? 'Agent server restarted before the run completed.' : saved.error,
        events,
        eventBytes: existsSync(eventsPath) ? readFileSync(eventsPath).byteLength : 0,
        controller: null,
      });
    } catch {
      // Ignore a damaged individual run record; other runs remain recoverable.
    }
  }
}

export { REMOTE_TOOL_SCHEMAS };
