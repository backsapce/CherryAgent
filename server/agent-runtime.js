import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLanguageModel } from '../src/models/ai.js';
import { runAgentLoop } from '../src/agent/loop.js';
import { buildWakeupMessage, createOrReplaceTurnWakeup, wakeupDelayToSeconds } from '../src/agent/wakeup.js';
import {
  MAX_SKILL_CONTENT_CHARS,
  MAX_SKILL_REFERENCE_CHARS,
  formatReferenceContent,
  formatSkills,
  normalizeReferenceName,
  normalizeSkillName,
  parseFrontmatter,
  safeDirectorySkillName,
  scoreSkill,
  truncateText,
  validateSkillContent,
} from '../src/agent/skillCore.js';
import { TOOL_PARAMETER_SCHEMAS, formatCommandResult } from '../src/agent/toolSchemas.js';
import { fetchWebPage, formatWebPageForModel } from '../src/agent/webFetch.js';
import { formatSearchResults, runWebSearch } from '../src/models/search.js';
import { imageMimeFromPath, splitFilePath, waitForSettlement } from '../src/utils/misc.js';

const MAX_MESSAGES = 2_000;
const MAX_EVENT_BYTES = 20 * 1024 * 1024;
// Terminal runs are kept for replay/debugging, but not forever: without a
// retention bound the runs map, the in-memory event logs, and the runs
// directory all grow without limit on a long-lived server.
const DEFAULT_RUN_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_RUN_PRUNE_INTERVAL_MS = 60 * 60_000;
const MAX_RETAINED_TERMINAL_RUNS = 50;
// Idle (turn-complete, continuable) runs hold the whole conversation in
// memory and on disk, so they get a tighter LRU cap than terminal replays.
const MAX_IDLE_RUNS = 8;
const TERMINAL_RUN_STATUSES = new Set(['completed', 'error', 'aborted', 'interrupted', 'superseded']);
// Streaming deltas dominate the event log (one event per model token). They
// are coalesced into batches before they touch the ndjson log or a push so
// the per-event JSON envelope stops multiplying the byte cost ~30x.
const COALESCED_DELTA_TYPES = new Set(['text-delta', 'reasoning-delta']);
const DELTA_COALESCE_MS = 100;
const DELTA_COALESCE_CHARS = 32 * 1024;
const MAX_RUNTIME_FILES = 500;
const MAX_RUNTIME_FILE_BYTES = 256 * 1024;
const MAX_RUNTIME_FILES_BYTES = 10 * 1024 * 1024;
const MAX_SANDBOX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_SANDBOX_IMAGES_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES_CONTENT_BYTES = 12 * 1024 * 1024;
const CANCELLED_RUN_ID_TTL_MS = 10 * 60_000;
// Keep the server grace period below the browser's 5 second cancellation
// deadline. If an upstream provider ignores AbortSignal, the durable run must
// still become terminal so it cannot lock the conversation forever.
const RUN_ABORT_WAIT_MS = 3_000;
const SANDBOX_ATTACHMENTS_MARKER = 'Sandbox attachment files (available to shell commands and sandbox file tools):';
const MAX_WAKEUP_CONTINUATION_TOOL_CHARS = 4_000;
const MAX_WAKEUP_CONTINUATION_TOOL_INPUT_CHARS = 700;
const MAX_WAKEUP_CONTINUATION_TOOL_RESULT_CHARS = 1_600;
const COMMAND_CONTINUATION_TOOL_NAMES = new Set([
  'get_command',
  'start_command',
  'stop_command',
  'wait_command',
]);
// A durable sandbox run races tool execution against the model-stream timeouts
// (see DEFAULT_SANDBOX_MODEL_TIMEOUT in loop.js: 90s inter-chunk, 5min per step)
// and the run idle watchdog. A long blocking wait is therefore served in
// slices: progress updates between slices emit events that keep the watchdog
// alive, while the per-call budget keeps the whole tool call inside the stream
// timeouts. The tool result reports the remainder so the model can wait again.
const SANDBOX_WAIT_SLICE_MS = 20_000;
const SANDBOX_WAIT_TOOL_BUDGET_MS = 60_000;
const WAIT_TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted']);
const MAX_WAIT_SECONDS = 7 * 24 * 60 * 60;

