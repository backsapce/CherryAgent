import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import config from '../config/config.js';
import { setSkillEnabled } from './skills.js';
import { registry } from './tools.js';
import { readAgentSkillFile, writeSkillFile } from '../vfs/opfs.js';

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

function installAgentFileApi(files) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        href: 'https://app.test/',
        origin: 'https://app.test',
      },
    },
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input) => {
      const url = new URL(String(input));
      const path = url.searchParams.get('path') || '';
      if (url.pathname.endsWith('/files/download')) {
        const content = files.get(path);
        return content == null
          ? new Response(JSON.stringify({ error: 'File not found' }), { status: 404 })
          : new Response(content, { status: 200 });
      }
      if (url.pathname.endsWith('/files')) {
        const prefix = path ? `${path}/` : '';
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
        if (!path && children.size === 0) {
          return new Response(JSON.stringify({ id: 'root', children: [] }), { status: 200 });
        }
        return new Response(JSON.stringify(Array.from(children.values())), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    },
  });
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
