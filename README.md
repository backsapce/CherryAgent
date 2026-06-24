# VertexAgent

VertexAgent is a browser-based AI agent workspace. It runs as a React single-page app, stores data in the browser's Origin Private File System (OPFS), and can optionally connect to an execution sandbox for shell commands and file operations.

Hosted app: https://backsapce.github.io/VertexAgent/

## What It Does

- Start sessions with OpenAI, Anthropic, Gemini, OpenRouter, Qwen, or a custom OpenAI-compatible API.
- Run an autonomous tool loop with native provider tool calling.
- Persist sessions, settings, memory, skills, and files locally in OPFS.
- Manage local browser files or files on a connected sandbox.
- Optionally execute commands through E2B Cloud Sandbox or a self-hosted Agent Node.
- Export/import browser data as a ZIP.
- Install as a PWA.

## Privacy Model

VertexAgent does not require an application backend for normal session usage. API keys, sessions, settings, memory, skills, and managed files are stored in your browser through OPFS.

External services are contacted only when you configure them:

- LLM provider APIs for session/model requests.
- E2B when an E2B API key is enabled.
- A custom Agent Node when you add one.

## Quick Start

Use the hosted app:

```text
https://backsapce.github.io/VertexAgent/
```

For local development:

```bash
git clone https://github.com/backsapce/VertexAgent
cd VertexAgent
npm install
npm run dev
```

The dev command starts:

- Vite frontend on `https://localhost:5173`
- Local Agent Node on `http://localhost:3099`

## Commands

```bash
npm run dev          # Frontend + local Agent Node
npm run dev:front    # Frontend only
npm run dev:agent    # Agent Node only
npm run build        # Production build
npm run build:pages  # GitHub Pages build with /VertexAgent/ base path
npm run lint         # ESLint
npm run preview      # Preview dist/ on port 5173
```

## Configure An LLM

Open Settings in the app and choose a provider:

- OpenAI
- Anthropic Claude
- Google Gemini
- OpenRouter
- Qwen/DashScope
- Custom OpenAI-compatible endpoint

API keys are saved locally in browser storage through the app config.

## Sandboxes

Sandbox support is optional. VertexAgent works as a private browser session app without any sandbox connected.

### E2B Cloud

1. Open Settings.
2. Add your E2B API key.
3. Enable E2B Cloud Sandbox.

VertexAgent keeps a sandbox ID in `localStorage` so it can reconnect after page reloads.

### Self-Hosted Agent Node

Run the Agent Node when you want VertexAgent to execute commands or manage files on a machine you control.

```bash
npm run dev:agent
```

Install the sandbox runtime from GitHub with npm and keep it in the background with PM2:

```bash
curl -fsSL https://raw.githubusercontent.com/backsapce/VertexAgent/main/script/install_sandbox_npm.sh | sh
```

The installer runs `npm install -g github:backsapce/VertexAgent`, starts the `vertex-sandbox` binary with PM2, and saves the PM2 process list. The default workspace is `~/vertex-workspace`; override it with `VERTEX_SANDBOX_WORKDIR=/path/to/workspace`. You can also run the binary yourself after installing:

```bash
npm install -g github:backsapce/VertexAgent
vertex-sandbox
```

Or run the Docker image:

```bash
mkdir -p ./vertex-workspace

docker run -d \
  --name vertex-sandbox \
  --restart unless-stopped \
  -p 3099:3099 \
  -e AGENT_ALLOWED_ORIGINS=https://your-frontend-origin \
  -v "$(pwd)/vertex-workspace:/home/vertex" \
  backsapce/vertex-sandbox:latest
```

The sandbox container uses `/home/vertex` as its Docker `WORKDIR` and `AGENT_WORKING_DIR`. Mount your host workspace directory there so `docker exec`, shell commands, file operations, and the saved `.vertex-token` all use the same persistent home directory:

