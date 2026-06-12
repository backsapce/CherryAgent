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
 *   - Command validation (blocks destructive patterns)
 *   - Rate limiting on connect and command endpoints
 *   - CORS restricted to allowed origins (not wildcard)
 *   - Path traversal protection with normalized comparison
 *   - Higher-entropy temp tokens (8 bytes = 16 hex chars)
 */

import { createServer } from 'node:http';
import { exec, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, unlinkSync, rmSync, renameSync } from 'node:fs';
import { isAbsolute, join, extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const STATIC_DIR = join(__dirname, '..', 'dist');

// ─── Configuration ──────────────────────────────────────────────────────────

const PORT = process.env.AGENT_PORT || 3099;
const MAX_TIMEOUT = 30_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_TOKEN_FILE = join(process.cwd(), '.vertex-token');
const TOKEN_FILE = process.env.AGENT_TOKEN_FILE
  || DEFAULT_TOKEN_FILE;
const ALLOWED_ORIGINS = (process.env.AGENT_ALLOWED_ORIGINS || 'https://127.0.0.1:5173,https://localhost:5173,http://127.0.0.1:5173,http://localhost:5173').split(',');
const COMMAND_SHELL = process.env.AGENT_SHELL || (process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : undefined);
const WORKSPACE_DIR = resolve(process.env.AGENT_WORKING_DIR || process.cwd());
const FILES_ROOT_DIR = resolve(process.env.AGENT_FILES_DIR || WORKSPACE_DIR);
const PUBLIC_WORKSPACE_LABEL = 'workspace';
const AUTH_DISABLED = /^(1|true|yes)$/i.test(process.env.AGENT_DISABLE_AUTH || '');

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
      port: PORT,
      maxTimeout: MAX_TIMEOUT,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      tokenFile: TOKEN_FILE,
      allowedOrigins: ALLOWED_ORIGINS,
      commandShell: COMMAND_SHELL || null,
      workspaceDir: WORKSPACE_DIR,
      filesRootDir: FILES_ROOT_DIR,
      publicWorkspaceLabel: PUBLIC_WORKSPACE_LABEL,
      authDisabled: AUTH_DISABLED,
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

// ─── CORS ───────────────────────────────────────────────────────────────────

function corsHeaders(req) {
  const origin = req.headers['origin'] || '';
  console.log(`[agent] Request from origin: ${origin}`,ALLOWED_ORIGINS);
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// ─── Rate limiting ──────────────────────────────────────────────────────────

const rateLimits = new Map(); // key → { count, resetAt }

function isRateLimited(key, maxRequests, windowMs) {
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
const validTokens = new Set();

function generateToken(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

function loadTokens() {
  try {
    if (existsSync(TOKEN_FILE)) {
      const before = validTokens.size;
      const content = readFileSync(TOKEN_FILE, 'utf-8');
      const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const t of lines) validTokens.add(t);
      const loaded = validTokens.size - before;
      console.log(`[agent] Loaded ${loaded} saved token(s) from ${TOKEN_FILE}`);
      console.log(`[agent] Current valid tokens: ${[...validTokens].join(', ')}`);
    }
  } catch (err) {
    console.warn('[agent] Could not read token file:', err.message);
  }
}

function saveTokens() {
  try {
    writeFileSync(TOKEN_FILE, [...validTokens].join('\n') + '\n', 'utf-8');
  } catch (err) {
    console.warn('[agent] Could not save token file:', err.message);
  }
}

function isAuthorized(req) {
  if (AUTH_DISABLED) return true;
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return validTokens.has(token);
}

// ─── Command validation ─────────────────────────────────────────────────────

const BLOCKED_PATTERNS = [
  /rm\s+(-rf|--recursive|--force)\s+\/\s*$/,   // rm -rf /
  /dd\s+if=/,                                   // dd (disk operations)
  /mkfs/,                                       // filesystem format
  /:()\s*\{\s*:\|:\s*\}/,                         // fork bomb
  />\s*\/dev\/sd/,                              // write to raw disk
  /chmod\s+[0-7]*\s+\/\s*$/,                    // chmod on root
  /curl\s+.+\s*\|\s*sh/,                        // pipe curl to shell
  /wget\s+.+\s*\|\s*sh/,                        // pipe wget to shell
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

function isSafePath(inputPath) {
  if (typeof inputPath !== 'string' || inputPath.includes('\0') || isAbsolute(inputPath)) return false;
  const normalizedPath = normalize(inputPath);
  // Reject paths containing .. after normalization (should already be resolved, but double-check)
  if (normalizedPath.split(/[\\/]+/).includes('..')) return false;
  const fullPath = join(FILES_ROOT_DIR, normalizedPath);
  const resolvedPath = resolve(fullPath);
  // On Windows, compare case-insensitively
  const compareA = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
  const compareB = process.platform === 'win32' ? FILES_ROOT_DIR.toLowerCase() : FILES_ROOT_DIR;
  return compareA.startsWith(compareB + sep) || compareA === compareB;
}

function isSameOrChildResolvedPath(path, parentPath) {
  const comparePath = process.platform === 'win32' ? path.toLowerCase() : path;
  const compareParent = process.platform === 'win32' ? parentPath.toLowerCase() : parentPath;
  return comparePath === compareParent || comparePath.startsWith(compareParent + sep);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function execCommand(cmd, timeout = MAX_TIMEOUT) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, maxBuffer: 10 * 1024 * 1024, shell: COMMAND_SHELL, cwd: WORKSPACE_DIR }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        code: error ? error.code ?? 1 : 0,
        platform: process.platform,
        shell: COMMAND_SHELL || 'default',
        cwd: PUBLIC_WORKSPACE_LABEL,
        filesRoot: PUBLIC_WORKSPACE_LABEL,
      });
    });
  });
}

