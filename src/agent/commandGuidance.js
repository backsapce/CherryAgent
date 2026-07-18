export const COMMAND_EXECUTION_GUIDANCE = `Command selection rules:
- Decide before every shell call whether the command is a bounded foreground operation or a managed background job.
- Use execute_command only when there is strong reason to expect completion within 30 seconds. Good examples: pwd, ls, git status, reading a small file range, and one small targeted test.
- Use start_command when it is available and the command may take 30 seconds or more, has unknown duration, waits on external work, or starts training, a server, watcher, lengthy build/test, download, migration, batch job, or similar process. When uncertain, choose start_command. If start_command is unavailable, do not force long work through execute_command; explain that this runtime cannot manage the long job.
- Never use execute_command to "try" a long command first. A timeout is a failure boundary, not a scheduling strategy.
- Pass start_command the normal foreground form of the command. Never add nohup, &, disown, screen, tmux, or a shell timeout wrapper; managed command tools own detachment, logs, status, and process-tree cancellation.
- Command tools have no interactive stdin. Use non-interactive flags and explicit input; do not launch a command that will wait for a prompt.
- Keep the returned job_id and nextCursor. Use get_command for an immediate status check. Use wait_command only when completion is likely within 30 seconds.
- For jobs likely to take minutes or hours, do not repeatedly poll. Schedule a future continuation when schedule_wakeup is available, with a self-contained prompt containing the job_id and latest nextCursor. Otherwise report the job_id so it can be checked later.
- Sparse or silent output does not prove a job is stuck. Do not stop a running job merely because it has produced no recent logs. Use stop_command only when the user requested cancellation, the job has clearly failed, or it is no longer useful.`;