```bash
docker run -d \
  --name vertex-sandbox \
  --restart unless-stopped \
  -p 3099:3099 \
  -e AGENT_ALLOWED_ORIGINS=https://your-frontend-origin \
  -v "/absolute/path/to/workspace:/home/vertex" \
  backsapce/vertex-sandbox:latest
```

## Self-Hosted Front

```bash
npm run dev:agent
```

or

```bash
docker run -d \
  --name vertex-agent \
  --restart unless-stopped \
  -p 3098:80 \
  backsapce/vertex-agent:latest
```

The server prints a temporary pairing token on startup. Paste that token into VertexAgent Settings to exchange it for a long-lived token.

Agent Node environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `AGENT_PORT` | `3099` | HTTP port for `/agent` |
| `AGENT_WORKING_DIR` | Server process cwd | Agent workspace root. Commands run here, and file APIs use this same directory by default. |
| `AGENT_FILES_DIR` | `AGENT_WORKING_DIR` | Optional separate root for file APIs. Set this only when you intentionally want managed files isolated from the command cwd. |
| `AGENT_TOKEN_FILE` | `.vertex-token` | File used to persist long-lived auth tokens; the sandbox Docker image sets this to `/home/vertex/.vertex-token`. |
| `AGENT_DISABLE_AUTH` | unset | Set to `true` only when the sandbox is already protected by another trusted boundary. When enabled, `/agent` returns `needsAuth: false` and command/file APIs do not require a token. |
| `AGENT_ALLOWED_ORIGINS` | `http://localhost:5173` | Comma-separated CORS allowlist |
| `AGENT_SHELL` | Windows: `%ComSpec%`; other platforms: Node default | Shell used to execute commands. Set to `powershell.exe` or `pwsh.exe` when you want PowerShell syntax. |

PowerShell examples:

```powershell
$env:AGENT_SHELL = 'powershell.exe'
npm run dev:agent
```

Use PowerShell command syntax in that mode, for example:

```powershell
Get-ChildItem -LiteralPath 'D:\code\Bili23-Downloader' -File | Select-Object -ExpandProperty FullName -First 100
```

## Architecture

```text
src/components/      React UI
src/agent/           Agent loop, tools, context, memory, skills
src/models/          LLM providers, settings, sandbox client
src/vfs/opfs.js      OPFS virtual filesystem
src/config/          YAML-backed browser config
server/agent.js      Optional local/remote Agent Node
public/sw.js         PWA service worker
```

Core runtime flow:

1. The user sends a message.
2. `runAgentLoop()` builds context from session history, memory, and skills.
3. The selected provider streams model output and native tool calls.
4. Tool calls are dispatched through the tool registry.
5. Tool results are fed back to the model until the loop completes or reaches the round limit.
6. Session state is saved back to OPFS.

### Agent run events

`src/agent/events.js` is the provider-neutral event contract for a live agent
turn. The loop emits a versioned run lifecycle (`run-start` / `run-finish`),
step boundaries, text and reasoning segment boundaries, streamed tool-input
phases, tool state changes, permission decisions, and context compaction
telemetry. Its reducer builds the message snapshot used by the UI, so the same
event stream can also be replayed by debugging or persistence code.

The loop blocks a third consecutive identical tool call by default. Hosts that
want an approval UI can provide `runAgentLoop({ onPermissionRequest })`; only a
callback resolving to `true` permits that repeated call.

## Data Storage

Browser data lives under the OPFS root:

```text
vertex-agent/
  session.json
  sessions/
  memory/
  skills/
  files/
  workspace/
```

Agent Node commands and file APIs use the same workspace root: `AGENT_WORKING_DIR`. Set `AGENT_FILES_DIR` only if you want file APIs to use a different root.

## Development Notes

- Keep browser persistence inside OPFS unless a browser API specifically requires otherwise.
- Provider modules export `id`, `name`, `stream`, `listModels`, `fallbackModels`, and `defaultModel`.
- Tool schemas are filtered by availability before they are sent to providers.
- The preview server uses port `5173` so OPFS data survives switching between dev and preview.
- Service worker precache entries are injected during production builds.

## License

MIT