const REMOTE_TOOL_SCHEMAS = [
  {
    name: 'execute_command',
    description: 'Run a SHORT foreground shell command expected to finish within 30 seconds. Use only for quick inspection or bounded operations. NEVER use for training, servers, watchers, long builds, downloads, migrations, or commands with unknown duration; use start_command instead. The browser, browser OPFS, and browser files are unavailable.',
    parameters: TOOL_PARAMETER_SCHEMAS.execute_command,
  },
  {
    name: 'start_command',
    description: 'Start a managed BACKGROUND shell command and return immediately with a job_id, without waiting. Use when a later get_command/wait_command or schedule_wakeup continuation will consume the result; otherwise prefer wait_command with the command to start and wait in one call. Do not add nohup, &, disown, screen, tmux, or timeout wrappers.',
    parameters: TOOL_PARAMETER_SCHEMAS.start_command,
  },
  {
    name: 'get_command',
    description: 'Return immediately with status and one incremental log segment for a background job. Pass nextCursor from the previous result as cursor.',
    parameters: TOOL_PARAMETER_SCHEMAS.get_command,
  },
  {
    name: 'wait_command',
    description: 'Start a background command and wait for it in one call (pass command), or keep waiting on an existing job (pass job_id with cursor): blocks for up to wait_seconds (default 30, at most 7 days) and returns early on completion or new logs; the user sees the remaining wait time. This runtime serves long waits in bounded slices: when a wait is cut short, the result says so and you should call wait_command again with the job_id (or schedule_wakeup when the turn should end now and resume later).',
    parameters: TOOL_PARAMETER_SCHEMAS.wait_command,
  },
  {
    name: 'stop_command',
    description: 'Stop a managed background job and its entire process tree. Use only when cancellation was requested or the job is no longer useful.',
    parameters: TOOL_PARAMETER_SCHEMAS.stop_command,
  },
  {
    name: 'list_sandbox_files',
    description: 'List files in the sandbox runtime. Browser files are not available.',
    parameters: TOOL_PARAMETER_SCHEMAS.list_sandbox_files,
  },
  {
    name: 'read_sandbox_file',
    description: 'Read a UTF-8 text file from the sandbox runtime.',
    parameters: TOOL_PARAMETER_SCHEMAS.read_sandbox_file,
  },
  {
    name: 'display_sandbox_image',
    description: 'Display an image from the sandbox runtime in the browser conversation UI. Returns only a file reference; image bytes and base64 are never included in the conversation.',
    parameters: TOOL_PARAMETER_SCHEMAS.display_sandbox_image,
  },
  {
    name: 'write_sandbox_file',
    description: 'Write a UTF-8 text file in the sandbox runtime.',
    parameters: TOOL_PARAMETER_SCHEMAS.write_sandbox_file,
  },
  {
    name: 'skill',
    description: 'List, read, and write progressive skills only in this sandbox runtime under skills/<skill-name>/. This tool never reads from or writes to browser OPFS. Read references individually only when needed.',
    parameters: TOOL_PARAMETER_SCHEMAS.skill,
  },
  {
    name: 'schedule_wakeup',
    description: 'Schedule one future continuation of this sandbox agent run. Express the delay in its natural unit; do not convert minutes or hours to seconds (for example, 10 minutes is delay=10 and unit="minutes"). Use this instead of blocking or repeatedly polling. The agent server waits without using LLM tokens, then continues with the saved prompt. If the task is still pending after waking, schedule another wake-up.',
    parameters: TOOL_PARAMETER_SCHEMAS.schedule_wakeup,
  },
  {
    name: 'web_search',
    description: 'Search the web and return compact results: title, URL, and a short snippet per result — never full page content. Use it whenever a question needs current or otherwise external information instead of guessing. After answering from results, cite the used sources as markdown links. When a snippet is not enough, call web_fetch on the result URL to read the full page.',
    parameters: TOOL_PARAMETER_SCHEMAS.web_search,
  },
  {
    name: 'web_fetch',
    description: 'Fetch one web page and return its readable text. HTML is converted to text with headings and links preserved; binary content (images, PDFs, archives) is rejected. http URLs are upgraded to https and only http(s) is supported. Successful fetches are cached for a short time, so re-reading a URL is cheap. Prefer this over shell curl for reading public pages.',
    parameters: TOOL_PARAMETER_SCHEMAS.web_fetch,
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
  idleTimeoutMs = 0,
  maxEventBytes = MAX_EVENT_BYTES,
  runRetentionMs = DEFAULT_RUN_RETENTION_MS,
  runPruneIntervalMs = DEFAULT_RUN_PRUNE_INTERVAL_MS,
  maxRetainedTerminalRuns = MAX_RETAINED_TERMINAL_RUNS,
  maxIdleRuns = MAX_IDLE_RUNS,
}) {
  mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  const runs = new Map();
  const cancelledRunIds = new Map();
  loadPersistedRuns(runsDir, runs, { retentionMs: runRetentionMs });

  // Drop terminal runs that aged out or exceed the retained count, and demote
  // idle runs past their LRU cap (their conversations are the expensive part).
  // Run files can contain the caller's model credentials, so disk cleanup
  // matters as much as the in-memory bound.
  const pruneExpiredRuns = () => {
    const cutoff = Date.now() - Math.max(1, runRetentionMs);
    const terminal = [...runs.values()]
      .filter((run) => TERMINAL_RUN_STATUSES.has(run.status))
      .sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')));
    // Oldest first; everything past the newest maxRetainedTerminalRuns is dropped.
    const overflow = terminal.slice(0, Math.max(0, terminal.length - maxRetainedTerminalRuns));
    const expired = terminal.filter((run) => Date.parse(run.updatedAt || '') < cutoff);
    for (const run of [...overflow, ...expired]) {
      runs.delete(run.id);
      subscribers.delete(run.id);
      removeRunFiles(runsDir, run.id);
    }

    const idle = [...runs.values()]
      .filter((run) => run.status === 'idle')
      .sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')));
    const idleOverflow = idle.slice(0, Math.max(0, idle.length - maxIdleRuns));
    for (const run of idleOverflow) {
      run.status = 'superseded';
      run.resume = null;
      run.updatedAt = new Date().toISOString();
      notifyStatus(run);
      try {
        persist(run);
      } catch (error) {
        console.error(`Failed to persist demoted idle agent run ${run.id}:`, error);
      }
    }
  };

  const pruneTimer = typeof runPruneIntervalMs === 'number' && runPruneIntervalMs > 0
    ? setInterval(pruneExpiredRuns, runPruneIntervalMs)
    : null;
  pruneTimer?.unref?.();

  const pruneCancelledRunIds = () => {
    const now = Date.now();
    for (const [id, expiresAt] of cancelledRunIds) {
      if (expiresAt <= now) cancelledRunIds.delete(id);
    }
  };

  const persist = (run) => {
    const publicRun = serializeRun(run);
    // `resume` is durable recovery state only (it can include the model config
    // and the full conversation). Keep it out of API responses via serializeRun
    // but write it alongside the run so a restart can re-arm a waiting run.
    const stored = run.resume ? { ...publicRun, resume: run.resume } : publicRun;
    const target = join(runsDir, `${run.id}.json`);
    const temporary = `${target}.tmp`;
    try {
      // 0600: run records can carry model credentials while a run is waiting.
      writeFileSync(temporary, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 });
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

  const emit = (run, turn, event) => {
    const line = `${JSON.stringify({ v: 2, seq: run.sequence + 1, turn, ev: event })}\n`;
    const lineBytes = Buffer.byteLength(line);
    if (run.eventBytes + lineBytes > maxEventBytes) {
      throw new Error(`Agent run event log exceeded ${maxEventBytes} bytes.`);
    }
    run.sequence += 1;
    run.events.push({ seq: run.sequence, turn, ev: event });
    run.updatedAt = new Date().toISOString();
    appendFileSync(join(runsDir, `${run.id}.events.ndjson`), line, { encoding: 'utf8', mode: 0o600 });
    run.eventBytes += lineBytes;
    return run.events[run.events.length - 1];
  };

  /**
   * Prepare stored events for delivery: v2 entries are stored bare (no
   * run-scoped id prefixes, no remoteSequence) and get namespaced here, so
   * the on-disk log carries each byte of scope exactly once per run instead
   * of on every field of every event. Legacy lines are already decorated.
   */
  const serveEvent = (run, entry) => {
    if (entry.decorated) return entry.ev;
    return {
      ...namespaceRuntimeEvent(entry.ev, `${run.id}:turn-${entry.turn}`),
      remoteSequence: entry.seq,
    };
  };

  const serveEventsAfter = (run, after) => {
    const result = [];
    for (const entry of run.events) {
      if (entry.seq > after) result.push(serveEvent(run, entry));
    }
    return result;
  };

  const subscribers = new Map(); // runId → Set<listener>
  const notifyEvents = (run, entries) => {
    const listeners = subscribers.get(run.id);
    if (!listeners?.size || !entries.length) return;
    const events = entries.map((entry) => serveEvent(run, entry));
    for (const listener of listeners) {
      try {
        listener({ events });
      } catch {
        // A broken subscriber must not break the run loop.
      }
    }
  };
  const notifyStatus = (run) => {
    const listeners = subscribers.get(run.id);
    if (!listeners?.size) return;
    const snapshot = serializeRun(run);
    for (const listener of listeners) {
      try {
        listener({ run: snapshot });
      } catch {
        // ignore
      }
    }
  };

  // First prune runs after subscribers/notifyStatus exist: pruneExpiredRuns
  // touches both, and calling it earlier would hit their temporal dead zone.
  pruneExpiredRuns();

  /**
   * Batch same-segment streaming deltas on a time/size window. Any other
   * event type flushes first so relative ordering is preserved. The timer
   * flush routes errors into the run's abort instead of the event loop.
   */
  const createDeltaCoalescer = (run, turnNumber) => {
    let pending = null;
    let timer = null;
    const flush = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!pending) return;
      const batch = pending;
      pending = null;
      const entry = emit(run, turnNumber, batch);
      notifyEvents(run, [entry]);
    };
    return {
      offer(event) {
        if (
          pending
          && (pending.type !== event.type
            || pending.segmentId !== event.segmentId
            || pending.stepId !== event.stepId)
        ) flush();
        if (!pending) {
          pending = { ...event };
          timer = setTimeout(() => {
            try {
              flush();
            } catch (error) {
              run.controller?.abort(error);
            }
          }, DELTA_COALESCE_MS);
          timer.unref?.();
        } else {
          pending.text = (pending.text || '') + (event.text || '');
          pending.newSegment = pending.newSegment || event.newSegment;
        }
        if ((pending.text || '').length >= DELTA_COALESCE_CHARS) flush();
      },
      flush,
    };
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

  // The subset of the original run request needed to continue a durable run
  // after a restart. `runtimeContext` keeps sandboxFiles so skills/identity are
  // re-materialized if the sandbox filesystem was recreated. `searchConfig`
  // carries the search provider credential and rides the same 0600 files.
  const persistableInput = (input) => ({
    systemPrompt: input.systemPrompt || '',
    agentId: input.agentId || null,
    maxRounds: input.maxRounds,
    modelConfig: input.modelConfig,
    searchConfig: input.searchConfig || null,
    runtimeContext: input.runtimeContext || null,
  });

  // Drive one durable run across its wake-up separated turns. When `resume`
  // is provided the run restarts from a persisted waiting point: it first waits
  // out the saved wake-up, appends the continuation, then keeps running turns.
  const executeRunLoop = async (run, input, resume) => {
    try {
      throwIfRunCancelled(run);
      await materializeRuntimeFiles(input.runtimeContext?.sandboxFiles, { fileExists, readFile, writeFile });
      throwIfRunCancelled(run);
      let runtimeMessages;
      let turnNumber;
      let result;
      let pendingWakeup = null;
      if (resume) {
        runtimeMessages = resume.runtimeMessages;
        turnNumber = resume.turnNumber;
        result = resume.result;
        pendingWakeup = resume.wakeup;
      } else {
        runtimeMessages = await materializeMessageImages(input.messages, {
          fileExists,
          writeFile,
          attachmentScope: run.id,
        });
        throwIfRunCancelled(run);
        turnNumber = 0;
      }
      const modelConfig = input.modelConfig;
      const searchConfig = normalizeRuntimeSearchConfig(input.searchConfig);
      let activeTurnToken = null;
      while (true) {
        if (pendingWakeup) {
          run.status = 'waiting';
          run.wakeup = pendingWakeup;
          run.updatedAt = new Date().toISOString();
          persist(run);
          notifyStatus(run);
          // A superseding continue() resolves this race early and replaces
          // the wake-up prompt with the caller's message.
          await Promise.race([
            waitUntilWakeup(pendingWakeup.runAtMs, run.controller.signal),
            new Promise((resolve) => {
              if (run.wakeupOverride) resolve();
              else run.wakeEarly = resolve;
            }),
          ]);
          run.wakeEarly = null;
          throwIfRunCancelled(run);

          const override = run.wakeupOverride;
          run.wakeupOverride = null;
          run.status = 'running';
          run.wakeup = null;
          run.resume = null;
          run.updatedAt = new Date().toISOString();
          persist(run);
          notifyStatus(run);
          runtimeMessages = [
            ...runtimeMessages,
            { role: 'assistant', content: scheduledTurnContinuation(result) },
            { role: 'user', content: override ?? buildWakeupMessage(pendingWakeup) },
          ];
          if (runtimeMessages.length > MAX_MESSAGES) throw new Error('Scheduled run exceeded the message limit.');
          pendingWakeup = null;
        }

        turnNumber += 1;
        const turnToken = {};
        activeTurnToken = turnToken;
        let scheduledWakeup = null;
        const coalescer = createDeltaCoalescer(run, turnNumber);
        const activityWatchdog = createActivityWatchdog(idleTimeoutMs, (error) => {
          run.controller?.abort(error);
        });
        try {
          result = await Promise.race([
            Promise.resolve(runAgent({
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
              toolSchemas: searchConfig
                ? REMOTE_TOOL_SCHEMAS
                : REMOTE_TOOL_SCHEMAS.filter((tool) => tool.name !== 'web_search'),
              dispatchTool: (name, input, context) => dispatchTool(name, input, { ...context, searchConfig }),
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
                activityWatchdog.touch();
                try {
                  if (COALESCED_DELTA_TYPES.has(event.type)) {
                    coalescer.offer(event);
                    return;
                  }
                  coalescer.flush();
                  const entry = emit(run, turnNumber, event);
                  notifyEvents(run, [entry]);
                } catch (error) {
                  run.controller?.abort(error);
                }
              },
            })),
            activityWatchdog.promise,
          ]);
        } finally {
          coalescer.flush();
          activityWatchdog.dispose();
          if (activeTurnToken === turnToken) activeTurnToken = null;
        }

        throwIfRunCancelled(run);
        run.result = result;
        if (!scheduledWakeup) break;

        pendingWakeup = scheduledWakeup;
        // Capture everything needed to continue after this wake-up survives a
        // server restart: the conversation so far, the turn that scheduled the
        // wake-up, its result (used to build the continuation), and the request.
        run.resume = {
          v: 1,
          runtimeMessages,
          turnNumber,
          result,
          input: persistableInput(input),
        };
      }
      // The turn finished without scheduling anything: the run goes idle and
      // stays continuable (the next user message appends instead of paying a
      // full-history POST), with the resume state persisted for restarts.
      run.result = result;
      run.resume = {
        v: 1,
        runtimeMessages,
        turnNumber,
        result,
        input: persistableInput(input),
      };
      run.status = 'idle';
    } catch (error) {
      if (!run.forceTerminated) {
        run.status = run.cancelRequested ? 'aborted' : 'error';
        run.error = error?.message || String(error);
        run.resume = null;
      }
    } finally {
      if (!run.forceTerminated) {
        run.updatedAt = new Date().toISOString();
        run.controller = null;
        run.wakeEarly = null;
        try {
          persist(run);
        } catch (error) {
          console.error(`Failed to persist terminal agent run ${run.id}:`, error);
        }
      }
      notifyStatus(run);
      run.resolveCompletion();
    }
  };

  // Re-arm any waiting run that survived a restart with persisted resume state.
  // A waiting run without resume state cannot be continued and stays interrupted.
  const resumePersistedWaitingRuns = () => {
    for (const run of runs.values()) {
      if (run.status !== 'waiting' || !run.resume || !run.wakeup) continue;
      const resume = {
        runtimeMessages: run.resume.runtimeMessages,
        turnNumber: run.resume.turnNumber,
        result: run.resume.result,
        wakeup: run.wakeup,
      };
      const input = run.resume.input;
      run.controller = new AbortController();
      run.cancelRequested = false;
      run.forceTerminated = false;
      let resolveCompletion;
      run.completion = new Promise((resolve) => { resolveCompletion = resolve; });
      run.resolveCompletion = resolveCompletion;
      Promise.resolve().then(() => executeRunLoop(run, input, resume));
    }
  };
  resumePersistedWaitingRuns();

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
    // A fresh full-history start supersedes the session's continuable idle
    // run: the browser sends full history precisely because it diverged.
    for (const candidate of runs.values()) {
      if (candidate.sessionId !== sessionId || candidate.status !== 'idle') continue;
      candidate.status = 'superseded';
      candidate.resume = null;
      candidate.updatedAt = new Date().toISOString();
      notifyStatus(candidate);
      try {
        persist(candidate);
      } catch (error) {
        console.error(`Failed to persist superseded agent run ${candidate.id}:`, error);
      }
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
      forceTerminated: false,
      completion,
      resolveCompletion,
      eventBytes: 0,
    };
    runs.set(id, run);
    try {
      persist(run);
    } catch (error) {
      runs.delete(id);
      throw error;
    }

    Promise.resolve().then(() => executeRunLoop(run, input, null));

    return serializeRun(run);
  };

  /**
   * Append one user turn to an idle run (or supersede a pending wake-up)
   * instead of re-uploading the full conversation. The browser owns the
   * conversation, so it passes its user-message count; a mismatch means the
   * history was edited and the client must fall back to a full start.
   */
  const continueRun = (input) => {
    const runId = String(input?.runId || '');
    const run = runs.get(runId);
    if (!run) {
      const error = new Error('Agent run not found');
      error.statusCode = 404;
      throw error;
    }
    const message = input?.message;
    if (typeof message !== 'string' || !message.trim()) {
      const error = new Error('Missing or invalid "message" field.');
      error.statusCode = 400;
      throw error;
    }
    if (Buffer.byteLength(message) > MAX_MESSAGE_CONTENT_BYTES) {
      const error = new Error(`message exceeds ${MAX_MESSAGE_CONTENT_BYTES} bytes.`);
      error.statusCode = 413;
      throw error;
    }

    if (run.status === 'waiting') {
      if (!input?.supersede) {
        const error = new Error('Run is waiting for a scheduled wake-up; pass supersede to replace it.');
        error.statusCode = 409;
        throw error;
      }
      if (!run.resume) {
        const error = new Error('Waiting run has no resume state and cannot be superseded.');
        error.statusCode = 409;
        throw error;
      }
      applyContinueOverrides(run.resume.input, input);
      run.replyId = input.replyId ? String(input.replyId) : run.replyId;
      run.wakeupOverride = message;
      run.updatedAt = new Date().toISOString();
      run.wakeEarly?.();
      return serializeRun(run);
    }

    if (run.status !== 'idle' || !run.resume) {
      const error = new Error(`Agent run is ${run.status} and cannot continue.`);
      error.statusCode = 409;
      throw error;
    }
    const resume = run.resume;
    const expectedUserMessages = resume.runtimeMessages.filter((candidate) => candidate.role === 'user').length + 1;
    const declaredUserMessages = Number(input?.userMessageCount);
    if (Number.isFinite(declaredUserMessages) && declaredUserMessages !== expectedUserMessages) {
      const error = new Error('Conversation history diverged: start a new run with the full history.');
      error.statusCode = 409;
      error.code = 'HISTORY_DIVERGED';
      throw error;
    }
    applyContinueOverrides(resume.input, input);

    const runtimeMessages = [
      ...resume.runtimeMessages,
      { role: 'assistant', content: scheduledTurnContinuation(resume.result) },
      { role: 'user', content: message },
    ];
    if (runtimeMessages.length > MAX_MESSAGES) {
      const error = new Error('Continued run exceeded the message limit.');
      error.statusCode = 409;
      throw error;
    }

    run.replyId = input.replyId ? String(input.replyId) : run.replyId;
    run.cancelRequested = false;
    run.forceTerminated = false;
    run.status = 'running';
    run.error = null;
    run.result = null;
    run.wakeup = null;
    run.updatedAt = new Date().toISOString();
    let resolveCompletion;
    run.completion = new Promise((resolve) => { resolveCompletion = resolve; });
    run.resolveCompletion = resolveCompletion;
    run.controller = new AbortController();
    persist(run);
    notifyStatus(run);
    Promise.resolve().then(() => executeRunLoop(run, resume.input, {
      runtimeMessages,
      turnNumber: resume.turnNumber,
      result: resume.result,
      wakeup: null,
    }));
    return serializeRun(run);
  };

  return {
    start,
    continue: continueRun,
    get(id, after = 0) {
      const run = runs.get(id);
      if (!run) return null;
      return { ...serializeRun(run), events: serveEventsAfter(run, Number(after) || 0) };
    },
    /**
     * Live event subscription: replays everything past `after`, then pushes
     * new events and status snapshots. The replay snapshot and the live
     * stream are deduplicated by remoteSequence.
     */
    subscribe(id, after, listener) {
      const run = runs.get(String(id || ''));
      if (!run) return null;
      let listeners = subscribers.get(run.id);
      if (!listeners) {
        listeners = new Set();
        subscribers.set(run.id, listeners);
      }
      const snapshot = serveEventsAfter(run, Number(after) || 0);
      const lastSeq = snapshot.length
        ? Number(snapshot[snapshot.length - 1].remoteSequence) || 0
        : (Number(after) || 0);
      const guarded = (payload) => {
        if (payload.events) {
          const fresh = payload.events.filter((event) => (Number(event.remoteSequence) || 0) > lastSeq);
          if (!fresh.length) return;
          listener({ events: fresh });
          return;
        }
        listener(payload);
      };
      listeners.add(guarded);
      if (snapshot.length) listener({ events: snapshot });
      listener({ run: serializeRun(run) });
      return () => {
        listeners.delete(guarded);
        if (!listeners.size) subscribers.delete(run.id);
      };
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
      // unhealthy implementation must neither hold DELETE open nor keep this
      // session permanently locked. Late callbacks are already fenced by
      // cancelRequested/status/controller checks in onEvent, and tool dispatch
      // checks the aborted signal before starting new work.
      return waitForSettlement(run.completion, abortWaitMs).then((settled) => {
        if (!settled && ['running', 'waiting'].includes(run.status)) {
          // Make the forced terminal snapshot immutable. The detached provider
          // may eventually settle, but it no longer owns this durable state.
          run.forceTerminated = true;
          run.status = 'aborted';
          run.error = 'Agent run aborted after the cancellation grace period.';
          run.wakeup = null;
          run.updatedAt = new Date().toISOString();
          run.controller = null;
          try {
            persist(run);
          } catch (error) {
            console.error(`Failed to persist force-aborted agent run ${run.id}:`, error);
          }
          run.resolveCompletion?.();
        }
        return serializeRun(run);
      });
    },
  };
}

