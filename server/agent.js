/**
 * Agent API Server
 *
 * Provides a `/agent` endpoint that executes shell commands on the host machine.
 * This server is meant to run alongside the Vite dev server and is proxied
 * via vite.config.js so the frontend can reach it at the same origin.
 *
 * Authentication flow:
 *   1. Client hits GET /agent → gets { status: 'ok', needsAuth: true }
 *   2. Server prints a temp token to console on startup
 *   3. Client sends POST /agent/connect { token: '<temp-token>' }
 *   4. Server validates, generates a long-lived token, saves it to token file,
 *      and returns { token: '<long-lived-token>' }
 *   5. All subsequent POST /agent requests must include Authorization: Bearer <token>
 *
 * Security features:
 *   - Binds to 127.0.0.1 by default (set AGENT_HOST to expose)
 *   - Command validation (blocks destructive patterns)
 *   - Rate limiting on connect and command endpoints
 *   - CORS restricted to allowed origins (not wildcard)
 *   - Origin enforcement on mutating requests (CSRF guard when auth is disabled)
 *   - Path traversal protection with normalized comparison
 *   - Higher-entropy temp tokens (8 bytes = 16 hex chars)
 *   - Bounded request bodies and WebSocket frame sizes
 */

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  extname,
  join,
  normalize,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { createAgentRunManager } from './agent-runtime.js';
import { migrateLegacyAgentState, resolveAgentStatePaths } from './agent-state.js';
import { createCommandExecutor } from './command-executor.js';
import { createCommandJobManager } from './command-jobs.js';
import { createFilePathPolicy } from './file-path-policy.js';
import { createAgentWsServer } from './ws-protocol.js';
import { createDomainHandlers } from './ws-handlers.js';
import { createFileHandlers, createFileOperations } from './ws-files.js';
import { createRunHandlers } from './ws-runs.js';
import { fetchWebPage, isPrivateWebHostname, normalizeWebUrl } from '../src/agent/webFetch.js';
import { runWebSearch } from '../src/models/search.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const STATIC_DIR = join(__dirname, '..', 'dist');

// ─── Configuration ──────────────────────────────────────────────────────────

const PORT = process.env.AGENT_PORT || 3099;
// This server executes arbitrary shell commands, so on a bare host it stays
// loopback-only. Inside a container the published port and the container
// network ARE the boundary (docker -p forwards to the container's eth0, not
// its loopback), so a container runtime gets 0.0.0.0. AGENT_HOST always wins.
function detectContainerized() {
  try {
    if (existsSync('/.dockerenv')) return true;          // docker
    if (existsSync('/run/.containerenv')) return true;   // podman
    const cgroup = readFileSync('/proc/self/cgroup', 'utf8');
    if (/(?:docker|containerd|kubepods|lxc)/i.test(cgroup)) return true;
  } catch {
    /* not linux or unreadable — fall through */
  }
  return /^(?:true|1)$/i.test(process.env.container || '');
}
const HOST = process.env.AGENT_HOST
  || (detectContainerized() ? '0.0.0.0' : '127.0.0.1');
