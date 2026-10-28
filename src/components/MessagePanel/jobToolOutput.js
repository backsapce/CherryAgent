const JOB_TOOL_NAMES = new Set(['start_command', 'wait_command', 'get_command', 'stop_command']);

/**
 * Managed job tools (start/wait/get/stop_command) resolve with a pretty-printed
 * job snapshot. Expanding the block should not dump that JSON — the useful
 * parts are the command the job ran and the log segment it brought back.
 * Returns the parsed snapshot, or null when the call is not a job tool or its
 * result is not a job snapshot (still running, validation error, ...).
 */
export function parseJobSnapshot(toolCall) {
  if (!JOB_TOOL_NAMES.has(toolCall?.name)) return null;
  let parsed = toolCall?.result;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.job_id !== 'string') return null;
  return parsed;
}

/**
 * Header text for a managed job tool call that has not resolved a snapshot
 * yet: the command it was given, or the job_id it targets.
 */
export function jobCommandHint(parsedArgs) {
  if (!parsedArgs || typeof parsedArgs !== 'object') return undefined;
  if (typeof parsedArgs.command === 'string' && parsedArgs.command.trim()) return parsedArgs.command;
  if (typeof parsedArgs.job_id === 'string' && parsedArgs.job_id.trim()) return parsedArgs.job_id;
  return undefined;
}

/**
 * Terminal text for a managed job tool call: the command as a prompt line
 * followed by its incremental log segment, plus any job-level error.
 */
export function jobTerminalOutput(job) {
  if (!job || typeof job !== 'object') return '';
  const lines = [];
  if (typeof job.command === 'string' && job.command.trim()) {
    lines.push(`$ ${job.command}`);
  }
  if (typeof job.log === 'string' && job.log) {
    lines.push(job.log.replace(/\n+$/, ''));
  }
  if (typeof job.error === 'string' && job.error) {
    lines.push(`error: ${job.error}`);
  }
  return lines.join('\n');
}
