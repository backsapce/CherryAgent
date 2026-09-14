/**
 * JSON parameter schemas for the tools whose contract is shared between the
 * browser tool registry (tools.js) and durable sandbox runs
 * (server/agent-runtime.js). Both sides keep their own model-facing
 * descriptions — only the parameter contracts live here, so the two
 * environments can never drift on what a tool accepts.
 */

export const DEFAULT_READ_FILE_MAX_BYTES = 256 * 1024;
export const ABSOLUTE_READ_FILE_MAX_BYTES = 1024 * 1024;

export const TOOL_PARAMETER_SCHEMAS = {
  execute_command: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  start_command: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The complete foreground-form shell command. Do not append & or nohup.',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  get_command: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'The job_id returned by start_command.' },
      cursor: { type: 'integer', minimum: 0, description: 'Log byte cursor; use nextCursor from the previous result. Defaults to 0.' },
    },
    required: ['job_id'],
    additionalProperties: false,
  },
  wait_command: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'The job_id returned by start_command.' },
      cursor: { type: 'integer', minimum: 0, description: 'Use nextCursor from the previous result. Defaults to 0.' },
      wait_seconds: { type: 'integer', minimum: 1, maximum: 30, description: 'Maximum wait, from 1 through 30 seconds. Defaults to 30.' },
    },
    required: ['job_id'],
    additionalProperties: false,
  },
  stop_command: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'The job_id returned by start_command.' },
    },
    required: ['job_id'],
    additionalProperties: false,
  },
  list_sandbox_files: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Sandbox workdir directory path to list. Empty means the sandbox files root/workdir.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  read_sandbox_file: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Sandbox workdir file path.',
      },
      max_bytes: {
        type: 'number',
        description: `Maximum file size to read. Defaults to ${DEFAULT_READ_FILE_MAX_BYTES} bytes and is capped at ${ABSOLUTE_READ_FILE_MAX_BYTES} bytes.`,
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  write_sandbox_file: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Sandbox workdir file path.',
      },
      content: {
        type: 'string',
        description: 'The content to write.',
      },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  display_sandbox_image: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Sandbox workdir image path.',
      },
      alt: {
        type: 'string',
        description: 'Short accessible description of the image.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  skill: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'read', 'write'],
        description: 'Skill operation.',
      },
      name: {
        type: 'string',
        description: 'Skill name for read or write.',
      },
      query: {
        type: 'string',
        description: 'Optional search query for list.',
      },
      reference_name: {
        type: 'string',
        description: 'For read or write, target one reference file instead of SKILL.md.',
      },
      content: {
        type: 'string',
        description: 'Full SKILL.md or reference content for write.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  schedule_wakeup: {
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
};

/** Render a command execution result for the model (exit code, env, output). */
export function formatCommandResult(result) {
  let output = `Exit code: ${result.code}`;
  if (result.status) output += `\nStatus: ${result.status}${Number.isFinite(result.durationMs) ? ` (${result.durationMs} ms)` : ''}`;
  if (result.platform || result.shell || result.cwd || result.filesRoot) {
    output += `\nEnvironment: platform=${result.platform || 'unknown'}, shell=${result.shell || 'unknown'}, cwd=${result.cwd || 'unknown'}, filesRoot=${result.filesRoot || 'unknown'}`;
  }
  if (result.stdout) output += `\nStdout:\n${result.stdout}`;
  if (result.stderr) output += `\nStderr:\n${result.stderr}`;
  return output;
}