const MAX_TIMEOUT = 30_000;
// Ceiling for one wait_command long-poll (7 days, matching schedule_wakeup).
// Node's setTimeout accepts up to ~24.8 days, so this stays within its range.
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_BYTES = envPositiveBytes('AGENT_MAX_UPLOAD_BYTES', 256 * 1024 * 1024);
const MAX_WS_FRAME_BYTES = 1024 * 1024;
const MAX_WS_BUFFER_BYTES = 8 * 1024 * 1024;
const TEMP_TOKEN_TTL_MS = 10 * 60_000;
const RATE_LIMIT_MAP_MAX_ENTRIES = 1_000;
const ALLOWED_ORIGINS = (process.env.AGENT_ALLOWED_ORIGINS || 'https://127.0.0.1:5173,https://localhost:5173,http://127.0.0.1:5173,http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const COMMAND_SHELL = process.env.AGENT_SHELL || (process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : undefined);
const ALLOW_PRIVATE_WEB_FETCH = /^(1|true|yes)$/i.test(process.env.AGENT_ALLOW_PRIVATE_WEB_FETCH || '');
const WORKSPACE_DIR = resolve(process.env.AGENT_WORKING_DIR || process.cwd());
const FILES_ROOT_DIR = resolve(process.env.AGENT_FILES_DIR || WORKSPACE_DIR);
const AGENT_STATE_PATHS = resolveAgentStatePaths({
  env: process.env,
  workspaceDir: WORKSPACE_DIR,
});
const STATE_DIR = AGENT_STATE_PATHS.stateDir;
const TOKEN_FILE = AGENT_STATE_PATHS.tokenFile;
const RUNS_DIR = AGENT_STATE_PATHS.runsDir;
const JOBS_DIR = AGENT_STATE_PATHS.jobsDir;

migrateLegacyAgentState(AGENT_STATE_PATHS);

const PROTECTED_CONTROL_PATHS = [...new Set([
  STATE_DIR,
  TOKEN_FILE,
  RUNS_DIR,
  JOBS_DIR,
  ...(AGENT_STATE_PATHS.legacyTokenFiles || [AGENT_STATE_PATHS.legacyTokenFile]),
  AGENT_STATE_PATHS.legacyRunsDir,
  AGENT_STATE_PATHS.legacyJobsDir,
].map((path) => resolve(path)))];
const {
  isProtectedPath: isProtectedControlPath,
  isSafeMutationPath,
  isSafePath,
  isSameOrChildPath: isSameOrChildResolvedPath,
} = createFilePathPolicy({
  filesRootDir: FILES_ROOT_DIR,
  protectedPaths: PROTECTED_CONTROL_PATHS,
});
const PUBLIC_WORKSPACE_LABEL = 'workspace';
const AUTH_DISABLED = /^(1|true|yes)$/i.test(process.env.AGENT_DISABLE_AUTH || '');
const RUN_IDLE_TIMEOUT_MS = Math.min(
  30 * 60_000,
  Math.max(30_000, Number(process.env.AGENT_RUN_IDLE_TIMEOUT_MS) || 120_000)
);
// Terminal runs and job records older than this are pruned from disk and memory.
const STATE_RETENTION_MS = Math.min(
  90 * 24 * 60 * 60_000,
  Math.max(60_000, envPositiveMs('AGENT_STATE_RETENTION_MS', 7 * 24 * 60 * 60_000))
);
const STATE_PRUNE_INTERVAL_MS = 60 * 60_000;

function envPositiveBytes(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function envPositiveMs(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function printBootConfig() {
  const agentEnv = Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => key.startsWith('AGENT_'))
      .sort(([a], [b]) => a.localeCompare(b))
  );

  console.log('[agent] Boot config:');
  console.log(JSON.stringify({
    env: agentEnv,
    resolved: {
      host: HOST,
      port: PORT,
      maxTimeout: MAX_TIMEOUT,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      stateDir: STATE_DIR,
      tokenFile: TOKEN_FILE,
      allowedOrigins: ALLOWED_ORIGINS,
      commandShell: COMMAND_SHELL || null,
      workspaceDir: WORKSPACE_DIR,
      filesRootDir: FILES_ROOT_DIR,
      publicWorkspaceLabel: PUBLIC_WORKSPACE_LABEL,
      authDisabled: AUTH_DISABLED,
      runsDir: RUNS_DIR,
      jobsDir: JOBS_DIR,
      runIdleTimeoutMs: RUN_IDLE_TIMEOUT_MS,
      stateRetentionMs: STATE_RETENTION_MS,
      maxUploadBytes: MAX_UPLOAD_BYTES,
      staticDir: STATIC_DIR,
    },
  }, null, 2));
}

// ─── MIME types ─────────────────────────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.webp': 'image/webp',
};

