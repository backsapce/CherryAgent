import test from 'node:test';
import assert from 'node:assert/strict';
import { jobCommandHint, jobTerminalOutput, parseJobSnapshot } from './jobToolOutput.js';

const snapshot = {
  job_id: 'job-e49410da',
  status: 'completed',
  command: 'cd /app && npm test',
  exit_code: 0,
  log: 'ok 1 passes\n',
  error: null,
};

test('parseJobSnapshot accepts job tool results, rejects everything else', () => {
  assert.equal(parseJobSnapshot({ name: 'wait_command', result: JSON.stringify(snapshot) }).job_id, snapshot.job_id);
  assert.equal(parseJobSnapshot({ name: 'get_command', result: snapshot }).command, snapshot.command);
  assert.equal(parseJobSnapshot({ name: 'execute_command', result: JSON.stringify(snapshot) }), null);
  assert.equal(parseJobSnapshot({ name: 'wait_command', result: 'wait_command: pass command or job_id.' }), null);
  assert.equal(parseJobSnapshot({ name: 'wait_command', result: 'null' }), null);
  assert.equal(parseJobSnapshot({ name: 'stop_command' }), null);
});

test('jobTerminalOutput shows the command line plus log, not the JSON', () => {
  const emptyLog = parseJobSnapshot({ name: 'wait_command', result: JSON.stringify({ ...snapshot, log: '' }) });
  assert.equal(jobTerminalOutput(emptyLog), '$ cd /app && npm test');
  const withLog = parseJobSnapshot({ name: 'wait_command', result: JSON.stringify(snapshot) });
  assert.equal(jobTerminalOutput(withLog), '$ cd /app && npm test\nok 1 passes');
});

test('jobTerminalOutput appends job-level errors and tolerates missing snapshots', () => {
  const failed = parseJobSnapshot({
    name: 'get_command',
    result: JSON.stringify({ ...snapshot, log: '', error: 'Agent server restarted.' }),
  });
  assert.equal(jobTerminalOutput(failed), '$ cd /app && npm test\nerror: Agent server restarted.');
  assert.equal(jobTerminalOutput(null), '');
});

test('jobCommandHint falls back to the job_id while a job tool is still running', () => {
  assert.equal(jobCommandHint({ command: 'npm run build' }), 'npm run build');
  assert.equal(jobCommandHint({ job_id: 'job-e49410da' }), 'job-e49410da');
  assert.equal(jobCommandHint({ command: '   ' }), undefined);
  assert.equal(jobCommandHint(undefined), undefined);
});