function streamCommand(cmd, { onStart, onStdout, onStderr, onExit, onError }, timeout = MAX_TIMEOUT) {
  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let timedOut = false;
  let settled = false;

  const child = spawn(cmd, {
    cwd: WORKSPACE_DIR,
    shell: COMMAND_SHELL || true,
    windowsHide: true,
  });

  onStart?.({
    platform: process.platform,
    shell: COMMAND_SHELL || 'default',
    cwd: PUBLIC_WORKSPACE_LABEL,
    filesRoot: PUBLIC_WORKSPACE_LABEL,
    pid: child.pid,
  });

  const killTimer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, timeout);

  const handleChunk = (streamName, chunk) => {
    const text = chunk.toString();
    outputBytes += Buffer.byteLength(text);

    if (streamName === 'stdout') {
      stdout += text;
      onStdout?.(text);
    } else {
      stderr += text;
      onStderr?.(text);
    }

    if (outputBytes > MAX_OUTPUT_BYTES) {
      stderr += `\n[agent] Output exceeded ${MAX_OUTPUT_BYTES} bytes; command terminated.\n`;
      child.kill('SIGTERM');
    }
  };

  child.stdout?.on('data', (chunk) => handleChunk('stdout', chunk));
  child.stderr?.on('data', (chunk) => handleChunk('stderr', chunk));

  child.on('error', (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(killTimer);
    onError?.(err);
  });

  child.on('close', (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(killTimer);
    onExit?.({
      stdout,
      stderr,
      code: timedOut ? 124 : (code ?? 1),
      signal,
      timedOut,
      platform: process.platform,
      shell: COMMAND_SHELL || 'default',
      cwd: PUBLIC_WORKSPACE_LABEL,
      filesRoot: PUBLIC_WORKSPACE_LABEL,
    });
  });

  return child;
}

