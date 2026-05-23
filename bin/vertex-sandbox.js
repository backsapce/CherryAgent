#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Vertex Sandbox

Usage:
  vertex-sandbox

Environment:
  AGENT_PORT             HTTP port for /agent (default: 3099)
  AGENT_WORKING_DIR      Command working directory (default: process cwd)
  AGENT_FILES_DIR        File API root (default: AGENT_WORKING_DIR)
  AGENT_TOKEN_FILE       Auth token file (default: .vertex-token)
  AGENT_ALLOWED_ORIGINS  Comma-separated CORS allowlist
  AGENT_DISABLE_AUTH     Set true only behind a trusted boundary
`);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
  console.log(pkg.version);
  process.exit(0);
}

await import('../server/agent.js');
