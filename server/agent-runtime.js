import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLanguageModel } from '../src/models/ai.js';
import { runAgentLoop } from '../src/agent/loop.js';

const MAX_MESSAGES = 2_000;
const MAX_EVENT_BYTES = 20 * 1024 * 1024;

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
    name: 'write_sandbox_file',
    description: 'Write a UTF-8 text file in the sandbox runtime.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
];

export function createAgentRunManager({ runsDir, execCommand, listFiles, readFile, writeFile }) {
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

  const dispatchTool = async (name, input, context) => {
    if (name === 'execute_command') {
      const result = await execCommand(input.command, context?.signal);
      return JSON.stringify(result, null, 2);
    }
    if (name === 'list_sandbox_files') return JSON.stringify(await listFiles(input.path || ''), null, 2);
    if (name === 'read_sandbox_file') return readFile(input.path);
    if (name === 'write_sandbox_file') {
      await writeFile(input.path, input.content);
      return `Successfully wrote sandbox file ${input.path}`;
    }
    throw new Error(`Tool is unavailable in sandbox runtime: ${name}`);
  };

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
        const modelConfig = input.modelConfig;
        const result = await runAgentLoop({
          messages: input.messages,
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
          autoSummarize: false,
          runtimeMode: 'sandbox',
          onEvent: (event) => emit(run, event),
        });
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

function validateRunInput(input) {
  if (!input || typeof input !== 'object') throw new Error('Run body must be an object.');
  if (!input.sessionId) throw new Error('sessionId is required.');
  if (!Array.isArray(input.messages) || input.messages.length > MAX_MESSAGES) throw new Error('messages must be a bounded array.');
  const model = input.modelConfig;
  if (!model?.provider || !model?.model || !model?.apiKey) throw new Error('A complete modelConfig is required.');
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
        status: saved.status === 'running' ? 'interrupted' : saved.status,
        error: saved.status === 'running' ? 'Agent server restarted before the run completed.' : saved.error,
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
