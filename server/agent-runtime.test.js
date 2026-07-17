import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentRunManager, createRuntimeToolDispatcher, materializeMessageImages, materializeRuntimeFiles, REMOTE_TOOL_SCHEMAS } from './agent-runtime.js';

function createManager(runsDir) {
  return createAgentRunManager({
    runsDir,
    execCommand: async () => ({ stdout: '', stderr: '', code: 0 }),
    listFiles: async () => [],
    readFile: async () => '',
    writeFile: async () => {},
  });
}

test('sandbox runtime exposes no browser-owned tools', () => {
  assert.deepEqual(
    REMOTE_TOOL_SCHEMAS.map((tool) => tool.name),
    ['execute_command', 'list_sandbox_files', 'read_sandbox_file', 'display_sandbox_image', 'write_sandbox_file']
  );
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
  });

  const path = 'attachments/user-message-1/1-source-photo.png';
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

test('a server restart marks an in-flight run as interrupted', () => {
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
    const recovered = createManager(runsDir).get('run-active');
    assert.equal(recovered.status, 'interrupted');
    assert.match(recovered.error, /server restarted/i);
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});
