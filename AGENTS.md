# AGENTS.md

This file provides guidance to AI coding agents (ZCode, Claude Code, etc.) when working with code in this repository.

## Project Overview

CherryAgent is a browser-based AI agent framework. It's a React SPA that connects to LLM providers (OpenAI, Anthropic, Gemini, OpenRouter, Qwen, DeepSeek, any OpenAI-compatible endpoint) via the Vercel AI SDK, with an autonomous agent loop for tool execution. All browser data is persisted in OPFS (Origin Private File System). An optional Node.js agent server (`cherry-sandbox`) executes shell commands and durable sandbox runs locally; E2B cloud sandboxes are supported for remote execution.

## Commands

- **Dev (frontend + agent server):** `npm run dev` — runs Vite (https://localhost:5173) and the agent server (loopback :3099) with a Vite proxy for `/agent`
- **Dev frontend only:** `npm run dev:front`
- **Dev agent server only:** `npm run dev:agent`
- **Build:** `npm run build` — Vite production build + service worker precache injection
- **Build for GitHub Pages:** `npm run build:pages` — sets `VITE_BASE=/CherryAgent/` base path
- **Lint:** `npm run lint`
- **All tests:** `npm test` (= `test:agent` + `test:runtime` + `test:sync`)
- **Agent-loop tests:** `npm run test:agent`
- **Agent-server tests:** `npm run test:runtime`
- **Sync/persistence/UI tests:** `npm run test:sync`
- **Preview production build:** `npm run preview` — serves dist/ on port 5173 (same port as dev to preserve OPFS data)
- **Docker build:** `npm run build:docker` — multi-platform build + push

## Architecture

### Core layers

1. **React UI** (`src/components/`) — SessionList, MessagePanel, Settings, FileManage (editor + file browser), Icons
2. **Agent loop** (`src/agent/`) — autonomous multi-turn tool execution over Vercel AI SDK `streamText`, with context packing, summary compaction, memory, skills, and a UI-safe event protocol
3. **LLM layer** (`src/models/`) — provider-neutral AI SDK model factory (`ai.js`), profile/connection settings (`llm.js`, `llmSettingsSchema.js`), agent-server client (`agent.js`), E2B integration (`e2b.js`)
4. **Persistence** (`src/vfs/opfs.js`) — OPFS-backed virtual file system for sessions, files, memory, and skills
5. **Agent server** (`server/`) — optional Node.js server for local shell execution, managed background jobs, and durable sandbox runs; all browser↔server traffic rides one multiplexed WebSocket connection (`/agent/ws`)
6. **Sync** (`src/sync/`) — S3/OSS-backed multi-device sync with ETag CAS, sharded causal manifests, and Yjs three-way merges

### Agent loop (`src/agent/`)

The loop is built on the Vercel AI SDK: `streamText` owns the model → tool → model cycle and `runAgentLoop()` (loop.js) adapts it with CherryAgent's tools, context packing, bounded-loop policy, and a versioned event stream (events.js) that the browser UI and durable sandbox runs both consume.

- **`loop.js`** — `runAgentLoop()` streams with tool schemas, serializes tool executions, retries empty model responses once, and appends a tool-free finalizer turn when the step budget ends. Rounds: default 40, hard cap 80. Accepts and returns `summaryState` for cross-turn summary persistence. `prepareStep` compacts the AI SDK loop history (head + tail, 72% of the context window) via `compactAiMessages`.
- **`context.js`** — `assembleApiMessages()` packs conversation with head protection, an LLM-generated summary of the dropped middle, and the freshest tail. The summary is anchored to the message id it covers (`anchorId`); `summaryStateMatchesHistory()` invalidates it when history is edited or truncated. Token estimation (`tokenEstimate.js`) is CJK-aware (~1 token per CJK char, ~1 per 4 Latin chars).
- **`tools.js`** — Tool registry singleton (OpenAI function-calling schema). Built-ins: `execute_command`, `start_command`, `get_command`, `wait_command`, `stop_command` (managed background jobs), `list/read/write_browser_file`, `display_browser_image`, `list/read/write_sandbox_file`, `display_sandbox_image`, `memory`, `skill`, `schedule_wakeup`, `spawn_agent` (depth-1 sub-agents). Tools declare availability via `checkAvailable()`; results are capped and middle-truncated for the model (`toolObservation.js`).
- **`dangerousCommand.js`** — detects destructive/privileged shell commands (rm with force/recursive flags, sudo, disk writes, shutdown, fork bombs, curl|sh, force push). In interactive runtimes these trigger a permission request the user must approve (App.jsx renders the approval card); unattended sandbox runs proceed but record the decision. Catastrophic patterns are additionally blocklisted server-side.
- **`loopSafety.js`** — doom-loop guard: N consecutive identical tool calls trigger the same permission flow.
- **`memory.js`** — two bounded, structured Markdown stores in OPFS per agent: `MEMORY.md` (project facts, 8k chars) and `USER.md` (user profile, 4k chars). v2 record format with ids/tags/importance; mutation-queued to prevent lost updates. Loaded once per run as a frozen prompt snapshot.
- **`skills.js`** — progressive-disclosure skills (OPFS global → workspace → agent/sandbox precedence). Tier 1: catalog in system prompt. Tier 2: SKILL.md via `skill` tool. Tier 3: reference files. Ships with `skill-creator`.
- **`events.js`** — pure reducer translating stream events into an immutable run snapshot (content/thinking maintained incrementally per delta; transcript segments, tool states, permissions, compactions). Replayed identically by the browser UI and durable sandbox runs.
- **`wakeup.js`** — schedule future continuations (5s–7d) instead of blocking or polling.

### LLM layer (`src/models/`)

- **`ai.js`** — AI SDK model factory for all providers (Anthropic gets the direct-browser-access header; OpenRouter gets referer headers). `toModelMessages()` converts persisted history; assistant tool history crosses turns as XML blocks embedded in assistant content (App.jsx `expandMessagesForLlm`), not native tool-role messages.
- **`llm.js`** — profile/connection settings: provider connections own credentials, LLM records select a model. API keys never leave `getRuntimeConfig()`/`getLanguageModel()` except over the authenticated sandbox-run channel. Context windows resolved from models.dev with a static fallback (`contextWindow.js` + tokenlens).
- **`agent.js`** — agent-server client API surface over the shared WebSocket connection from `agentConnection.js`: hello/connect auth, streamed `executeCommand`, managed jobs, file CRUD + binary transfer, web proxies, and durable runs (`start`/`continue`/`state`/`subscribe`/`cancel`). Enforces wss for non-loopback agent URLs (`assertSecureAgentUrl`).

### Agent server (`server/`)

- **`agent.js`** — WebSocket server (plus static frontend hosting). Binds 127.0.0.1 on bare hosts and 0.0.0.0 when a container runtime is detected (`AGENT_HOST` overrides either). Token auth via first-frame `hello`/`connect` (token file mode 0600, temp token printed to console, rotates on use or after 10 min). The upgrade-time Origin allowlist is the CSRF guard when auth is disabled. WS frames are size-bounded (small caps pre-auth, large caps for run payloads after auth). A small blocklist rejects catastrophic commands (fork bombs, `rm -rf /`, `curl | sh`).
- **`command-executor.js`** — spawns commands in their own process group with tree-kill on timeout/abort/output-limit, streaming UTF-8 decoding, and a settle watchdog.
- **`command-jobs.js`** — durable background jobs with incremental byte-cursor logs (UTF-8-boundary-safe reads), capped active jobs, and retention-based cleanup.
- **`agent-runtime.js`** — durable sandbox runs: the server runs the agent loop itself (model calls included) with an idle watchdog, wake-up continuations that survive restarts, immutable forced cancellation, and retention-based pruning. Protocol 4: completed turns leave the run `idle` and continuable (`run.continue` appends one user message instead of re-uploading history; divergence is detected via the client's user-message count), streaming deltas are coalesced (~100ms batches) before hitting the ndjson log, the log stores bare events (scope prefixes are applied at serve time), and live subscriptions push event batches + status snapshots. Run state files are mode 0600 because waiting/idle runs carry the caller's model credentials.
- **`file-path-policy.js`** — path safety: lexical + realpath + symlink-never-followed checks for the files root and protected control-plane paths.

### OPFS VFS (`src/vfs/opfs.js`)

Root directory: `cherry-agent/`. Key subdirectories: `config.yaml`, `session.json` + `sessions/<id>.json`, `workspace/<agent-id>/{AGENTS.md, memory/, skills/, files/}`, `skills/` (global). Session persistence is atomic (temp-swap writes, index published last) with a generation-fenced save coordinator and crash-recovery journal. Zip export/import supported.

### Config (`src/config/config.js`)

YAML-based config persisted in OPFS. Dot-path access, subscribe/notify, serialized operation queue, prototype-pollution-safe path writes. All modules read config through this.

### Sync (`src/sync/`)

S3/OSS-backed sync with ETag CAS, sharded manifests with vector clocks, Web Locks coordination, Yjs three-way merges, conflict backups under `files/Sync Conflicts/`, and a scrub journal. Sync credentials stay device-local; LLM API keys, agent tokens, and the E2B key sync with the config so re-authenticating a sandbox or rotating a key propagates to every device.

### i18n / PWA

React context i18n with dot-path keys and `{param}` interpolation (en, zh-CN, ja). Service worker precaches the app shell at build time.

## Data flow

1. User sends message → messages accumulate in session state (persisted via the save coordinator)
2. `runAgentLoop()` loads memory snapshot + skills catalog, packs context with the persisted `summaryState` (validated by anchor), streams with tool schemas
3. Tool calls dispatch through the registry (dangerous commands pause for user approval in the browser); results are capped, middle-truncated, and fed back
4. Loop continues up to the round budget; the final result carries the updated `summaryState`, persisted on the assistant reply for the next turn
5. Sandbox-runtime sessions start (or incrementally continue) a durable run on the agent server and subscribe to its live event stream; the ndjson event log and `remoteSequence` cursor remain the reconnect/replay source of truth, and wake-ups continue the run across disconnects and server restarts

## Important conventions

- ESLint `no-unused-vars` ignores `^[A-Z_]`-prefixed variables (use uppercase prefix for intentionally unused destructured fields)
- All browser persistence goes through OPFS (except the E2B sandbox id in localStorage)
- Vite dev port (5173) matches preview port so OPFS data survives dev/preview switches
- Streaming state is flushed to React via requestAnimationFrame; MessagePanel caches rendered markdown by content (bypassed for the live streaming message)
- Tool schemas are filtered by `checkAvailable()` before sending to the LLM
- All browser↔agent-server traffic (auth, commands, jobs, files, web proxies, runs) multiplexes over one WebSocket per agent URL (`src/models/agentConnection.js` + `server/ws-protocol.js`); there is no `/agent` HTTP API anymore
- Memory is a frozen snapshot loaded once per run; mid-session writes update disk but not the active prompt
- Security invariants worth preserving: agent server stays loopback by default; sync credentials never leave the device; permission approval gates destructive commands; file-path policy rejects symlinks below the files root
