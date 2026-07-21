import test from 'node:test';
import assert from 'node:assert/strict';
import { isOrphanedAgentWorkspace } from './pathUtils.js';

test('marks only unowned directories directly under workspace as orphaned', () => {
  const agentIds = new Set(['agent-active']);

  assert.equal(isOrphanedAgentWorkspace('workspace', 'agent-deleted', agentIds), true);
  assert.equal(isOrphanedAgentWorkspace('/workspace/', 'agent-active', agentIds), false);
  assert.equal(isOrphanedAgentWorkspace('', 'agent-deleted', agentIds), false);
  assert.equal(isOrphanedAgentWorkspace('workspace/agent-deleted', 'files', agentIds), false);
});

test('does not mark workspaces until agent metadata is available', () => {
  assert.equal(isOrphanedAgentWorkspace('workspace', 'agent-deleted', null), false);
});
