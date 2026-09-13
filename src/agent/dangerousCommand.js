/**
 * Detection for shell commands whose first execution should ask the user.
 *
 * The agent server keeps a blocklist for catastrophic patterns (fork bombs,
 * wiping the root filesystem); everything here is *approval territory*:
 * destructive or privilege-escalating operations that are often legitimate
 * (rm -rf build/, sudo systemctl restart …) but whose blast radius the user
 * should confirm once. Detection is intentionally high-signal and cheap —
 * a false positive costs one click, a false negative costs data.
 */

const DANGEROUS_COMMAND_RULES = [
  {
    reason: 'deletes files recursively or with force',
    pattern: /\brm\s+[^;&|]*-\w*[rf]\w*/,
  },
  {
    reason: 'runs as another user or elevates privileges',
    pattern: /\bsudo\b|\bsu\s+-|\bsu\s+[^\s]/,
  },
  {
    reason: 'writes to a raw disk device',
    pattern: /\bdd\s+if=|\bdd\s+of=|\b(?:wipefs|fdisk|parted|blockdev|hdparm)\b|>\s*\/dev\/(?:sd|nvme|hd)/,
  },
  {
    reason: 'creates a filesystem',
    pattern: /\bmkfs(?:\.\w+)?\b/,
  },
  {
    reason: 'shuts down or reboots the machine',
    pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/,
  },
  {
    reason: 'fork bomb',
    pattern: /:\(\)\s*\{\s*:\|:/,
  },
  {
    reason: 'pipes a downloaded script into a shell',
    pattern: /\b(?:curl|wget)\b[^|]*\|\s*(?:ba|z|da)?sh\b/,
  },
  {
    // --force-with-lease keeps a safety check and is excluded on purpose.
    reason: 'force-pushes to a remote branch',
    pattern: /\bgit\s+push\b[^;&|]*\s--force(?![\w-])|\bgit\s+push\s+-\w*f\w*/,
  },
];

/**
 * Assess one tool call. Returns `{ dangerous: true, reason }` for shell tools
 * whose command matches a rule, or null when no approval is needed.
 */
export function assessToolCommandDanger(toolName, input) {
  if (toolName !== 'execute_command' && toolName !== 'start_command') return null;
  const command = typeof input?.command === 'string' ? input.command : '';
  if (!command.trim()) return null;
  for (const rule of DANGEROUS_COMMAND_RULES) {
    if (rule.pattern.test(command)) {
      return { dangerous: true, reason: rule.reason };
    }
  }
  return null;
}
