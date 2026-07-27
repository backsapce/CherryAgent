import test from 'node:test';
import assert from 'node:assert/strict';
import { isCurrentAgentWorkspace, isOrphanedAgentWorkspace } from './pathUtils.js';

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

test('marks only the active agent directory directly under workspace as current', () => {
  assert.equal(isCurrentAgentWorkspace('workspace', 'agent-active', 'agent-active'), true);
  assert.equal(isCurrentAgentWorkspace('/workspace/', 'agent-active', 'agent-active'), true);
  assert.equal(isCurrentAgentWorkspace('workspace', 'agent-other', 'agent-active'), false);
  assert.equal(isCurrentAgentWorkspace('', 'agent-active', 'agent-active'), false);
  assert.equal(isCurrentAgentWorkspace('workspace/agent-active', 'files', 'agent-active'), false);
});

test('does not mark a current workspace without an active agent', () => {
  assert.equal(isCurrentAgentWorkspace('workspace', 'agent-active', null), false);
});