function createActivityWatchdog(timeoutMs, onTimeout) {
  const boundedTimeoutMs = Number(timeoutMs);
  if (!Number.isFinite(boundedTimeoutMs) || boundedTimeoutMs <= 0) {
    return {
      promise: new Promise(() => {}),
      touch() {},
      dispose() {},
    };
  }

  let timerId;
  let rejectTimeout;
  let disposed = false;
  const promise = new Promise((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const touch = () => {
    if (disposed) return;
    clearTimeout(timerId);
    timerId = setTimeout(() => {
      if (disposed) return;
      const seconds = Math.max(1, Math.round(boundedTimeoutMs / 1_000));
      const error = new Error(
        `Sandbox runtime made no progress for ${seconds} seconds. Verify that the agent server can reach the configured LLM base URL.`
      );
      error.name = 'SandboxRuntimeTimeoutError';
      error.code = 'SANDBOX_RUNTIME_IDLE_TIMEOUT';
      // Settle the watchdog side of Promise.race first. Aborting the provider
      // may synchronously surface a generic AbortError; that must not hide the
      // actionable no-progress timeout from the durable run and browser UI.
      rejectTimeout(error);
      onTimeout?.(error);
    }, boundedTimeoutMs);
    timerId.unref?.();
  };
  touch();

  return {
    promise,
    touch,
    dispose() {
      disposed = true;
      clearTimeout(timerId);
    },
  };
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

function namespaceRuntimeEvent(event, scope) {
  if (!event || typeof event !== 'object') return event;
  const scoped = {
    ...event,
    runId: scope,
  };
  for (const key of ['id', 'stepId', 'segmentId', 'toolCallId', 'requestId']) {
    if (event[key] != null && event[key] !== '') {
      scoped[key] = namespaceRuntimeId(event[key], scope);
    }
  }
  if (event.permission && typeof event.permission === 'object') {
    scoped.permission = { ...event.permission };
    for (const key of ['id', 'toolCallId']) {
      if (event.permission[key] != null && event.permission[key] !== '') {
        scoped.permission[key] = namespaceRuntimeId(event.permission[key], scope);
      }
    }
  }
  return scoped;
}

function namespaceRuntimeId(value, scope) {
  const text = String(value);
  const prefix = `${scope}:`;
  return text.startsWith(prefix) ? text : `${prefix}${text}`;
}

function scheduledTurnContinuation(result = {}) {
  const content = String(result?.content || '').trim()
    || 'A future continuation was scheduled.';
  const toolCalls = Array.isArray(result?.toolCalls)
    ? result.toolCalls.filter((toolCall) => toolCall?.name !== 'schedule_wakeup')
    : [];
  if (toolCalls.length === 0) return content;

  // Retain the newest calls first: command job ids and nextCursor values near
  // the wake-up are more useful than an early, bulky lookup. Keeping each
  // continuation small also prevents repeated wake-ups from crowding a 32k
  // model context solely with copied tool results.
  const latestCommand = latestCommandContinuation(toolCalls);
  let compactTools = [];
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];
    const candidate = {
      name: truncateRuntimeContinuationValue(toolCall?.name || 'unknown_tool', 128),
      status: truncateRuntimeContinuationValue(toolCall?.status || '', 64) || null,
      input: truncateRuntimeContinuationValue(
        safeJsonStringify(toolCall?.parsedArgs ?? safeParsedToolInput(toolCall?.rawArgs)),
        MAX_WAKEUP_CONTINUATION_TOOL_INPUT_CHARS
      ),
      result: truncateRuntimeContinuationValue(
        toolCall?.result ?? toolCall?.terminalOutput ?? '',
        MAX_WAKEUP_CONTINUATION_TOOL_RESULT_CHARS
      ),
    };
    const nextTools = [candidate, ...compactTools];
    const nextPayload = {
      ...(latestCommand ? { latestCommand } : {}),
      omittedEarlierToolCalls: index,
      toolCalls: nextTools,
    };
    if (safeJsonStringify(nextPayload).length > MAX_WAKEUP_CONTINUATION_TOOL_CHARS) break;
    compactTools = nextTools;
  }
  const serialized = safeJsonStringify({
    ...(latestCommand ? { latestCommand } : {}),
    omittedEarlierToolCalls: toolCalls.length - compactTools.length,
    toolCalls: compactTools,
  });
  return [
    content,
    'Tool history from the turn that scheduled this continuation:',
    serialized,
  ].join('\n\n');
}

function latestCommandContinuation(toolCalls) {
  const toolCall = toolCalls.findLast((candidate) => (
    COMMAND_CONTINUATION_TOOL_NAMES.has(candidate?.name)
  ));
  if (!toolCall) return null;
  const state = commandContinuationState(toolCall).commandState;
  return {
    name: truncateRuntimeContinuationValue(toolCall.name, 128),
    input: truncateRuntimeContinuationValue(
      safeJsonStringify(toolCall?.parsedArgs ?? safeParsedToolInput(toolCall?.rawArgs)),
      MAX_WAKEUP_CONTINUATION_TOOL_INPUT_CHARS
    ),
    ...(state ? { state } : {}),
  };
}

function commandContinuationState(toolCall) {
  if (!COMMAND_CONTINUATION_TOOL_NAMES.has(toolCall?.name)) return {};
  const rawResult = toolCall?.result ?? toolCall?.terminalOutput;
  let result = rawResult;
  if (typeof rawResult === 'string') {
    try {
      result = JSON.parse(rawResult);
    } catch {
      return {};
    }
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {};

  const state = {};
  for (const key of [
    'job_id',
    'status',
    'nextCursor',
    'logCursor',
    'logSize',
    'hasMore',
    'exit_code',
    'signal',
    'error',
  ]) {
    const value = result[key];
    if (value == null) continue;
    state[key] = typeof value === 'string'
      ? truncateRuntimeContinuationValue(value, key === 'error' ? 500 : 256)
      : value;
  }
  return Object.keys(state).length > 0 ? { commandState: state } : {};
}

function safeParsedToolInput(rawArgs) {
  if (!rawArgs) return {};
  try {
    return JSON.parse(rawArgs);
  } catch {
    return String(rawArgs);
  }
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[Tool history could not be serialized]';
  }
}

function truncateRuntimeContinuationValue(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  const marker = '\n...[truncated]';
  return `${text.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
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

async function waitCommandInSlices(waitCommand, input, context) {
  const jobId = input.job_id;
  const cursor = Number(input.cursor) || 0;
  const requestedSeconds = Math.min(MAX_WAIT_SECONDS, Math.max(1, Math.round(Number(input.wait_seconds) || 30)));
  const budgetMs = Math.min(requestedSeconds * 1000, SANDBOX_WAIT_TOOL_BUDGET_MS);
  // Surfaces the effective per-call budget so the replayed UI counts down the
  // time this call can actually block instead of the full requested wait.
  context?.onToolUpdate?.({ waitBudgetSeconds: Math.round(budgetMs / 1000) });
  let waitedMs = 0;
  let result = null;
  while (waitedMs < budgetMs) {
    const sliceMs = Math.min(SANDBOX_WAIT_SLICE_MS, budgetMs - waitedMs);
    result = await waitCommand(jobId, { cursor, waitMs: sliceMs, signal: context?.signal });
    if (!result || typeof result !== 'object') return result;
    // The underlying wait already returns early on new output; surface that
    // immediately instead of draining further slices.
    if (WAIT_TERMINAL_STATUSES.has(result.status) || (result.logSize || 0) > (result.logCursor || 0)) {
      return result;
    }
    waitedMs += sliceMs;
    if (waitedMs < budgetMs) {
      // Emits a tool-status event: keeps the run idle watchdog and the
      // replayed UI aware that the wait is still making progress.
      context?.onToolUpdate?.({
        waitedSeconds: Math.round(waitedMs / 1000),
        remainingSeconds: requestedSeconds - Math.round(waitedMs / 1000),
      });
    }
  }
  const waitedSeconds = Math.round(waitedMs / 1000);
  const remainingSeconds = requestedSeconds - waitedSeconds;
  if (remainingSeconds > 0) {
    return {
      ...result,
      wait: {
        requested_seconds: requestedSeconds,
        waited_seconds: waitedSeconds,
        remaining_seconds: remainingSeconds,
        incomplete: true,
        note: 'This sandbox runtime serves waits in bounded slices to stay inside stream and idle timeouts. Call wait_command again with the same job_id and cursor to keep waiting, or schedule_wakeup to end the turn now and resume when the job should be done.',
      },
    };
  }
  return result;
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
  webSearch = runWebSearch,
  webFetch = fetchWebPage,
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
      const { command, job_id: jobId } = input;
      if (command && jobId) {
        throw new Error('wait_command: pass either command (start a new job and wait) or job_id (wait on an existing job), not both.');
      }
      if (command) {
        if (!startCommand) throw new Error('Managed background commands are unavailable.');
        const job = await startCommand(command);
        const result = await waitCommandInSlices(waitCommand, {
          job_id: job.job_id,
          cursor: 0,
          wait_seconds: input.wait_seconds,
        }, context);
        return JSON.stringify(result, null, 2);
      }
      if (!jobId) {
        throw new Error('wait_command: pass command (start a new job and wait) or job_id (wait on an existing job).');
      }
      const result = await waitCommandInSlices(waitCommand, input, context);
      return result ? JSON.stringify(result, null, 2) : `Background command not found: ${jobId}`;
    }
    if (name === 'stop_command') {
      if (!stopCommand) throw new Error('Managed background commands are unavailable.');
      const result = await stopCommand(input.job_id);
      return result ? JSON.stringify(result, null, 2) : `Background command not found: ${input.job_id}`;
    }
    if (name === 'list_sandbox_files') return JSON.stringify(await listFiles(input.path || ''), null, 2);
    if (name === 'read_sandbox_file') return readFile(input.path);
    if (name === 'display_sandbox_image') {
      const { parent, name: filename } = splitFilePath(input.path);
      const listing = await listFiles(parent);
      const entries = Array.isArray(listing) ? listing : listing?.children;
      const entry = entries?.find((item) => item.name === filename);
      if (!entry || entry.type === 'directory') return `Sandbox image not found: ${input.path}`;
      const mimeType = imageMimeFromPath(input.path);
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
    if (name === 'skill') {
      return dispatchSandboxSkill(input, { listFiles, readFile, writeFile });
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
    if (name === 'web_search') {
      const searchConfig = context?.searchConfig;
      if (!searchConfig?.provider) {
        return 'Web search is not configured for this run. Complete the setup in the browser Settings → Web Search, then start a new run.';
      }
      const result = await webSearch(searchConfig, {
        query: input.query,
        maxResults: input.max_results,
        allowedDomains: input.allowed_domains,
        blockedDomains: input.blocked_domains,
      }, { signal: context?.signal });
      return formatSearchResults(result);
    }
    if (name === 'web_fetch') {
      const page = await webFetch(input.url, {
        maxChars: input.max_chars,
        signal: context?.signal,
      });
      return formatWebPageForModel(page);
    }
    throw new Error(`Tool is unavailable in sandbox runtime: ${name}`);
  };
}

/**
 * Validate the browser-supplied search execution config. Runs persist in 0600
 * files while waiting, matching the model credential handling.
 */
function normalizeRuntimeSearchConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!value.provider || typeof value.provider !== 'string') return null;
  const maxResults = Number(value.maxResults);
  return {
    provider: value.provider,
    ...(typeof value.apiKey === 'string' && value.apiKey ? { apiKey: value.apiKey } : {}),
    ...(typeof value.baseUrl === 'string' && value.baseUrl ? { baseUrl: value.baseUrl } : {}),
    ...(Number.isFinite(maxResults) && maxResults > 0 ? { maxResults: Math.floor(maxResults) } : {}),
  };
}

async function dispatchSandboxSkill(input, fileApi) {
  try {
    if (input.action === 'list') {
      return formatSkills(await searchSandboxSkills(input.query || '', fileApi));
    }

    if (input.action === 'read') {
      if (!input.name) return 'Skill error: name is required for read.';
      const skillName = normalizeSkillName(input.name);
      if (input.reference_name) {
        const referenceName = normalizeReferenceName(input.reference_name);
        const content = await readSandboxText(
          fileApi.readFile,
          `skills/${skillName}/references/${referenceName}`
        );
        return content == null
          ? `Skill or reference not found: ${skillName}/${referenceName}`
          : formatReferenceContent(skillName, referenceName, content);
      }

      const content = await readSandboxText(fileApi.readFile, `skills/${skillName}/SKILL.md`);
      if (content == null) return `Skill or reference not found: ${skillName}`;
      const refs = await listSandboxSkillReferences(skillName, fileApi.listFiles);
      return refs.length
        ? `${truncateText(content, MAX_SKILL_CONTENT_CHARS)}\n\n## Available References\n${refs.map((ref) => `- ${ref.name}`).join('\n')}`
        : truncateText(content, MAX_SKILL_CONTENT_CHARS);
    }

    if (input.action === 'write') {
      if (!input.name) return 'Skill error: name is required for write.';
      if (!input.content?.trim()) return 'Skill error: content is required for write.';
      const skillName = normalizeSkillName(input.name);

      if (input.reference_name) {
        const referenceName = normalizeReferenceName(input.reference_name);
        const existing = await readSandboxText(fileApi.readFile, `skills/${skillName}/SKILL.md`);
        if (existing == null) {
          return `Skill error: Skill "${skillName}" does not exist. Write SKILL.md before writing references.`;
        }
        const content = String(input.content);
        if (content.length > MAX_SKILL_REFERENCE_CHARS) {
          return `Skill error: Reference content is too large (${content.length}/${MAX_SKILL_REFERENCE_CHARS} chars).`;
        }
        await fileApi.writeFile(`skills/${skillName}/references/${referenceName}`, content);
        return `Successfully wrote sandbox skill reference ${skillName}/${referenceName}.`;
      }

      validateSkillContent(skillName, input.content);
      await fileApi.writeFile(`skills/${skillName}/SKILL.md`, String(input.content));
      return `Successfully wrote sandbox skill ${skillName}.`;
    }

    return `Unknown skill action: ${input.action}`;
  } catch (error) {
    return `Skill error: ${error.message}`;
  }
}

