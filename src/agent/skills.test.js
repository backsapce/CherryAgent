import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import config from '../config/config.js';
import { buildSkillsSection, resetDefaultSkillsCache, setSkillEnabled } from './skills.js';
import { registry } from './tools.js';
import { readAgentSkillFile, writeSkillFile } from '../vfs/opfs.js';
import { resetAgentConnections } from '../models/agentConnection.js';

let rootDir;

beforeEach(async () => {
  rootDir = new TestDirectoryHandle();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      storage: {
        getDirectory: async () => rootDir,
      },
    },
  });
  await config.setAll({});
  delete globalThis.fetch;
  delete globalThis.window;
  resetAgentConnections();
  resetDefaultSkillsCache();
});

test('skill is the only model-facing tool for skill operations', () => {
  const skillTools = registry.getAll().filter((tool) => tool.category === 'skills');
  assert.deepEqual(skillTools.map((tool) => tool.name), ['skill']);
  assert.deepEqual(
    skillTools[0].schema.parameters.properties.action.enum,
    ['list', 'read', 'write']
  );
  assert.equal(registry.get('list_skill_files'), null);
  assert.equal(registry.get('read_skill_file'), null);
  assert.equal(registry.get('write_skill_file'), null);
});

test('skill tool writes, lists, and progressively reads OPFS workspace skills', async () => {
  const skillContent = `---
name: code-review
description: Review a code change for correctness.
version: 1.0.0
---

# Code Review

Inspect the changed code before reporting findings.
`;

  assert.equal(
    await registry.dispatch('skill', {
      action: 'write',
      name: 'code-review',
      content: skillContent,
    }, { agentId: 'agent-test' }),
    'Successfully wrote skill code-review.'
  );

  const listResult = await registry.dispatch('skill', {
    action: 'list',
    query: 'correctness',
  }, { agentId: 'agent-test' });
  assert.match(listResult, /code-review \(workspace, v1\.0\.0\)/);

  assert.equal(
    await registry.dispatch('skill', {
      action: 'write',
      name: 'code-review',
      reference_name: 'checklist.md',
      content: '# Checklist\n\n- Verify behavior.',
    }, { agentId: 'agent-test' }),
    'Successfully wrote skill reference code-review/checklist.md.'
  );

  const skillResult = await registry.dispatch('skill', {
    action: 'read',
    name: 'code-review',
  }, { agentId: 'agent-test' });
  assert.match(skillResult, /Inspect the changed code/);
  assert.match(skillResult, /## Available References\n- checklist\.md/);
  assert.doesNotMatch(skillResult, /Verify behavior/);

  const referenceResult = await registry.dispatch('skill', {
    action: 'read',
    name: 'code-review',
    reference_name: 'checklist.md',
  }, { agentId: 'agent-test' });
  assert.match(referenceResult, /# Reference: code-review\/checklist\.md/);
  assert.match(referenceResult, /Verify behavior/);
});

test('browser skill loading merges global, workspace, then selected agent skills', async () => {
  const globalContent = skillDocument('layered-skill', 'Global description', 'Global instructions.');
  const workspaceContent = skillDocument('layered-skill', 'Workspace description', 'Workspace instructions.');
  const agentContent = skillDocument('layered-skill', 'Agent description', 'Agent instructions.');
  await writeSkillFile('layered-skill', 'SKILL.md', globalContent);
  await registry.dispatch('skill', {
    action: 'write',
    name: 'layered-skill',
    content: workspaceContent,
  }, { agentId: 'agent-test' });

  const workspaceOnly = await registry.dispatch('skill', {
    action: 'list',
    query: 'layered',
  }, { agentId: 'agent-test' });
  assert.match(workspaceOnly, /layered-skill \(workspace, v1\.0\.0\): Workspace description/);

  installAgentFileApi(new Map([
    ['skills/layered-skill/SKILL.md', agentContent],
    ['skills/layered-skill/references/agent-notes.md', 'Agent-only notes.'],
  ]));

  const context = { agentId: 'agent-test', agentUrl: 'https://runtime.test' };
  const merged = await registry.dispatch('skill', {
    action: 'list',
    query: 'layered',
  }, context);
  assert.match(merged, /layered-skill \(agent, v1\.0\.0\): Agent description/);
  assert.match(merged, /refs=\[agent-notes\.md\]/);

  const loaded = await registry.dispatch('skill', {
    action: 'read',
    name: 'layered-skill',
  }, context);
  assert.match(loaded, /Agent instructions/);
  assert.doesNotMatch(loaded, /Workspace instructions/);

  const agentReference = await registry.dispatch('skill', {
    action: 'read',
    name: 'layered-skill',
    reference_name: 'agent-notes.md',
  }, context);
  assert.match(agentReference, /# Reference: layered-skill\/agent-notes\.md/);
  assert.match(agentReference, /Agent-only notes/);

  const browserCreated = skillDocument('browser-created', 'Browser-created skill', 'Stored in OPFS.');
  await registry.dispatch('skill', {
    action: 'write',
    name: 'browser-created',
    content: browserCreated,
  }, context);
  assert.equal(
    await readAgentSkillFile('agent-test', 'browser-created', 'SKILL.md'),
    browserCreated
  );
});

test('runtime skill discovery does not request an absent references directory', async () => {
  const requestedPaths = [];
  installAgentFileApi(new Map([
    ['skills/skill-creator/SKILL.md', skillDocument(
      'skill-creator',
      'Create reusable skills.',
      'Keep the workflow focused.'
    )],
  ]), { requestedPaths, missingDirectoriesReturn404: true });

  const result = await registry.dispatch('skill', {
    action: 'list',
    query: 'reusable',
  }, { agentId: 'agent-test', agentUrl: 'https://runtime.test' });

  assert.match(result, /skill-creator \(agent, v1\.0\.0\)/);
  assert.ok(requestedPaths.includes('skills/skill-creator'));
  assert.ok(!requestedPaths.includes('skills/skill-creator/references'));
});

test('runtime skill discovery loads skill directories concurrently', { timeout: 2_000 }, async () => {
  const files = new Map([
    ['skills/alpha/SKILL.md', skillDocument('alpha', 'Alpha skill.', 'Alpha instructions.')],
    ['skills/beta/SKILL.md', skillDocument('beta', 'Beta skill.', 'Beta instructions.')],
  ]);
  const started = [];
  const releases = new Map();
  let markAllStarted;
  const allStarted = new Promise((resolve) => { markAllStarted = resolve; });
  installAgentFileApi(files, {
    onRequest({ path, type }) {
      if (type !== 'file.download') return undefined;
      return new Promise((resolve) => {
        started.push(path);
        releases.set(path, resolve);
        if (started.length === files.size) markAllStarted();
      });
    },
  });

  const controller = new AbortController();
  const pending = buildSkillsSection('agent-test', {
    runtimeMode: 'sandbox',
    agentUrl: 'https://runtime.test',
    signal: controller.signal,
  });
  let concurrencyTimer;
  const concurrent = await Promise.race([
    allStarted.then(() => true),
    new Promise((resolve) => {
      concurrencyTimer = setTimeout(() => resolve(false), 250);
    }),
  ]);
  clearTimeout(concurrencyTimer);
  if (!concurrent) {
    controller.abort();
    await pending.catch(() => {});
    assert.fail(`Expected concurrent skill requests, started: ${started.join(', ')}`);
  }

  for (const release of releases.values()) release();
  const catalog = await pending;
  assert.match(catalog, /alpha/);
  assert.match(catalog, /beta/);
});

test('runtime skill catalog has one overall startup deadline', { timeout: 2_000 }, async () => {
  const files = new Map([
    ['skills/stalled/SKILL.md', skillDocument('stalled', 'Stalled skill.', 'Never returned.')],
  ]);
  installAgentFileApi(files, {
    onRequest({ type }) {
      if (type !== 'file.download') return undefined;
      return new Promise(() => {});
    },
  });

  const startedAt = Date.now();
  const catalog = await buildSkillsSection('agent-test', {
    runtimeMode: 'sandbox',
    agentUrl: 'https://runtime.test',
    runtimeCatalogTimeoutMs: 25,
  });

  assert.ok(Date.now() - startedAt < 500);
  assert.match(catalog, /skill-creator/);
  assert.doesNotMatch(catalog, /stalled/);
});

test('runtime skill transport failures are skipped when the run signal is live', async () => {
  // A transport failure that is not the caller's abort (here: the connection
  // dropping mid-request) must degrade the runtime catalog, not throw.
  installAgentFileApi(new Map(), {
    onRequest({ path, type }) {
      if (path !== 'skills' || type !== 'file.list') return undefined;
      return Promise.reject(new Error('proxy closed request'));
    },
  });

  const catalog = await buildSkillsSection('agent-test', {
    runtimeMode: 'sandbox',
    agentUrl: 'https://runtime.test',
  });

  assert.match(catalog, /skill-creator/);
});

test('runtime skill discovery forwards and honors the run abort signal', { timeout: 2_000 }, async () => {
  const controller = new AbortController();
  let markRequestStarted;
  const requestStarted = new Promise((resolve) => { markRequestStarted = resolve; });

  installAgentFileApi(new Map(), {
    onRequest({ path }) {
      if (path !== 'skills') return undefined;
      markRequestStarted();
      return new Promise(() => {});
    },
  });

  const pending = buildSkillsSection('agent-test', {
    runtimeMode: 'sandbox',
    agentUrl: 'https://runtime.test',
    signal: controller.signal,
  });

  await requestStarted;
  controller.abort();
  const error = await pending.then(() => null, (reason) => reason);
  assert.equal(error?.name, 'AbortError');
});

test('skill tool validates writes and refuses to read disabled skills', async () => {
  const invalidResult = await registry.dispatch('skill', {
    action: 'write',
    name: 'invalid-skill',
    content: '# Missing frontmatter',
  }, { agentId: 'agent-test' });
  assert.match(invalidResult, /frontmatter with name and description/);

  const skillContent = `---
name: private-skill
description: A disabled test skill.
version: 1.0.0
---

# Private Skill
`;
  await registry.dispatch('skill', {
    action: 'write',
    name: 'private-skill',
    content: skillContent,
  }, { agentId: 'agent-test' });
  await setSkillEnabled('private-skill', false);

  assert.equal(
    await registry.dispatch('skill', {
      action: 'read',
      name: 'private-skill',
    }, { agentId: 'agent-test' }),
    'Skill is disabled: private-skill'
  );
  assert.doesNotMatch(
    await registry.dispatch('skill', {
      action: 'list',
    }, { agentId: 'agent-test' }),
    /private-skill/
  );
});

class TestDirectoryHandle {
  kind = 'directory';

  constructor() {
    this.entries = new Map();
  }

  async getDirectoryHandle(name, options = {}) {
    const existing = this.entries.get(name);
    if (existing) {
      if (existing.kind !== 'directory') throw new Error(`${name} is not a directory`);
      return existing;
    }
    if (!options.create) throw new Error(`Directory not found: ${name}`);
    const dir = new TestDirectoryHandle();
    this.entries.set(name, dir);
    return dir;
  }

  async getFileHandle(name, options = {}) {
    const existing = this.entries.get(name);
    if (existing) {
      if (existing.kind !== 'file') throw new Error(`${name} is not a file`);
      return existing;
    }
    if (!options.create) throw new Error(`File not found: ${name}`);
    const file = new TestFileHandle(name);
    this.entries.set(name, file);
    return file;
  }

  async removeEntry(name) {
    if (!this.entries.delete(name)) throw new Error(`Entry not found: ${name}`);
  }

  async *[Symbol.asyncIterator]() {
    yield* this.entries;
  }
}

function skillDocument(name, description, body) {
  return `---
name: ${name}
description: ${description}
version: 1.0.0
---

# ${name}

${body}
`;
}

function installAgentFileApi(files, options = {}) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        href: 'https://app.test/',
        origin: 'https://app.test',
      },
    },
  });
  resetAgentConnections();

  // Fake agent server speaking the multiplexed WS protocol far enough for
  // runtime skill discovery: hello, file.list, and chunked file.download.
  class SkillSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      super();
      this.url = url;
      this.readyState = SkillSocket.CONNECTING;
      queueMicrotask(() => {
        this.readyState = SkillSocket.OPEN;
        this.dispatchEvent(new Event('open'));
      });
    }

    send(data) {
      const message = JSON.parse(data);
      queueMicrotask(() => { void this.handle(message); });
    }

    close() {
      if (this.readyState === SkillSocket.CLOSED) return;
      this.readyState = SkillSocket.CLOSED;
      queueMicrotask(() => this.dispatchEvent(new Event('close')));
    }

    emit(value) {
      queueMicrotask(() => {
        if (this.readyState !== SkillSocket.OPEN) return;
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
      });
    }

    binary(streamId, text, final = true) {
      const bytes = new TextEncoder().encode(text);
      const frame = new Uint8Array(5 + bytes.byteLength);
      const view = new DataView(frame.buffer);
      view.setUint32(0, streamId);
      frame[4] = final ? 1 : 0;
      frame.set(bytes, 5);
      queueMicrotask(() => {
        if (this.readyState !== SkillSocket.OPEN) return;
        this.dispatchEvent(new MessageEvent('message', {
          data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength),
        }));
      });
    }

    reply(id, ok, payload) {
      if (ok) this.emit({ id, ok: true, data: payload });
      else this.emit({ id, ok: false, error: payload.error, code: payload.code ?? 500 });
    }

    async handle(message) {
      if (message.type === 'hello') {
        this.reply(message.id, true, { authenticated: true, needsAuth: false, capabilities: {} });
        return;
      }
      // Gating hook: a rejected gate simulates a transport failure and must
      // become an error reply, never an unhandled rejection.
      try {
        if (message.type === 'file.list') {
          const gated = options.onRequest?.({ path: message.payload.path || '', type: 'file.list' });
          if (gated) await gated;
        } else if (message.type === 'file.download') {
          const gated = options.onRequest?.({ path: message.payload.path, type: 'file.download' });
          if (gated) await gated;
        }
      } catch (error) {
        this.reply(message.id, false, { error: error.message, code: 500 });
        return;
      }
      if (message.type === 'file.list') {
        const dirPath = message.payload.path || '';
        options.requestedPaths?.push(dirPath);
        const prefix = dirPath ? `${dirPath}/` : '';
        const children = new Map();
        for (const filePath of files.keys()) {
          if (!filePath.startsWith(prefix)) continue;
          const remainder = filePath.slice(prefix.length);
          if (!remainder) continue;
          const [name, ...tail] = remainder.split('/');
          children.set(name, {
            name,
            type: tail.length ? 'directory' : 'file',
          });
        }
        if (dirPath && children.size === 0 && options.missingDirectoriesReturn404) {
          this.reply(message.id, false, { error: 'Directory not found', code: 404 });
          return;
        }
        this.reply(message.id, true, children.size === 0
          ? { id: 'root', children: [] }
          : Array.from(children.values()));
        return;
      }
      if (message.type === 'file.download') {
        const filePath = message.payload.path;
        options.requestedPaths?.push(filePath);
        const content = files.get(filePath);
        if (content == null) {
          this.reply(message.id, false, { error: 'File not found', code: 404 });
          return;
        }
        this.reply(message.id, true, { streamId: message.payload.streamId, size: content.length });
        this.binary(message.payload.streamId, content);
        return;
      }
      this.reply(message.id, false, { error: `Unhandled ${message.type}`, code: 400 });
    }
  }

  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: SkillSocket });
}

class TestFileHandle {
  kind = 'file';

  constructor(name) {
    this.name = name;
    this.content = '';
  }

  async getFile() {
    return {
      name: this.name,
      size: this.content.length,
      lastModified: 1,
      text: async () => this.content,
    };
  }

  async createWritable() {
    const chunks = [];
    return {
      write: async (content) => chunks.push(String(content)),
      close: async () => {
        this.content = chunks.join('');
      },
    };
  }
}