function truncateLog(value, max = 2000) {
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max)}\n...[truncated]` : value;
}

function json(res, status, data, req) {
  if (res.writableEnded) return;
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(req) };
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

async function readBodyBuffer(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function isAllowedWsOrigin(req) {
  const origin = req.headers.origin || '';
  return !origin || ALLOWED_ORIGINS.includes(origin);
}

function sendWsFrame(socket, value) {
  if (socket.destroyed) return;
  const payload = Buffer.from(JSON.stringify(value));
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function closeWs(socket, code = 1000, reason = '') {
  if (socket.destroyed) return;
  const reasonBuffer = Buffer.from(reason);
  const payload = Buffer.alloc(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  const header = Buffer.from([0x88, payload.length]);
  socket.end(Buffer.concat([header, payload]));
}

function parseWsFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame too large');
      length = Number(bigLength);
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const frameEnd = offset + headerLength + maskLength + length;
    if (frameEnd > buffer.length) break;

    let payload = buffer.slice(offset + headerLength + maskLength, frameEnd);
    if (masked) {
      const mask = buffer.slice(offset + headerLength, offset + headerLength + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }

    frames.push({ opcode, payload });
    offset = frameEnd;
  }

  return { frames, rest: buffer.slice(offset) };
}

// ─── Server ─────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  try {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    if (res.writableEnded) return;
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── Health check ───────────────────────────────────────────────────────
  if ((url.pathname === '/agent' || url.pathname === '/agent/health') && req.method === 'GET') {
    const authed = isAuthorized(req);

    if (!AUTH_DISABLED && !authed) {
      tempToken = generateToken(8);
      console.log(`\n[agent] ─── Fresh temp connect token ───`);
      console.log(`[agent]   ${tempToken}`);
      console.log(`[agent] ────────────────────────────────\n`);
    }

    return json(res, 200, {
      status: 'ok',
      needsAuth: !authed,
      authRequired: !AUTH_DISABLED,
      authenticated: authed,
      platform: process.platform,
      shell: COMMAND_SHELL || 'default',
      cwd: PUBLIC_WORKSPACE_LABEL,
      filesRoot: PUBLIC_WORKSPACE_LABEL,
    }, req);
  }

  // ── Token exchange (connect) ───────────────────────────────────────────
  if (url.pathname === '/agent/connect' && req.method === 'POST') {
    const clientIp = req.socket.remoteAddress;
    if (isRateLimited(`connect:${clientIp}`, 5, 60_000)) {
      return json(res, 429, { error: 'Too many connect attempts. Try again later.' }, req);
    }

    const body = await readBody(req);
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      return json(res, 400, { error: 'Invalid JSON body' }, req);
    }

    const { token } = parsed;
    if (!token || typeof token !== 'string') {
      return json(res, 400, { error: 'Missing or invalid "token" field' }, req);
    }

    if (token !== tempToken) {
      return json(res, 403, { error: 'Invalid token. Check the server console for the correct token.' }, req);
    }

    const longLivedToken = generateToken(48);
    validTokens.add(longLivedToken);
    saveTokens();

    tempToken = generateToken(8);
    console.log(`\n[agent] ─── New temp connect token ───`);
    console.log(`[agent]   ${tempToken}`);
    console.log(`[agent] ──────────────────────────────\n`);

    console.log('[agent] Client authenticated successfully.');
    return json(res, 200, { token: longLivedToken }, req);
  }

  // ── Execute command (requires auth) ────────────────────────────────────
  if (url.pathname === '/agent' && req.method === 'POST') {
    if (!isAuthorized(req)) {
      return json(res, 401, { error: 'Unauthorized.' }, req);
    }

    const clientIp = req.socket.remoteAddress;
    if (isRateLimited(`cmd:${clientIp}`, 30, 60_000)) {
      return json(res, 429, { error: 'Too many commands. Slow down.' }, req);
    }

    const body = await readBody(req);
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      return json(res, 400, { error: 'Invalid JSON body' }, req);
    }

    const { cmd } = parsed;
    if (!cmd || typeof cmd !== 'string') {
      return json(res, 400, { error: 'Missing or invalid "cmd" field' }, req);
    }

    const validation = validateCommand(cmd);
    if (validation.blocked) {
      console.warn(`[agent] BLOCKED command: ${cmd} (${validation.reason})`);
      return json(res, 403, { error: `Command blocked: ${validation.reason}` }, req);
    }

    console.log(`[agent] exec: ${cmd}`);
    const result = await execCommand(cmd);
    console.log(`[agent] exit code: ${result.code} (${result.platform}, ${result.shell}, cwd=${result.cwd})`);
    if (result.code !== 0) {
      if (result.stdout) console.log(`[agent] stdout:\n${truncateLog(result.stdout)}`);
      if (result.stderr) console.warn(`[agent] stderr:\n${truncateLog(result.stderr)}`);
    }
    return json(res, 200, result, req);
  }

  // ── List files (requires auth) ─────────────────────────────────────────
  if (url.pathname === '/agent/files' && req.method === 'GET') {
    if (!isAuthorized(req)) {
      return json(res, 401, { error: 'Unauthorized.' }, req);
    }

    const searchParams = new URLSearchParams(url.search);
    const dirPath = searchParams.get('path') || '';

    if (!isSafePath(dirPath)) {
      return json(res, 403, { error: 'Access denied: Path outside agent files root' }, req);
    }

    try {
      const normalizedPath = normalize(dirPath);
      const resolvedPath = resolve(join(FILES_ROOT_DIR, normalizedPath));

      if (!existsSync(resolvedPath)) {
        return json(res, 404, { error: 'Directory not found' }, req);
      }

      const stats = statSync(resolvedPath);
      if (!stats.isDirectory()) {
        return json(res, 400, { error: 'Not a directory' }, req);
      }

      const entries = readdirSync(resolvedPath, { withFileTypes: true });
      const files = entries.map((entry) => {
        const entryPath = join(resolvedPath, entry.name);
        let size = 0;
        let lastModified = null;
        try {
          const entryStats = statSync(entryPath);
          size = entryStats.size;
          lastModified = entryStats.mtimeMs;
        } catch { /* ignore */ }
        return {
          id: `${entry.isDirectory() ? 'dir' : 'file'}-${normalizedPath}-${entry.name}`,
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size,
          lastModified,
          path: join(normalizedPath, entry.name),
          parentDir: normalizedPath === '.' ? '' : normalizedPath,
        };
      });

      const result = normalizedPath === '.' || normalizedPath === ''
        ? { id: 'root', name: '/', type: 'directory', children: files }
        : files;

      return json(res, 200, result, req);
    } catch (err) {
      console.error(`[agent] Error listing files: ${err.message}`);
      return json(res, 500, { error: 'Failed to list files' }, req);
    }
  }

  // ── Create file/directory (requires auth) ──────────────────────────────
  if (url.pathname === '/agent/files' && req.method === 'POST') {
    if (!isAuthorized(req)) {
      return json(res, 401, { error: 'Unauthorized.' }, req);
    }

    const body = await readBody(req);
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      return json(res, 400, { error: 'Invalid JSON body' }, req);
    }

    const { path, content, isDirectory } = parsed;
    if (!path || typeof path !== 'string') {
      return json(res, 400, { error: 'Missing or invalid "path" field' }, req);
    }

    if (!isSafePath(path)) {
      return json(res, 403, { error: 'Access denied: Path outside agent files root' }, req);
    }

    try {
      const resolvedPath = resolve(join(FILES_ROOT_DIR, normalize(path)));

      if (isDirectory) {
        mkdirSync(resolvedPath, { recursive: true });
        return json(res, 200, { success: true, message: 'Directory created' }, req);
      } else {
        const parentDir = join(resolvedPath, '..');
        if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
        writeFileSync(resolvedPath, content || '');
        return json(res, 200, { success: true, message: 'File created' }, req);
      }
    } catch (err) {
      console.error(`[agent] Error creating file: ${err.message}`);
      return json(res, 500, { error: 'Failed to create file' }, req);
    }
  }

  // ── Upload file (requires auth) ────────────────────────────────────────
  if (url.pathname === '/agent/files/upload' && req.method === 'POST') {
    if (!isAuthorized(req)) {
      return json(res, 401, { error: 'Unauthorized.' }, req);
    }

    try {
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
      if (!boundaryMatch) {
        return json(res, 400, { error: 'Invalid multipart form data' }, req);
      }

      const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
      const body = (await readBodyBuffer(req)).toString('latin1');
      const parts = body.split(boundary);
      let filePath = '';
      let fileContent = null;

      for (const part of parts) {
        if (!part || part === '--' || part === '--\r\n') continue;
        const cleanPart = part.replace(/^\r?\n/, '');
        const headerEnd = cleanPart.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = cleanPart.slice(0, headerEnd);
        let content = cleanPart.slice(headerEnd + 4);
        if (content.endsWith('\r\n')) content = content.slice(0, -2);
        const contentDisposition = headers.match(/Content-Disposition:\s*form-data;\s*(.*)/i);
        if (contentDisposition) {
          const nameMatch = contentDisposition[1].match(/name="([^"]+)"/);
          const filenameMatch = contentDisposition[1].match(/filename="([^"]+)"/);
          if (nameMatch && nameMatch[1] === 'path') filePath = content.trim();
          if (filenameMatch) fileContent = Buffer.from(content, 'latin1');
        }
      }

      if (!filePath || fileContent === null) {
        return json(res, 400, { error: 'Missing file or path' }, req);
      }

      if (!isSafePath(filePath)) {
        return json(res, 403, { error: 'Access denied: Path outside agent files root' }, req);
      }

      const resolvedPath = resolve(join(FILES_ROOT_DIR, normalize(filePath)));
      const parentDir = join(resolvedPath, '..');
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
      writeFileSync(resolvedPath, fileContent || '');
      return json(res, 200, { success: true, message: 'File uploaded' }, req);
    } catch (err) {
      console.error(`[agent] Error uploading file: ${err.message}`);
      return json(res, 500, { error: 'Failed to upload file' }, req);
    }
  }

  // ── Move file/directory (requires auth) ───────────────────────────────
  if (url.pathname === '/agent/files' && req.method === 'PATCH') {
    if (!isAuthorized(req)) {
      return json(res, 401, { error: 'Unauthorized.' }, req);
    }

    const body = await readBody(req);
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      return json(res, 400, { error: 'Invalid JSON body' }, req);
    }

    const { sourcePath, targetPath } = parsed;
    if (!sourcePath || typeof sourcePath !== 'string' || !targetPath || typeof targetPath !== 'string') {
      return json(res, 400, { error: 'Missing or invalid "sourcePath" or "targetPath" field' }, req);
    }

    if (!isSafePath(sourcePath) || !isSafePath(targetPath)) {
      return json(res, 403, { error: 'Access denied: Path outside agent files root' }, req);
    }

    const normalizedSource = normalize(sourcePath);
    const normalizedTarget = normalize(targetPath);
    if (normalizedSource === normalizedTarget) {
      return json(res, 200, { success: true, message: 'Already at target path' }, req);
    }

    try {
      const resolvedSource = resolve(join(FILES_ROOT_DIR, normalizedSource));
      const resolvedTarget = resolve(join(FILES_ROOT_DIR, normalizedTarget));

      if (!existsSync(resolvedSource)) {
        return json(res, 404, { error: 'Source file or directory not found' }, req);
      }

      if (existsSync(resolvedTarget)) {
        return json(res, 409, { error: 'Destination already exists' }, req);
      }

      const stats = statSync(resolvedSource);
      if (stats.isDirectory() && isSameOrChildResolvedPath(resolvedTarget, resolvedSource)) {
        return json(res, 400, { error: 'Cannot move a directory into itself' }, req);
      }

      const targetParent = join(resolvedTarget, '..');
      if (!existsSync(targetParent)) mkdirSync(targetParent, { recursive: true });
      if (!statSync(targetParent).isDirectory()) {
        return json(res, 400, { error: 'Target parent is not a directory' }, req);
      }

      renameSync(resolvedSource, resolvedTarget);
      return json(res, 200, { success: true, message: 'Moved successfully' }, req);
    } catch (err) {
      console.error(`[agent] Error moving file: ${err.message}`);
      return json(res, 500, { error: 'Failed to move file' }, req);
    }
  }

  // ── Delete file/directory (requires auth) ──────────────────────────────
  if (url.pathname === '/agent/files' && req.method === 'DELETE') {
    if (!isAuthorized(req)) {
      return json(res, 401, { error: 'Unauthorized.' }, req);
    }

    const searchParams = new URLSearchParams(url.search);
    const filePath = searchParams.get('path') || '';

    if (!filePath) {
      return json(res, 400, { error: 'Missing "path" parameter' }, req);
    }

    if (!isSafePath(filePath)) {
      return json(res, 403, { error: 'Access denied: Path outside agent files root' }, req);
    }

    try {
      const resolvedPath = resolve(join(FILES_ROOT_DIR, normalize(filePath)));
      if (!existsSync(resolvedPath)) {
        return json(res, 404, { error: 'File or directory not found' }, req);
      }
      const stats = statSync(resolvedPath);
      if (stats.isDirectory()) {
        rmSync(resolvedPath, { recursive: true });
      } else {
        unlinkSync(resolvedPath);
      }
      return json(res, 200, { success: true, message: 'Deleted successfully' }, req);
    } catch (err) {
      console.error(`[agent] Error deleting file: ${err.message}`);
      return json(res, 500, { error: 'Failed to delete file' }, req);
    }
  }

  // ── Download file (requires auth) ──────────────────────────────────────
  if (url.pathname === '/agent/files/download' && req.method === 'GET') {
    if (!isAuthorized(req)) {
      return json(res, 401, { error: 'Unauthorized.' }, req);
    }

    const searchParams = new URLSearchParams(url.search);
    const filePath = searchParams.get('path') || '';

    if (!filePath) {
      return json(res, 400, { error: 'Missing "path" parameter' }, req);
    }

    if (!isSafePath(filePath)) {
      return json(res, 403, { error: 'Access denied: Path outside agent files root' }, req);
    }

    try {
      const resolvedPath = resolve(join(FILES_ROOT_DIR, normalize(filePath)));
      if (!existsSync(resolvedPath)) {
        return json(res, 404, { error: 'File not found' }, req);
      }
      const stats = statSync(resolvedPath);
      if (stats.isDirectory()) {
        return json(res, 400, { error: 'Cannot download a directory' }, req);
      }
      const fileData = readFileSync(resolvedPath);
      const fileName = normalize(filePath).split(/[\\/]/).pop();
      if (res.writableEnded) return;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        ...corsHeaders(req),
      });
      res.end(fileData);
    } catch (err) {
      console.error(`[agent] Error downloading file: ${err.message}`);
      return json(res, 500, { error: 'Failed to download file' }, req);
    }
  }

  // ── Serve static frontend assets ──────────────────────────────────────
  let staticPath = resolveStaticPath(url.pathname === '/' ? '/index.html' : url.pathname);
  if (staticPath && serveStatic(res, staticPath)) return;

  staticPath = join(STATIC_DIR, 'index.html');
  if (serveStatic(res, staticPath)) return;

  json(res, 404, { error: 'Not found' }, req);
  } catch (err) {
    console.error(`[agent] Unhandled error: ${err.message}`);
    json(res, 500, { error: 'Internal server error' }, req);
  }
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

  let pending = Buffer.alloc(0);
  let child = null;
  let started = false;

  const fail = (status, error) => {
    sendWsFrame(socket, { type: 'error', error, status });
    closeWs(socket, 1008, error);
  };

  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    let parsed;
    try {
      parsed = parseWsFrames(pending);
    } catch (err) {
      fail(400, err.message);
      return;
    }
    pending = parsed.rest;

    for (const frame of parsed.frames) {
      if (frame.opcode === 0x8) {
        child?.kill('SIGTERM');
        socket.end();
        return;
      }
      if (frame.opcode !== 0x1 || started) continue;
      started = true;

      let body;
      try {
        body = JSON.parse(frame.payload.toString('utf8'));
      } catch {
        fail(400, 'Invalid JSON body');
        return;
      }

      const { cmd, token } = body;
      const authed = AUTH_DISABLED || (typeof token === 'string' && validTokens.has(token));
      if (!authed) {
        fail(401, 'Unauthorized.');
        return;
      }

      const clientIp = req.socket.remoteAddress;
      if (isRateLimited(`cmd:${clientIp}`, 30, 60_000)) {
        fail(429, 'Too many commands. Slow down.');
        return;
      }

      if (!cmd || typeof cmd !== 'string') {
        fail(400, 'Missing or invalid "cmd" field');
        return;
      }

      const validation = validateCommand(cmd);
      if (validation.blocked) {
        console.warn(`[agent] BLOCKED command: ${cmd} (${validation.reason})`);
        fail(403, `Command blocked: ${validation.reason}`);
        return;
      }

      console.log(`[agent] ws exec: ${cmd}`);
      child = streamCommand(cmd, {
        onStart: (meta) => sendWsFrame(socket, { type: 'start', ...meta }),
        onStdout: (data) => sendWsFrame(socket, { type: 'stdout', data }),
        onStderr: (data) => sendWsFrame(socket, { type: 'stderr', data }),
        onError: (err) => {
          console.warn(`[agent] ws exec error: ${err.message}`);
          sendWsFrame(socket, { type: 'error', error: err.message });
          closeWs(socket, 1011, err.message);
        },
        onExit: (result) => {
          console.log(`[agent] ws exit code: ${result.code} (${result.platform}, ${result.shell}, cwd=${result.cwd})`);
          if (result.code !== 0) {
            if (result.stdout) console.log(`[agent] stdout:\n${truncateLog(result.stdout)}`);
            if (result.stderr) console.warn(`[agent] stderr:\n${truncateLog(result.stderr)}`);
          }
          sendWsFrame(socket, { type: 'exit', ...result });
          closeWs(socket);
        },
      });
    }
  });

  socket.on('close', () => {
    child?.kill('SIGTERM');
  });

  socket.on('error', () => {
    child?.kill('SIGTERM');
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────

if (!AUTH_DISABLED) {
  loadTokens();
}

server.listen(PORT, () => {
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
  console.log(`[agent] Server listening on http://localhost:${PORT}/agent`);
  console.log(`[agent] Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`[agent] Auth: ${AUTH_DISABLED ? 'disabled' : 'token required'}`);
  console.log(`[agent] Workspace cwd: ${WORKSPACE_DIR}`);
  console.log(`[agent] Files root: ${FILES_ROOT_DIR}`);
});
