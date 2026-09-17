/**
 * Reproduce "upload image → Agent run not found".
 * Simulates the browser's exact payload shapes against the run manager.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { createAgentRunManager } from '/root/CherryAgent/server/agent-runtime.js';

const tinyPng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function recordingModel() {
  const prompts = [];
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      prompts.push(prompt);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'answer' },
            { type: 'text-delta', id: 'answer', delta: 'ok' },
            { type: 'text-end', id: 'answer' },
            { type: 'finish', finishReason: { unified: 'stop' }, usage },
          ],
        }),
      };
    },
  });
  return { model, prompts };
}

function createManager(runsDir, overrides = {}) {
  return createAgentRunManager({
    runsDir,
    execCommand: async () => ({ stdout: '', stderr: '', code: 0 }),
    startCommand: async () => ({ job_id: 'job-one', status: 'running' }),
    getCommand: async () => ({ job_id: 'job-one', status: 'running' }),
    waitCommand: async () => ({ job_id: 'job-one', status: 'running' }),
    stopCommand: async () => ({ job_id: 'job-one', status: 'stopped' }),
    listFiles: async () => [],
    readFile: async () => '',
    writeFile: async () => {},
    ...overrides,
  });
}

async function waitForRunStatus(manager, id, expected) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const run = manager.get(id);
    if (run?.status === expected) return run;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Run ${id} stuck at ${manager.get(id)?.status}`);
}

const runsDir = mkdtempSync(join(tmpdir(), 'cherry-repro-'));
try {
  const written = [];
  const { model, prompts } = recordingModel();
  const manager = createManager(runsDir, {
    createModel: () => model,
    writeFile: async (path, content) => { written.push(path); },
    fileExists: async () => false,
  });

  // ── Turn 1: browser sends run.start with a user message carrying an image ──
  const started = manager.start({
    runId: 'run-repro-one',
    sessionId: 'session-repro',
    replyId: 'reply-1',
    messages: [
      { id: 'user-1', role: 'user', content: 'look at this', images: [{ name: 'dot.png', dataUrl: tinyPng }] },
    ],
    modelConfig: { provider: 'openai', model: 'test', apiKey: 'test' },
  });
  await waitForRunStatus(manager, started.id, 'idle');
  console.log('turn1 attachments written:', written);
  console.log('turn1 last prompt has image part:',
    JSON.stringify(prompts[0].at(-1)).includes('image'));

  // ── Turn 2: browser continue path (App.jsx sends content string ONLY) ──
  const continued = manager.continue({
    runId: started.id,
    replyId: 'reply-2',
    message: 'and this one', // ← images field dropped by the browser payload
    userMessageCount: 2,
    modelConfig: { provider: 'openai', model: 'test', apiKey: 'test' },
  });
  await waitForRunStatus(manager, continued.id, 'idle');
  console.log('turn2 attachments written:', written);
  const turn2Last = JSON.stringify(prompts[1].at(-1));
  console.log('turn2 last prompt has image part:', turn2Last.includes('image'));
  console.log('turn2 last prompt:', turn2Last.slice(0, 400));

  // ── Scenario B: server restart wipes runs; browser continue gets 404 ──
  const runsDir2 = mkdtempSync(join(tmpdir(), 'cherry-repro2-'));
  const manager2 = createManager(runsDir2, { createModel: () => model });
  try {
    manager2.continue({ runId: started.id, message: 'hello?', userMessageCount: 2 });
    console.log('B: continue unexpectedly succeeded');
  } catch (error) {
    console.log('B: continue after restart →', error.statusCode, JSON.stringify(error.message));
  }

  // ── Scenario C: run.start rejected (validation) + browser probe fallback ──
  try {
    manager2.start({
      runId: 'run-repro-rejected',
      sessionId: 'session-repro',
      messages: [{ role: 'user', content: 'x' }],
      modelConfig: { provider: 'openai', model: 'test', apiKey: '' }, // invalid → 400
    });
  } catch (startError) {
    console.log('C: run.start rejected →', startError.statusCode, JSON.stringify(startError.message));
    // App.jsx: agentRunRequestStarted=true → probe run.state
    const probed = manager2.get('run-repro-rejected', 0);
    console.log('C: browser probe get() →', probed === null ? 'null → ws-runs throws 404 "Agent run not found"' : 'found');
  }

  rmSync(runsDir2, { recursive: true, force: true });
} finally {
  rmSync(runsDir, { recursive: true, force: true });
}
