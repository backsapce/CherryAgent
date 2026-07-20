import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentRunManager, createRuntimeToolDispatcher, materializeMessageImages, materializeRuntimeFiles, REMOTE_TOOL_SCHEMAS } from './agent-runtime.js';

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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const run = manager.get(id);
    if (run?.status === expected) return run;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Run ${id} did not reach ${expected}; current status is ${manager.get(id)?.status}`);
}

test('sandbox runtime exposes no browser-owned tools', () => {
  assert.deepEqual(
    REMOTE_TOOL_SCHEMAS.map((tool) => tool.name),
    [
      'execute_command',
      'start_command',
      'get_command',
      'wait_command',
      'stop_command',
      'list_sandbox_files',
      'read_sandbox_file',
      'display_sandbox_image',
      'write_sandbox_file',
      'schedule_wakeup',
    ]
  );
  assert.match(
    REMOTE_TOOL_SCHEMAS.find((tool) => tool.name === 'execute_command').description,
    /NEVER use for training/
  );
  assert.match(
    REMOTE_TOOL_SCHEMAS.find((tool) => tool.name === 'start_command').description,
    /unknown duration/
  );
});

test('sandbox background command dispatch preserves job ids, cursors, waits, and stops', async () => {
  const calls = [];
  const dispatch = createRuntimeToolDispatcher({
    execCommand: async () => ({ stdout: '', stderr: '', code: 0 }),
    startCommand: async (command) => {
      calls.push(['start', command]);
      return { job_id: 'job-one', status: 'running', nextCursor: 0 };
    },
    getCommand: async (id, cursor) => {
      calls.push(['get', id, cursor]);
      return { job_id: id, status: 'running', nextCursor: cursor + 5 };
    },
    waitCommand: async (id, options) => {
      calls.push(['wait', id, options.cursor, options.waitMs, options.signal]);
      return { job_id: id, status: 'completed', nextCursor: options.cursor };
    },
    stopCommand: async (id) => {
      calls.push(['stop', id]);
      return { job_id: id, status: 'stopped' };
    },
    listFiles: async () => [],
    readFile: async () => '',
    writeFile: async () => {},
  });
  const controller = new AbortController();

  assert.equal(JSON.parse(await dispatch('start_command', { command: 'python train.py' })).job_id, 'job-one');
  assert.equal(JSON.parse(await dispatch('get_command', { job_id: 'job-one', cursor: 10 })).nextCursor, 15);
  assert.equal(JSON.parse(await dispatch('wait_command', {
    job_id: 'job-one', cursor: 15, wait_seconds: 12,
  }, { signal: controller.signal })).status, 'completed');
  assert.equal(JSON.parse(await dispatch('stop_command', { job_id: 'job-one' })).status, 'stopped');
  assert.deepEqual(calls.slice(0, 2), [
    ['start', 'python train.py'],
    ['get', 'job-one', 10],
  ]);
  assert.deepEqual(calls[2].slice(0, 4), ['wait', 'job-one', 15, 12_000]);
  assert.strictEqual(calls[2][4], controller.signal);
  assert.deepEqual(calls[3], ['stop', 'job-one']);
});

test('sandbox wake-up dispatch delegates scheduling to the run manager', async () => {
  const dispatch = createRuntimeToolDispatcher({
    execCommand: async () => ({ stdout: '', stderr: '', code: 0 }),
    listFiles: async () => [],
    readFile: async () => '',
    writeFile: async () => {},
  });
  const result = JSON.parse(await dispatch('schedule_wakeup', {
    delay: 10,
    unit: 'minutes',
    prompt: 'check build',
  }, {
    scheduleWakeup: async ({ delaySeconds, prompt }) => ({
      id: 'wake-one',
      runAtMs: 1_000 + delaySeconds * 1_000,
      prompt: `${prompt}:${delaySeconds}`,
    }),
  }));
  assert.deepEqual(result, {
    scheduled: true,
    wakeup_id: 'wake-one',
    delay: { value: 10, unit: 'minutes' },
    delay_seconds: 600,
    run_at: '1970-01-01T00:10:01.000Z',
    prompt: 'check build:600',
  });
});

test('sandbox run reuses duplicate wake-ups and replaces a changed request in one turn', async () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'vertex-runs-'));
  try {
    const manager = createManager(runsDir, {
      createModel: () => ({}),
      async runAgent({ scheduleWakeup }) {
        const first = await scheduleWakeup({ delaySeconds: 600, prompt: 'check build' });
        const duplicate = await scheduleWakeup({ delaySeconds: 600, prompt: ' check build ' });
        const replacement = await scheduleWakeup({ delaySeconds: 900, prompt: 'check later' });

        assert.strictEqual(duplicate, first);
        assert.equal(replacement.id, first.id);
        return { content: 'scheduled' };
      },
    });
    const started = manager.start({
      runId: 'run-repeated-wakeup',
      sessionId: 'session-repeated-wakeup',
      replyId: 'reply-repeated-wakeup',
      messages: [{ role: 'user', content: 'monitor the build' }],
      modelConfig: { provider: 'openai', model: 'test', apiKey: 'test' },
    });

    const waiting = await waitForRunStatus(manager, started.id, 'waiting');
    assert.equal(waiting.wakeup.prompt, 'check later');
    assert.equal(waiting.wakeup.runAtMs - waiting.wakeup.createdAtMs, 900_000);
    assert.equal(waiting.error, null);
    await manager.abort(started.id);
    await waitForRunStatus(manager, started.id, 'aborted');
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test('sandbox image display returns a reference without image content', async () => {
  const dispatch = createRuntimeToolDispatcher({
    execCommand: async () => ({ stdout: '', stderr: '', code: 0 }),
    listFiles: async () => [{ name: 'result.png', type: 'file', size: 1234 }],
    readFile: async () => '',
    writeFile: async () => {},
  });

  const result = await dispatch('display_sandbox_image', { path: 'images/result.png', alt: 'Result' });
  assert.deepEqual(JSON.parse(result), {
    kind: 'image_reference',
    source: 'sandbox',
    path: 'images/result.png',
    name: 'result.png',
    mime_type: 'image/png',
    size: 1234,
  });
  assert.doesNotMatch(result, /base64|data_url|data:image/i);
});

test('sandbox command dispatch passes cancellation as an exec option', async () => {
  const controller = new AbortController();
  let received;
  const dispatch = createRuntimeToolDispatcher({
    execCommand: async (command, options) => {
      received = { command, options };
      options.onStdout('first\n');
      options.onStderr('warning\n');
      options.onStdout('last\n');
      return { stdout: 'first\nlast\n', stderr: 'warning\n', code: 0 };
    },
    listFiles: async () => [],
    readFile: async () => '',
    writeFile: async () => {},
  });

  const updates = [];
  const result = await dispatch(
    'execute_command',
    { command: 'printf ok' },
    { signal: controller.signal, onToolUpdate: (update) => updates.push(update) }
  );

  assert.equal(received.command, 'printf ok');
  assert.strictEqual(received.options.signal, controller.signal);
  assert.match(result, /Exit code: 0/);
  assert.match(result, /Stdout:\nfirst\nlast/);
  assert.match(result, /Stderr:\nwarning/);
  assert.equal(typeof received.options.onStdout, 'function');
  assert.equal(typeof received.options.onStderr, 'function');
  assert.deepEqual(updates.slice(0, -1), [
    { stdout: 'first\n' },
    { stderr: 'warning\n' },
    { stdout: 'last\n' },
  ]);
  assert.deepEqual(updates.at(-1), {
    exitCode: 0,
    platform: undefined,
    shell: undefined,
    cwd: undefined,
    filesRoot: undefined,
  });
});

test('sandbox startup snapshot writes only missing identity and skill files', async () => {
  const stored = new Map([['AGENTS.md', 'sandbox identity']]);
  await materializeRuntimeFiles([
    { path: 'AGENTS.md', content: 'browser identity' },
    { path: 'skills/review/SKILL.md', content: '# Review' },
    { path: 'skills/review/references/checks.md', content: 'Check everything.' },
  ], {
    fileExists: async (path) => stored.has(path),
    readFile: async (path) => stored.get(path),
    writeFile: async (path, content) => stored.set(path, content),
  });

  assert.equal(stored.get('AGENTS.md'), 'sandbox identity');
  assert.equal(stored.get('skills/review/SKILL.md'), '# Review');
  assert.equal(stored.get('skills/review/references/checks.md'), 'Check everything.');
});

test('sandbox startup snapshot rejects paths outside identity and skills', async () => {
  await assert.rejects(
    materializeRuntimeFiles(
      [{ path: 'skills/../secret', content: 'nope' }],
      { fileExists: async () => false, readFile: async () => '', writeFile: async () => {} }
    ),
    /AGENTS\.md or skills/
  );
});

test('message images are materialized as binary sandbox attachments with model-visible paths', async () => {
  const stored = new Map();
  const messages = [{
    id: 'user/message 1',
    role: 'user',
    content: 'Use this image',
    images: [{ name: 'source photo.png', dataUrl: 'data:image/png;base64,aGVsbG8=' }],
  }];

  const result = await materializeMessageImages(messages, {
    fileExists: async (path) => stored.has(path),
    writeFile: async (path, content) => stored.set(path, content),
    attachmentScope: 'run-test-scope',
  });

  const path = 'attachments/run-test-scope/user-message-1/1-source-photo.png';
  assert.equal(stored.get(path).toString('utf8'), 'hello');
  assert.match(result[0].content, /Sandbox attachment files/);
  assert.match(result[0].content, new RegExp(path));
  assert.equal(result[0].images[0].dataUrl, messages[0].images[0].dataUrl);
});

test('existing sandbox attachments are reused on later runs', async () => {
  let writes = 0;
  const result = await materializeMessageImages([{
    id: 'stable-id',
    role: 'user',
    images: [{ name: 'photo.jpg', dataUrl: 'data:image/jpeg;base64,aGVsbG8=' }],
  }], {
    fileExists: async () => true,
    writeFile: async () => { writes += 1; },
  });

  assert.equal(writes, 0);
  assert.match(result[0].content, /attachments\/stable-id\/1-photo\.jpg/);
});

test('persisted runs and event logs can be recovered after reconnect', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'vertex-runs-'));
  try {
    const run = {
      id: 'run-reconnect',
      sessionId: 'session-one',
      replyId: 'reply-one',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
      sequence: 1,
      result: { content: 'done' },
      error: null,
    };
    writeFileSync(join(runsDir, `${run.id}.json`), JSON.stringify(run));
    writeFileSync(join(runsDir, `${run.id}.events.ndjson`), `${JSON.stringify({ type: 'text-delta', text: 'done', remoteSequence: 1 })}\n`);

    const manager = createManager(runsDir);
    assert.equal(manager.list('session-one')[0].result.content, 'done');
    assert.deepEqual(manager.get(run.id, 0).events.map((event) => event.text), ['done']);
    assert.deepEqual(manager.get(run.id, 1).events, []);
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test('sandbox runs execute concurrently with isolated events, cancellation, and completion', async () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'vertex-runs-'));
  const active = new Map();
  let releaseBothStarted;
  const bothStarted = new Promise((resolve) => { releaseBothStarted = resolve; });
  const createdModels = [];

  try {
    const manager = createManager(runsDir, {
      createModel(modelConfig) {
        const model = { owner: modelConfig.model };
        createdModels.push(model.owner);
        return model;
      },
      runAgent({ agentId, languageModel, signal, onEvent }) {
        return new Promise((resolve, reject) => {
          const abort = () => {
            const error = new Error(`aborted ${agentId}`);
            error.name = 'AbortError';
            reject(error);
          };
          signal.addEventListener('abort', abort, { once: true });
          active.set(agentId, {
            languageModel,
            signal,
            emit: onEvent,
            complete(result) {
              signal.removeEventListener('abort', abort);
              resolve(result);
            },
          });
          if (active.size === 2) releaseBothStarted();
        });
      },
    });
    const input = (sessionId) => ({
      runId: `run-client-${sessionId}`,
      sessionId,
      replyId: `reply-${sessionId}`,
      agentId: sessionId,
      messages: [{ role: 'user', content: `start ${sessionId}` }],
      modelConfig: {
        provider: 'openai',
        model: `model-${sessionId}`,
        apiKey: `key-${sessionId}`,
      },
    });

    const first = manager.start(input('session-one'));
    const second = manager.start(input('session-two'));
    await bothStarted;

    assert.equal(first.id, 'run-client-session-one');
    assert.equal(second.id, 'run-client-session-two');
    assert.equal(manager.start(input('session-one')).id, first.id);
    assert.throws(
      () => manager.start({ ...input('session-one'), runId: 'run-client-session-one-duplicate' }),
      /already has an active agent run/
    );
    await manager.abort('run-client-cancelled-before-start');
    assert.throws(
      () => manager.start({ ...input('session-three'), runId: 'run-client-cancelled-before-start' }),
      /cancelled before it started/
    );
    assert.equal(manager.get(first.id).status, 'running');
    assert.equal(manager.get(second.id).status, 'running');
    assert.deepEqual(createdModels.sort(), ['model-session-one', 'model-session-two']);
    assert.equal(active.get('session-one').languageModel.owner, 'model-session-one');
    assert.equal(active.get('session-two').languageModel.owner, 'model-session-two');
    assert.notStrictEqual(active.get('session-one').signal, active.get('session-two').signal);

    active.get('session-one').emit({ type: 'text-delta', text: 'one-only' });
    active.get('session-two').emit({ type: 'text-delta', text: 'two-first' });
    assert.deepEqual(manager.get(first.id).events.map((event) => event.text), ['one-only']);
    assert.deepEqual(manager.get(second.id).events.map((event) => event.text), ['two-first']);

    const abortingFirst = manager.abort(first.id);
    assert.throws(
      () => manager.start({ ...input('session-one'), runId: 'run-client-session-one-while-aborting' }),
      /already has an active agent run/
    );
    await abortingFirst;
    const aborted = await waitForRunStatus(manager, first.id, 'aborted');
    assert.equal(active.get('session-one').signal.aborted, true);
    assert.equal(active.get('session-two').signal.aborted, false);
    assert.match(aborted.error, /aborted session-one/);
    assert.equal(manager.get(second.id).status, 'running');

    active.get('session-two').emit({ type: 'text-delta', text: 'two-after-abort' });
    active.get('session-two').complete({ content: 'session two completed' });
    const completed = await waitForRunStatus(manager, second.id, 'completed');

    assert.deepEqual(completed.result, { content: 'session two completed' });
    assert.deepEqual(manager.get(second.id).events.map((event) => event.text), [
      'two-first',
      'two-after-abort',
    ]);
    assert.deepEqual(manager.get(second.id).events.map((event) => event.remoteSequence), [1, 2]);
    assert.deepEqual(manager.get(first.id).events.map((event) => event.remoteSequence), [1]);
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test('sandbox abort returns within a bound when a provider ignores cancellation', async () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'vertex-runs-'));
  try {
    let receivedSignal;
    const manager = createManager(runsDir, {
      abortWaitMs: 10,
      runAgent({ signal }) {
        receivedSignal = signal;
        return new Promise(() => {});
      },
      createModel: () => ({}),
    });
    const started = manager.start({
      runId: 'run-unresponsive-provider',
      sessionId: 'session-unresponsive',
      replyId: 'reply-unresponsive',
      messages: [{ role: 'user', content: 'start' }],
      modelConfig: { provider: 'openai', model: 'test', apiKey: 'test' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    const aborted = await manager.abort(started.id);

    assert.equal(receivedSignal.aborted, true);
    assert.equal(aborted.status, 'running');
    assert.throws(
      () => manager.start({
        runId: 'run-unresponsive-replacement',
        sessionId: 'session-unresponsive',
        replyId: 'reply-replacement',
        messages: [{ role: 'user', content: 'replace' }],
        modelConfig: { provider: 'openai', model: 'test', apiKey: 'test' },
      }),
      /already has an active agent run/
    );
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test('a cancelled sandbox run rejects late events and cannot become completed', async () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'vertex-runs-'));
  try {
    let activeRun;
    const manager = createManager(runsDir, {
      abortWaitMs: 10,
      runAgent(options) {
        return new Promise((resolve) => {
          activeRun = { ...options, resolve };
        });
      },
      createModel: () => ({}),
    });
    const started = manager.start({
      runId: 'run-late-cancel-events',
      sessionId: 'session-late-cancel-events',
      replyId: 'reply-late-cancel-events',
      messages: [{ role: 'user', content: 'start' }],
      modelConfig: { provider: 'openai', model: 'test', apiKey: 'test' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await manager.abort(started.id);

    assert.throws(
      () => activeRun.onEvent({ type: 'text-delta', text: 'too late' }),
      (error) => error?.name === 'AbortError'
    );
    activeRun.resolve({ content: 'must not complete' });
    const aborted = await waitForRunStatus(manager, started.id, 'aborted');

    assert.match(aborted.error, /aborted/i);
    assert.equal(aborted.result, null);
    assert.deepEqual(manager.get(started.id).events, []);
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test('sandbox event logs fail the owning run before consuming unbounded memory', async () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'vertex-runs-'));
  try {
    const manager = createManager(runsDir, {
      maxEventBytes: 100,
      runAgent({ onEvent }) {
        onEvent({ type: 'text-delta', text: 'x'.repeat(200) });
        return Promise.resolve({ content: 'unreachable' });
      },
      createModel: () => ({}),
    });
    const started = manager.start({
      runId: 'run-event-limit',
      sessionId: 'session-event-limit',
      replyId: 'reply-event-limit',
      messages: [{ role: 'user', content: 'start' }],
      modelConfig: { provider: 'openai', model: 'test', apiKey: 'test' },
    });

    const failed = await waitForRunStatus(manager, started.id, 'error');

    assert.match(failed.error, /event log exceeded 100 bytes/);
    assert.deepEqual(manager.get(started.id).events, []);
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test('a failed initial persist does not leave a ghost active session run', async () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'vertex-runs-'));
  try {
    const manager = createManager(runsDir, {
      runAgent: async () => ({ content: 'done' }),
      createModel: () => ({}),
    });
    const input = {
      sessionId: 'session-persist-retry',
      replyId: 'reply-persist-retry',
      messages: [{ role: 'user', content: 'start' }],
      modelConfig: { provider: 'openai', model: 'test', apiKey: 'test' },
    };
    rmSync(runsDir, { recursive: true, force: true });

    assert.throws(
      () => manager.start({ ...input, runId: 'run-persist-failure' }),
      /ENOENT/
    );

    mkdirSync(runsDir, { recursive: true });
    const retry = manager.start({ ...input, runId: 'run-persist-retry' });
    const completed = await waitForRunStatus(manager, retry.id, 'completed');
    assert.equal(completed.result.content, 'done');
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test('a server restart marks an in-flight or waiting run as interrupted', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'vertex-runs-'));
  try {
    writeFileSync(join(runsDir, 'run-active.json'), JSON.stringify({
      id: 'run-active',
      sessionId: 'session-one',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sequence: 0,
    }));
    writeFileSync(join(runsDir, 'run-waiting.json'), JSON.stringify({
      id: 'run-waiting',
      sessionId: 'session-one',
      status: 'waiting',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sequence: 0,
    }));
    const manager = createManager(runsDir);
    for (const id of ['run-active', 'run-waiting']) {
      const recovered = manager.get(id);
      assert.equal(recovered.status, 'interrupted');
      assert.match(recovered.error, /server restarted/i);
    }
    return Promise.all(['run-active', 'run-waiting'].map(async (id) => {
      const aborted = await manager.abort(id);
      assert.equal(aborted.status, 'interrupted');
    }));
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});
