import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLanguageModel } from '../src/models/ai.js';
import { runAgentLoop } from '../src/agent/loop.js';
import { buildWakeupMessage, createOrReplaceTurnWakeup, wakeupDelayToSeconds } from '../src/agent/wakeup.js';

const MAX_MESSAGES = 2_000;
const MAX_EVENT_BYTES = 20 * 1024 * 1024;
const MAX_RUNTIME_FILES = 500;
const MAX_RUNTIME_FILE_BYTES = 256 * 1024;
const MAX_RUNTIME_FILES_BYTES = 10 * 1024 * 1024;
const MAX_SANDBOX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_SANDBOX_IMAGES_BYTES = 64 * 1024 * 1024;
const CANCELLED_RUN_ID_TTL_MS = 10 * 60_000;
const RUN_ABORT_WAIT_MS = 5_000;
const SANDBOX_ATTACHMENTS_MARKER = 'Sandbox attachment files (available to shell commands and sandbox file tools):';

const REMOTE_TOOL_SCHEMAS = [
  {
    name: 'execute_command',
    description: 'Run a SHORT foreground shell command expected to finish within 30 seconds. Use only for quick inspection or bounded operations. NEVER use for training, servers, watchers, long builds, downloads, migrations, or commands with unknown duration; use start_command instead. The browser, browser OPFS, and browser files are unavailable.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Shell command to execute.' } },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'start_command',
    description: 'Start a managed BACKGROUND shell command and return immediately with a job_id. Use for training, servers, watchers, lengthy builds/tests/downloads/migrations, commands of unknown duration, or anything expected to take 30 seconds or more. Do not add nohup, &, disown, screen, tmux, or timeout wrappers.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Complete foreground-form command without & or nohup.' } },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_command',
    description: 'Return immediately with status and one incremental log segment for a background job. Pass nextCursor from the previous result as cursor.',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        cursor: { type: 'integer', minimum: 0 },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_command',
    description: 'Wait at most 30 seconds for new logs or completion of a background job. Use only when completion is likely soon. For minutes or hours, use schedule_wakeup instead of repeated waits.',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        cursor: { type: 'integer', minimum: 0 },
        wait_seconds: { type: 'integer', minimum: 1, maximum: 30 },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'stop_command',
    description: 'Stop a managed background job and its entire process tree. Use only when cancellation was requested or the job is no longer useful.',
    parameters: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
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
    description: 'Schedule one future continuation of this sandbox agent run. Express the delay in its natural unit; do not convert minutes or hours to seconds (for example, 10 minutes is delay=10 and unit="minutes"). Use this instead of blocking or repeatedly polling. The agent server waits without using LLM tokens, then continues with the saved prompt. If the task is still pending after waking, schedule another wake-up.',
    parameters: {
      type: 'object',
      properties: {
        delay: {
          type: 'integer',
          minimum: 1,
          maximum: 604800,
          description: 'How many of the selected units to wait. The resulting delay must be from 5 seconds through 7 days.',
        },
        unit: {
          type: 'string',
          enum: ['seconds', 'minutes', 'hours', 'days'],
          description: 'Unit for delay. Use the unit stated by the user instead of converting it yourself.',
        },
        prompt: {
          type: 'string',
          description: 'A self-contained instruction describing what to inspect or continue after waking.',
        },
      },
      required: ['delay', 'unit', 'prompt'],
      additionalProperties: false,
    },
  },
];

