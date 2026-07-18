import assert from 'node:assert/strict';
import test from 'node:test';
import process from 'node:process';
import { createCommandExecutor } from './command-executor.js';

const nodeCommand = (source) => `"${process.execPath}" -e ${JSON.stringify(source)}`;

test('foreground commands capture output and report structured completion', async () => {
  const executor = createCommandExecutor({ cwd: process.cwd(), killGraceMs: 50, settleGraceMs: 50 });
  const result = await executor.execute(nodeCommand("require('fs').writeSync(1,'ok')"), { timeout: 1_000 });

  assert.equal(result.status, 'exited');
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'ok');
  assert.equal(result.timedOut, false);
  assert.equal(typeof result.durationMs, 'number');
});

test('foreground timeout escalates from TERM to KILL and always settles', { skip: process.platform === 'win32' }, async () => {
  const executor = createCommandExecutor({ cwd: process.cwd(), killGraceMs: 40, settleGraceMs: 40 });
  const started = Date.now();
  const result = await executor.execute(nodeCommand("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"), {
    timeout: 40,
  });

  assert.equal(result.status, 'timed_out');
  assert.equal(result.code, 124);
  assert.ok(Date.now() - started < 1_000);
});

test('foreground output limits stop accumulation and terminate the command', async () => {
  const executor = createCommandExecutor({
    cwd: process.cwd(),
    maxOutputBytes: 32,
    killGraceMs: 40,
    settleGraceMs: 40,
  });
  const result = await executor.execute(nodeCommand("require('fs').writeSync(1,'x'.repeat(1000));setInterval(()=>{},1000)"), {
    timeout: 1_000,
  });

  assert.equal(result.status, 'output_limit');
  assert.equal(result.code, 125);
  assert.equal(Buffer.byteLength(result.stdout), 32);
  assert.equal(result.outputTruncated, true);
});

test('aborting a foreground command rejects only after process cleanup', async () => {
  const executor = createCommandExecutor({ cwd: process.cwd(), killGraceMs: 40, settleGraceMs: 40 });
  const controller = new AbortController();
  const running = executor.execute(nodeCommand('setInterval(()=>{},1000)'), {
    timeout: 5_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 30);

  await assert.rejects(running, (error) => error?.name === 'AbortError');
});