async function searchSandboxSkills(query, { listFiles, readFile }) {
  const skills = await listSandboxSkills({ listFiles, readFile });
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return skills;
  return skills
    .map((skill) => ({ skill, score: scoreSkill(skill, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .map((item) => item.skill);
}

async function listSandboxSkills({ listFiles, readFile }) {
  let entries;
  try {
    entries = runtimeDirectoryEntries(await listFiles('skills'));
  } catch {
    return [];
  }

  const skills = [];
  for (const entry of entries) {
    if (entry.type !== 'directory') continue;
    const skillName = safeDirectorySkillName(entry.name);
    if (!skillName) continue;
    const content = await readSandboxText(readFile, `skills/${skillName}/SKILL.md`);
    if (!content) continue;
    const meta = parseFrontmatter(content);
    const references = await listSandboxSkillReferences(skillName, listFiles);
    skills.push({
      name: normalizeSkillName(meta.name || skillName),
      description: String(meta.description || 'No description provided').trim(),
      version: String(meta.version || '1.0.0').trim(),
      source: 'sandbox',
      references,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

async function listSandboxSkillReferences(skillName, listFiles) {
  try {
    return runtimeDirectoryEntries(await listFiles(`skills/${skillName}/references`))
      .filter((entry) => entry.type !== 'directory')
      .map((entry) => ({ name: entry.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function runtimeDirectoryEntries(listing) {
  if (Array.isArray(listing)) return listing;
  return Array.isArray(listing?.children) ? listing.children : [];
}

async function readSandboxText(readFile, path) {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

function validateRunInput(input) {
  // Validation failures map to the HTTP-shaped 400 the previous REST route
  // returned; the WebSocket reply layer forwards numeric codes verbatim.
  const invalid = (message) => {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  };
  if (!input || typeof input !== 'object') invalid('Run body must be an object.');
  if (!input.sessionId) invalid('sessionId is required.');
  if (input.runId !== undefined && !/^run-[A-Za-z0-9-]{6,128}$/.test(String(input.runId))) {
    invalid('runId must be a valid client-generated run id.');
  }
  if (!Array.isArray(input.messages) || input.messages.length > MAX_MESSAGES) invalid('messages must be a bounded array.');
  let totalMessageBytes = 0;
  for (const [index, message] of input.messages.entries()) {
    if (typeof message?.content !== 'string') {
      invalid(`messages[${index}].content must be a string.`);
    }
    const messageBytes = Buffer.byteLength(message.content);
    if (messageBytes > MAX_MESSAGE_CONTENT_BYTES) {
      invalid(`messages[${index}].content exceeds ${MAX_MESSAGE_CONTENT_BYTES} bytes.`);
    }
    totalMessageBytes += messageBytes;
  }
  if (totalMessageBytes > MAX_MESSAGES_CONTENT_BYTES) {
    invalid(`Message content exceeds ${MAX_MESSAGES_CONTENT_BYTES} bytes in total.`);
  }
  const model = input.modelConfig;
  if (!model?.provider || !model?.model || !model?.apiKey) invalid('A complete modelConfig is required.');
  validateRuntimeFiles(input.runtimeContext?.sandboxFiles);
}

/** Apply a continuation's optional model/search overrides onto a run input. */
function applyContinueOverrides(input, continuation) {
  if (continuation.modelConfig !== undefined) {
    const model = continuation.modelConfig;
    if (!model?.provider || !model?.model || !model?.apiKey) {
      const error = new Error('A complete modelConfig is required.');
      error.statusCode = 400;
      throw error;
    }
    input.modelConfig = model;
  }
  if (Object.prototype.hasOwnProperty.call(continuation, 'searchConfig')) {
    input.searchConfig = continuation.searchConfig ?? null;
  }
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
  const existingSandboxSkills = new Set();
  const skillNames = new Set(
    files
      .map((file) => sandboxSnapshotSkillName(file.path))
      .filter(Boolean)
  );
  for (const skillName of skillNames) {
    if (await runtimeFileExists(`skills/${skillName}/SKILL.md`, { fileExists, readFile })) {
      existingSandboxSkills.add(skillName);
    }
  }

  for (const file of files) {
    const skillName = sandboxSnapshotSkillName(file.path);
    if (skillName && existingSandboxSkills.has(skillName)) continue;
    if (skillName) {
      await writeFile(file.path, file.content);
      continue;
    }
    const exists = await runtimeFileExists(file.path, { fileExists, readFile });
    if (!exists) await writeFile(file.path, file.content);
  }
}

function sandboxSnapshotSkillName(path) {
  const parts = String(path || '').split('/');
  return parts[0] === 'skills' && parts.length >= 3 ? parts[1] : null;
}

async function runtimeFileExists(path, { fileExists, readFile }) {
  if (fileExists) return fileExists(path);
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeRuntimeContext(value) {
  // Durable resume state stores a missing runtimeContext as null.
  const source = value || {};
  return {
    workspaceDirName: source.workspaceDirName || null,
    activeAgent: source.activeAgent ? { id: source.activeAgent.id, name: source.activeAgent.name } : null,
    memorySnapshot: source.memorySnapshot || { memory: null, user: null },
    skillsList: source.skillsList || '',
    agentIdentity: source.agentIdentity || null,
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

function canResumeWaitingRun(saved) {
  // A waiting run survives a restart only when its durable resume state is
  // complete enough to continue the loop: the wake-up still pending, the
  // conversation so far, the turn that scheduled it, and the model request.
  const resume = saved?.resume;
  return Boolean(
    saved?.status === 'waiting'
    && saved?.wakeup
    && Number.isFinite(saved.wakeup.runAtMs)
    && resume
    && Array.isArray(resume.runtimeMessages)
    && Number.isInteger(resume.turnNumber)
    && resume.input
    && resume.input.modelConfig
  );
}

function loadPersistedRuns(runsDir, runs, { retentionMs = DEFAULT_RUN_RETENTION_MS } = {}) {
  const cutoff = Date.now() - Math.max(1, retentionMs);
  for (const name of readdirSync(runsDir).filter((entry) => entry.endsWith('.json'))) {
    try {
      const saved = JSON.parse(readFileSync(join(runsDir, name), 'utf8'));
      if (!saved?.id) continue;
      const isTerminal = ['completed', 'error', 'aborted', 'interrupted', 'superseded'].includes(saved.status);
      if (isTerminal && Date.parse(saved.updatedAt || '') < cutoff) {
        removeRunFiles(runsDir, saved.id);
        continue;
      }
      const eventsPath = join(runsDir, `${saved.id}.events.ndjson`);
      const events = existsSync(eventsPath)
        ? readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((line) => {
          const stored = JSON.parse(line);
          if (stored?.v === 2 && stored.ev) {
            return { seq: Number(stored.seq) || 0, turn: Number(stored.turn) || 0, ev: stored.ev };
          }
          // Legacy protocol-3 lines are already namespaced and sequenced.
          return { seq: Number(stored?.remoteSequence) || 0, decorated: true, ev: stored };
        })
        : [];
      const resumable = canResumeWaitingRun(saved);
      const interruptedByRestart = ['running', 'waiting'].includes(saved.status) && !resumable;
      const keepResume = resumable || (saved.status === 'idle' && saved.resume);
      runs.set(saved.id, {
        ...saved,
        resume: keepResume ? saved.resume : null,
        status: interruptedByRestart ? 'interrupted' : saved.status,
        error: interruptedByRestart ? 'Agent server restarted before the run completed.' : saved.error,
        // Retention counts from the restart for runs that only became terminal
        // during this load, so a restart cannot immediately erase them.
        ...(interruptedByRestart ? { updatedAt: new Date().toISOString() } : {}),
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

function removeRunFiles(runsDir, runId) {
  if (!/^[\w.-]+$/.test(String(runId || ''))) return;
  for (const suffix of ['.json', '.json.tmp', '.events.ndjson']) {
    try {
      rmSync(join(runsDir, `${runId}${suffix}`), { force: true });
    } catch {
      // Best effort; a leftover file ages out with the next prune pass.
    }
  }
}

export { REMOTE_TOOL_SCHEMAS };
