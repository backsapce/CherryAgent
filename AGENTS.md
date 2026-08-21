# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CherryAgent is a browser-based AI agent framework. It's a React SPA that connects to LLM providers (OpenAI, Anthropic, Gemini, OpenRouter, Qwen, custom OpenAI-compatible) for sessions, with an autonomous agent loop for tool execution. All browser data is persisted in OPFS (Origin Private File System). Optionally supports E2B cloud sandboxes for remote execution.

## Commands

- **Dev (both frontend):** `npm run dev` — runs Vite (port 5173) with agent server proxy (port 3099)
- **Dev frontend only:** `npm run dev:front`
- **Dev agent server only:** `npm run dev:agent`
- **Build:** `npm run build` — Vite production build + service worker precache injection
- **Build for GitHub Pages:** `npm run build:pages` — sets `VITE_BASE=/CherryAgent/` base path
- **Lint:** `npm run lint`
- **Preview production build:** `npm run preview` — serves dist/ on port 5173 (same port as dev to preserve OPFS data)
- **Docker build:** `npm run build:docker` — multi-platform build + push

## Architecture

### Core layers

1. **React UI** (`src/components/`) — SessionList, MessagePanel, Settings, FileManage (editor + file browser), Icons
2. **Agent loop** (`src/agent/`) — autonomous multi-turn tool execution engine with context management, memory, and skills
3. **LLM layer** (`src/models/`) — unified provider interface with streaming, native tool calling, 6 provider backends
4. **Persistence** (`src/vfs/opfs.js`) — OPFS-backed virtual file system for sessions, files, memory, and skills
5. **Agent server** (`server/agent.js`) — optional Node.js HTTP server for local shell command execution
6. **E2B integration** (`src/models/e2b.js`) — cloud sandbox execution via E2B SDK

### Agent loop (`src/agent/`)

The agent system replaces the old `<execute>` XML tag parsing with native LLM tool calling:

- **`loop.js`** — `runAgentLoop()` drives the multi-turn conversation: build context -> stream LLM with tool schemas -> execute tool calls -> feed results back -> repeat up to 10 rounds. Uses `tokenlens` for context window estimation with per-model overrides for Qwen variants. Accumulates usage stats across rounds.
- **`context.js`** — `buildContext()` and `assembleApiMessages()` manage conversation context via sliding window (head protection + tail retention) with optional LLM-generated summaries of dropped messages. Compresses when usage exceeds 50% of the model's context window.
- **`tools.js`** — Tool registry singleton with OpenAI function-calling schema format. Built-in tools: `execute_command`, `read_file`, `write_file`, `list_files`, `list_local_files`, `read_local_file`, `write_memory`, `read_memory`, `clear_memory`, `skills_list`, `skill_view`, `skill_manage`. Tools declare availability via `checkAvailable()` (e.g., file tools require `agentUrl`).
- **`memory.js`** — Two bounded, file-backed stores in OPFS: `MEMORY.md` (agent notes, 2200 char limit) and `USER.md` (user profile, 1375 char limit). Entries delimited by `§`, oldest trimmed when over limit. Loaded once per session as a frozen snapshot, injected into system prompt.
- **`skills.js`** — File-based skills in OPFS `skills/` directory with progressive disclosure. Each skill has a `SKILL.md` with YAML frontmatter (name, description, version) and optional `references/` subdirectory. Tier 1: name+description in system prompt. Tier 2: full SKILL.md content on demand. Tier 3: reference files. Ships with `skill-creator` default skill. Skills can be enabled/disabled via config.

### LLM layer (`src/models/`)

- **`llm.js`** — Unified LLM singleton. `streamSession()` returns an async generator of `{ content, reasoning, toolCalls, usage }` chunks. Supports native tool calling via `tools` option. `completeSession()` convenience method for non-streaming. Settings persisted to OPFS via `settings.js`.
- **`settings.js`** — Thin adapter over `config.js` for LLM settings (`llm` key in config.yaml).
- **Providers** (`src/models/providers/`):
  - `openai.js` — OpenAI API, native tool calling
  - `anthropic.js` — Anthropic API with thinking blocks, tool use
  - `gemini.js` — Google Gemini API, native tool calling
  - `openrouter.js` — OpenRouter proxy API
  - `qwen.js` — Alibaba Qwen/DashScope API
  - `custom-openai.js` — Any OpenAI-compatible endpoint
  - `shared.js` — Common utilities shared across providers
- **`e2b.js`** — E2B cloud sandbox integration. Persistent sandbox (tagged via localStorage ID), command execution, file CRUD, upload/download. Sandbox is created/reused based on metadata filter `cherrysandbox`.

### OPFS VFS (`src/vfs/opfs.js`)

Root directory: `cherry-agent/`. Key subdirectories:
- `session.json` + `sessions/<id>.json` — session metadata and per-session message files
- `memory/` — `MEMORY.md` and `USER.md` for agent memory
- `skills/` — skill directories with `SKILL.md` and optional `references/`
- `files/` — user-managed files

Operations: session CRUD, file manager (list/create/read/write/delete, nested dirs), zip export/import, memory read/write/delete, skill CRUD with reference file support.

### Config (`src/config/config.js`)

YAML-based config persisted in OPFS. Dot-path access (`config.get('llm.provider')`), subscribe/notify pattern, singleton. All modules read config through this.

### i18n

`src/i18n/` — React context-based. `t()` function with dot-path keys and `{param}` interpolation. Locale files in `src/i18n/locales/` (en, zh-CN, ja). Supports `auto` (browser language detection).

### PWA

Service worker in `public/sw.js` with precache manifest injected at build time by `swPrecachePlugin` in `vite.config.js`.

## Data flow

1. User sends message -> messages accumulated in session state
2. `runAgentLoop()` called -> loads memory snapshot + skills list -> assembles API messages with context window check
3. LLM streams with tool schemas -> tool calls extracted from streaming fragments
4. Tools dispatched via registry -> results fed back as `tool` role messages
5. Loop continues up to `DEFAULT_MAX_ROUNDS=10` rounds
6. Context compression triggers at 50% window: head (4 messages) + tail (20 messages) + LLM summary of dropped turns

## Important conventions

- ESLint rule: `no-unused-vars` ignores variables matching `^[A-Z_]` (use uppercase prefix for intentionally unused vars)
- Provider modules must export `{ id, name, stream, listModels, fallbackModels, defaultModel }`
- All browser persistence goes through OPFS, not localStorage or IndexedDB directly (except E2B sandbox ID in localStorage)
- Vite dev server port (5173) matches preview port so OPFS data survives dev/preview switches
- Streaming accumulates content in refs, flushed to React state via `requestAnimationFrame` for frame-synced rendering
- Tool schemas are filtered by `checkAvailable()` before sending to LLM — tools requiring `agentUrl` are hidden when no agent server is connected
- Memory is a frozen snapshot loaded once at agent loop start — mid-session writes update disk but don't change the active system prompt