function serveStatic(res, filePath) {
  if (res.writableEnded) return true;
  try {
    const data = readFileSync(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function resolveStaticPath(pathname) {
  const resolvedPath = resolve(STATIC_DIR, `.${pathname}`);
  return resolvedPath === STATIC_DIR || resolvedPath.startsWith(STATIC_DIR + sep)
    ? resolvedPath
    : null;
}

// ─── Rate limiting ──────────────────────────────────────────────────────────

const rateLimits = new Map(); // key → { count, resetAt }

function isRateLimited(key, maxRequests, windowMs) {
  if (rateLimits.size > RATE_LIMIT_MAP_MAX_ENTRIES) {
    const now = Date.now();
    for (const [entryKey, entry] of rateLimits) {
      if (now >= entry.resetAt) rateLimits.delete(entryKey);
    }
  }
  const now = Date.now();
  const entry = rateLimits.get(key);
  if (!entry || now >= entry.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count++;
  return entry.count > maxRequests;
}

// ─── Token management ───────────────────────────────────────────────────────

let tempToken = null;
let tempTokenGeneratedAt = 0;
const validTokens = new Set();

function generateToken(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

function rotateTempToken(reason) {
  tempToken = generateToken(8);
  tempTokenGeneratedAt = Date.now();
  console.log(`\n[agent] ─── Temp connect token (${reason}) ───`);
  console.log(`[agent]   ${tempToken}`);
  console.log(`[agent]   Valid for ${Math.round(TEMP_TOKEN_TTL_MS / 60_000)} minutes or until used`);
  console.log(`[agent] ────────────────────────────────────────\n`);
}

function ensureFreshTempToken() {
  if (!tempToken || Date.now() - tempTokenGeneratedAt >= TEMP_TOKEN_TTL_MS) {
    rotateTempToken('expired');
  }
}

function loadTokens() {
  try {
    if (existsSync(TOKEN_FILE)) {
      const before = validTokens.size;
      const content = readFileSync(TOKEN_FILE, 'utf-8');
      const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const t of lines) validTokens.add(t);
      console.log(`[agent] Loaded ${validTokens.size - before} saved token(s) from ${TOKEN_FILE}`);
    }
  } catch (err) {
    console.warn('[agent] Could not read token file:', err.message);
  }
}

function saveTokens() {
  try {
    writeFileSync(TOKEN_FILE, [...validTokens].join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.warn('[agent] Could not save token file:', err.message);
  }
}

// ─── Command validation ─────────────────────────────────────────────────────

const BLOCKED_PATTERNS = [
  /rm\s+(?:-\w+\s+)+\/\s*(?:\*|$)/,      // rm -rf / and rm -rf /*
  /dd\s+if=/,                               // dd (disk operations)
  /mkfs/,                                   // filesystem format
  /:\(\)\s*\{\s*:\|:\s*&?\s*\}/,            // fork bomb :(){ :|: & };:
  />\s*\/dev\/sd/,                           // write to raw disk
  /chmod\s+[0-7]*\s+\/\s*$/,                // chmod on root
  /curl\s+.+\|\s*(?:ba|z|da)?sh\b/,         // pipe curl to shell
  /wget\s+.+\|\s*(?:ba|z|da)?sh\b/,         // pipe wget to shell
];

function validateCommand(cmd) {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) {
      return { blocked: true, reason: `Command matches blocked pattern: ${pattern.source}` };
    }
  }
  return { blocked: false };
}

// ─── Path safety ────────────────────────────────────────────────────────────

// ─── Helpers ────────────────────────────────────────────────────────────────

const commandExecutor = createCommandExecutor({
  cwd: WORKSPACE_DIR,
  shell: COMMAND_SHELL,
  publicCwd: PUBLIC_WORKSPACE_LABEL,
  publicFilesRoot: PUBLIC_WORKSPACE_LABEL,
  maxOutputBytes: MAX_OUTPUT_BYTES,
});

function execCommand(cmd, { timeout = MAX_TIMEOUT, ...options } = {}) {
  return commandExecutor.execute(cmd, { ...options, timeout });
}

function streamCommand(cmd, { onStart, onStdout, onStderr, onExit, onError }, timeout = MAX_TIMEOUT) {
  const handle = commandExecutor.start(cmd, { timeout, onStart, onStdout, onStderr });
  handle.result.then((result) => {
    if (result.status === 'spawn_error') onError?.(new Error(result.stderr || 'Command failed to start'));
    else onExit?.(result);
  });
  return handle;
}

const commandJobManager = createCommandJobManager({
  jobsDir: JOBS_DIR,
  executor: commandExecutor,
});

function truncateLog(value, max = 2000) {
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max)}\n...[truncated]` : value;
}

function runtimePath(inputPath = '') {
  if (!isSafePath(inputPath)) throw new Error('Access denied: Path outside agent files root');
  return resolve(join(FILES_ROOT_DIR, normalize(inputPath)));
}

const fileOperations = createFileOperations({
  filesRootDir: FILES_ROOT_DIR,
  isSafePath,
  isSafeMutationPath,
  isProtectedControlPath,
  isSameOrChildPath: isSameOrChildResolvedPath,
  maxUploadBytes: MAX_UPLOAD_BYTES,
  log: (...args) => console.log('[agent]', ...args),
});

const agentRunManager = createAgentRunManager({
  runsDir: RUNS_DIR,
  idleTimeoutMs: RUN_IDLE_TIMEOUT_MS,
  execCommand,
  startCommand: (command) => commandJobManager.start(command),
  getCommand: (id, cursor) => commandJobManager.get(id, cursor),
  waitCommand: (id, options) => commandJobManager.wait(id, options),
  stopCommand: (id) => commandJobManager.stop(id),
  async listFiles(inputPath) {
    const resolvedPath = runtimePath(inputPath);
    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isDirectory()) throw new Error('Directory not found');
    return readdirSync(resolvedPath, { withFileTypes: true })
      .filter((entry) => !isProtectedControlPath(join(resolvedPath, entry.name)))
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        path: join(normalize(inputPath), entry.name),
      }));
  },
  async readFile(inputPath) {
    const resolvedPath = runtimePath(inputPath);
    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) throw new Error('File not found');
    return readFileSync(resolvedPath, 'utf8');
  },
  async writeFile(inputPath, content) {
    const resolvedPath = runtimePath(inputPath);
    mkdirSync(join(resolvedPath, '..'), { recursive: true });
    writeFileSync(resolvedPath, content, 'utf8');
  },
  async fileExists(inputPath) {
    return existsSync(runtimePath(inputPath));
  },
});

function isAllowedWsOrigin(req) {
  const origin = req.headers.origin || '';
  return !origin || ALLOWED_ORIGINS.includes(origin);
}

// ─── Server ─────────────────────────────────────────────────────────────────
// All agent traffic rides the WebSocket protocol; HTTP serves only the
// bundled frontend assets.

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let staticPath = resolveStaticPath(url.pathname === '/' ? '/index.html' : url.pathname);
    if (staticPath && serveStatic(res, staticPath)) return;

    staticPath = join(STATIC_DIR, 'index.html');
    if (serveStatic(res, staticPath)) return;

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    console.error(`[agent] Unhandled error: ${err.message}`);
    if (!res.writableEnded) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

// ─── WebSocket protocol (all agent traffic) ─────────────────────────────────// ─── WebSocket protocol (all agent traffic) ─────────────────────────────────

const agentWsServer = createAgentWsServer({
  authDisabled: AUTH_DISABLED,
  isValidToken: (token) => validTokens.has(token),
  exchangeTempToken: (candidate) => {
    if (candidate !== tempToken) {
      // With the HTTP health probe gone, expiry rotation happens here: an
      // aged-out printed token is invalidated instead of lingering forever.
      ensureFreshTempToken();
      return null;
    }
    const longLivedToken = generateToken(48);
    validTokens.add(longLivedToken);
    saveTokens();
    rotateTempToken('rotated after connect');
    return longLivedToken;
  },
  capabilities: () => ({
    backgroundAgentRuns: true,
    // Protocol 4 moves run traffic onto the WebSocket protocol (subscribe
    // pushes, incremental continue) and coalesces streaming deltas.
    agentRunProtocol: 4,
    backgroundCommands: true,
    backgroundCommandProtocol: 1,
    wsProtocol: 1,
  }),
  rateLimit: isRateLimited,
  handlers: {
    ...createDomainHandlers({
      streamCommand,
      validateCommand,
      rateLimit: isRateLimited,
      jobManager: commandJobManager,
      runWebSearch,
      fetchWebPage,
      normalizeWebUrl,
      isPrivateWebHostname,
      allowPrivateWebFetch: ALLOW_PRIVATE_WEB_FETCH,
      log: (...args) => console.log('[agent]', ...args),
      warn: (...args) => console.warn('[agent]', ...args),
      truncateLog,
    }),
    ...createFileHandlers(fileOperations),
    ...createRunHandlers({ runManager: agentRunManager }),
  },
  maxFrameBytes: MAX_WS_FRAME_BYTES,
  maxBufferBytes: MAX_WS_BUFFER_BYTES,
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/agent/ws') {
    socket.destroy();
    return;
  }

  if (!isAllowedWsOrigin(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ].join('\r\n'));

  agentWsServer.handleUpgrade(socket, req.socket.remoteAddress);
});

// ─── Start ───────────────────────────────────────────────────────────────────

if (!AUTH_DISABLED) {
  loadTokens();
  rotateTempToken('startup');
}

server.listen(PORT, HOST, () => {
  try {
    if (!existsSync(WORKSPACE_DIR)) {
      mkdirSync(WORKSPACE_DIR, { recursive: true });
      console.log(`[agent] Created workspace directory at ${WORKSPACE_DIR}`);
    }
    if (!existsSync(FILES_ROOT_DIR)) {
      mkdirSync(FILES_ROOT_DIR, { recursive: true });
      console.log(`[agent] Created files root directory at ${FILES_ROOT_DIR}`);
    }
  } catch (err) {
    console.warn(`[agent] Could not create workspace or files root directory: ${err.message}`);
  }

  printBootConfig();
  console.log(`[agent] Server listening on http://${HOST}:${PORT} (WebSocket agent protocol at /agent/ws)`);
  if (HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1') {
    console.log('[agent] Bound to loopback only (bare host default). Set AGENT_HOST=0.0.0.0 to expose to the network (not recommended without a trusted boundary).');
  } else if (!process.env.AGENT_HOST) {
    console.log('[agent] Container runtime detected; binding 0.0.0.0 so the published port reaches this server. AGENT_HOST overrides.');
  }
  console.log(`[agent] Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`[agent] Auth: ${AUTH_DISABLED ? 'disabled' : 'token required'}`);
  console.log(`[agent] Workspace cwd: ${WORKSPACE_DIR}`);
  console.log(`[agent] Files root: ${FILES_ROOT_DIR}`);
});
