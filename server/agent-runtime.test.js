import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentRunManager, REMOTE_TOOL_SCHEMAS } from './agent-runtime.js';

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
    ['execute_command', 'list_sandbox_files', 'read_sandbox_file', 'write_sandbox_file']
  );
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
