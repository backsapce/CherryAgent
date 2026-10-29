/**
 * Default file tree source for the right-side file panel.
 *
 * Agents running in the sandbox runtime open on the sandbox (remote) tree;
 * browser-runtime agents keep the local OPFS tree. Returns null while the
 * agent list or agent id is unavailable so a late-arriving list can still
 * apply the default instead of guessing "local".
 */
export function getDefaultFileSource(agentList, agentId) {
  if (!agentId || !Array.isArray(agentList)) return null;
  const agent = agentList.find((entry) => entry.id === agentId);
  return agent?.runtimeMode === 'sandbox' && agent?.sandboxUrl ? 'remote' : 'local';
}