export function createAgentRunManager({
  runsDir,
  execCommand,
  startCommand,
  getCommand,
  waitCommand,
  stopCommand,
  listFiles,
  readFile,
  writeFile,
  fileExists,
  runAgent = runAgentLoop,
  createModel = createLanguageModel,
  waitUntilWakeup = waitForWakeup,
  abortWaitMs = RUN_ABORT_WAIT_MS,
  maxEventBytes = MAX_EVENT_BYTES,
}) {
  mkdirSync(runsDir, { recursive: true });
  const runs = new Map();
  const cancelledRunIds = new Map();
  loadPersistedRuns(runsDir, runs);

  const pruneCancelledRunIds = () => {
    const now = Date.now();
    for (const [id, expiresAt] of cancelledRunIds) {
      if (expiresAt <= now) cancelledRunIds.delete(id);
    }
  };

  const persist = (run) => {
    const publicRun = serializeRun(run);
    const target = join(runsDir, `${run.id}.json`);
    const temporary = `${target}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(publicRun, null, 2), 'utf8');
      renameSync(temporary, target);
    } catch (error) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Preserve the original persistence error.
      }
      throw error;
    }
  };

  const emit = (run, event) => {
    const stored = { ...event, remoteSequence: run.sequence + 1 };
    const eventPath = join(runsDir, `${run.id}.events.ndjson`);
    const line = `${JSON.stringify(stored)}\n`;
    const lineBytes = Buffer.byteLength(line);
    if (run.eventBytes + lineBytes > maxEventBytes) {
      throw new Error(`Agent run event log exceeded ${maxEventBytes} bytes.`);
    }
    run.sequence += 1;
    run.events.push(stored);
    run.updatedAt = new Date().toISOString();
    appendFileSync(eventPath, line, 'utf8');
    run.eventBytes += lineBytes;
  };

  const dispatchTool = createRuntimeToolDispatcher({
    execCommand,
    startCommand,
    getCommand,
    waitCommand,
    stopCommand,
    listFiles,
    readFile,
    writeFile,
  });

  const start = (input) => {
    validateRunInput(input);
    const sessionId = String(input.sessionId);
    const id = input.runId ? String(input.runId) : `run-${randomUUID()}`;
    pruneCancelledRunIds();
    if (cancelledRunIds.has(id)) {
      const error = new Error(`Agent run was cancelled before it started: ${id}`);
      error.statusCode = 409;
      throw error;
    }
    const existingById = runs.get(id);
    if (existingById) {
      if (
        existingById.sessionId === sessionId
        && existingById.replyId === (input.replyId ? String(input.replyId) : null)
      ) return serializeRun(existingById);
      const error = new Error(`Agent run id already exists: ${id}`);
      error.statusCode = 409;
      throw error;
    }
    const activeRun = [...runs.values()].find((candidate) => (
      candidate.sessionId === sessionId
      && ['running', 'waiting'].includes(candidate.status)
    ));
    if (activeRun) {
      const error = new Error(`Session ${sessionId} already has an active agent run (${activeRun.id}).`);
      error.statusCode = 409;
      throw error;
    }
    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    const run = {
      id,
      sessionId,
      replyId: input.replyId ? String(input.replyId) : null,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sequence: 0,
      events: [],
      result: null,
      error: null,
      controller: new AbortController(),
      cancelRequested: false,
      completion,
      eventBytes: 0,
    };
    runs.set(id, run);
    try {
      persist(run);
    } catch (error) {
      runs.delete(id);
      throw error;
    }

    Promise.resolve().then(async () => {
      try {
        throwIfRunCancelled(run);
        await materializeRuntimeFiles(input.runtimeContext?.sandboxFiles, { fileExists, readFile, writeFile });
        throwIfRunCancelled(run);
        let runtimeMessages = await materializeMessageImages(input.messages, {
          fileExists,
          writeFile,
          attachmentScope: run.id,
        });
        throwIfRunCancelled(run);
        const modelConfig = input.modelConfig;
        let result;
        let activeTurnToken = null;
        while (true) {
          const turnToken = {};
          activeTurnToken = turnToken;
          let scheduledWakeup = null;
          try {
            result = await runAgent({
              messages: runtimeMessages,
              systemPrompt: input.systemPrompt || '',
              agentId: input.agentId || null,
              provider: modelConfig.provider,
              model: modelConfig.model,
              contextWindow: modelConfig.contextWindow || undefined,
              maxRounds: input.maxRounds,
              signal: run.controller.signal,
              languageModel: createModel(modelConfig),
              runtimeContext: normalizeRuntimeContext(input.runtimeContext),
              toolSchemas: REMOTE_TOOL_SCHEMAS,
              dispatchTool,
              scheduleWakeup: async ({ delaySeconds, prompt }) => {
                if (activeTurnToken !== turnToken) throw createRunAbortError();
                throwIfRunCancelled(run);
                scheduledWakeup = createOrReplaceTurnWakeup({
                  currentWakeup: scheduledWakeup,
                  id: scheduledWakeup?.id || `wake-${randomUUID()}`,
                  delaySeconds,
                  prompt,
                });
                return scheduledWakeup;
              },
              autoSummarize: false,
              runtimeMode: 'sandbox',
              onEvent: (event) => {
                // A provider or tool may ignore the per-turn abort and report
                // late output after the scheduled continuation has begun. A
                // run-level status check alone cannot distinguish those turns.
                // Drop stale callback output instead of throwing: callbacks
                // from an EventEmitter/setTimeout may live outside the tool's
                // promise chain, where a throw would become an uncaughtException
                // and terminate the entire agent server.
                if (
                  activeTurnToken !== turnToken
                  || run.status !== 'running'
                  || run.cancelRequested
                  || !run.controller
                  || run.controller.signal.aborted
                ) return;
                emit(run, event);
              },
            });
          } finally {
            if (activeTurnToken === turnToken) activeTurnToken = null;
          }

          throwIfRunCancelled(run);
          run.result = result;
          if (!scheduledWakeup) break;

          run.status = 'waiting';
          run.wakeup = scheduledWakeup;
          run.updatedAt = new Date().toISOString();
          persist(run);
          await waitUntilWakeup(scheduledWakeup.runAtMs, run.controller.signal);
          throwIfRunCancelled(run);

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
        run.status = run.cancelRequested || error?.name === 'AbortError' ? 'aborted' : 'error';
        run.error = error?.message || String(error);
      } finally {
        run.updatedAt = new Date().toISOString();
        run.controller = null;
        try {
          persist(run);
        } catch (error) {
          console.error(`Failed to persist terminal agent run ${run.id}:`, error);
        } finally {
          resolveCompletion();
        }
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
      if (!run) {
        if (!/^run-[A-Za-z0-9-]{6,128}$/.test(String(id))) return null;
        pruneCancelledRunIds();
        cancelledRunIds.set(String(id), Date.now() + CANCELLED_RUN_ID_TTL_MS);
        const now = new Date().toISOString();
        return Promise.resolve({
          id: String(id),
          sessionId: null,
          replyId: null,
          status: 'aborted',
          createdAt: now,
          updatedAt: now,
          sequence: 0,
          result: null,
          error: 'Cancelled before start.',
          wakeup: null,
        });
      }
      run.cancelRequested = true;
      run.controller?.abort();
      // Providers and external tools are expected to honor AbortSignal, but an
      // unhealthy implementation must not hold the HTTP DELETE open forever.
      // The run remains active (and continues blocking another run for this
      // same session) until its task actually settles, preserving isolation.
      return waitForSettlement(run.completion, abortWaitMs).then(() => serializeRun(run));
    },
  };
}

async function waitForSettlement(promise, timeoutMs) {
  let timerId;
  await Promise.race([
    Promise.resolve(promise).catch(() => {}),
    new Promise((resolve) => {
      timerId = setTimeout(resolve, Math.max(0, Number(timeoutMs) || 0));
    }),
  ]);
  clearTimeout(timerId);
}

function throwIfRunCancelled(run) {
  if (!run.cancelRequested && run.controller && !run.controller.signal.aborted) return;
  throw createRunAbortError();
}

function createRunAbortError() {
  const error = new Error('Agent run aborted');
  error.name = 'AbortError';
  return error;
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
export async function materializeMessageImages(messages = [], { fileExists, writeFile, attachmentScope }) {
  let totalBytes = 0;
  const output = [];
  const scopedPrefix = attachmentScope
    ? `${safeAttachmentSegment(attachmentScope, 'run')}/`
    : '';

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
      const path = `attachments/${scopedPrefix}${messageId}/${imageIndex + 1}-${fileStem}.${sandboxImageExtension(decoded.mimeType)}`;
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

export function createRuntimeToolDispatcher({
  execCommand,
  startCommand,
  getCommand,
  waitCommand,
  stopCommand,
  listFiles,
  readFile,
  writeFile,
}) {
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
    if (name === 'start_command') {
      if (!startCommand) throw new Error('Managed background commands are unavailable.');
      return JSON.stringify(await startCommand(input.command), null, 2);
    }
    if (name === 'get_command') {
      if (!getCommand) throw new Error('Managed background commands are unavailable.');
      const result = await getCommand(input.job_id, input.cursor || 0);
      return result ? JSON.stringify(result, null, 2) : `Background command not found: ${input.job_id}`;
    }
    if (name === 'wait_command') {
      if (!waitCommand) throw new Error('Managed background commands are unavailable.');
      const result = await waitCommand(input.job_id, {
        cursor: input.cursor || 0,
        waitMs: (input.wait_seconds || 30) * 1000,
        signal: context?.signal,
      });
      return result ? JSON.stringify(result, null, 2) : `Background command not found: ${input.job_id}`;
    }
    if (name === 'stop_command') {
      if (!stopCommand) throw new Error('Managed background commands are unavailable.');
      const result = await stopCommand(input.job_id);
      return result ? JSON.stringify(result, null, 2) : `Background command not found: ${input.job_id}`;
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
      const delaySeconds = wakeupDelayToSeconds(input.delay, input.unit);
      const wakeup = await context?.scheduleWakeup?.({
        delaySeconds,
        prompt: input.prompt,
      });
      if (!wakeup) throw new Error('Wake-up scheduling is unavailable.');
      return JSON.stringify({
        scheduled: true,
        wakeup_id: wakeup.id,
        delay: { value: input.delay, unit: input.unit },
        delay_seconds: delaySeconds,
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
  if (result.status) output += `\nStatus: ${result.status}${Number.isFinite(result.durationMs) ? ` (${result.durationMs} ms)` : ''}`;
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
  if (input.runId !== undefined && !/^run-[A-Za-z0-9-]{6,128}$/.test(String(input.runId))) {
    throw new Error('runId must be a valid client-generated run id.');
  }
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
        completion: Promise.resolve(),
      });
    } catch {
      // Ignore a damaged individual run record; other runs remain recoverable.
    }
  }
}

export { REMOTE_TOOL_SCHEMAS };
