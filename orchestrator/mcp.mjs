import { ACTIONS } from '../src/triggers.mjs';

/**
 * GitHub MCP environment for one task mode.
 *
 * Toolsets are the server's own groups (github-mcp-server). Lockdown mode is always on.
 * Execute may write repository contents and pull requests; it does not get the actions toolset.
 * Stage artifact modes and test are read-only on GitHub (orchestrator owns sticky cards).
 * Triage gets issues only, so it can label and comment without a contents-write tool.
 */
export function githubMcpEnv(action) {
  const lockdown = { GITHUB_LOCKDOWN_MODE: '1' };
  if (action === ACTIONS.TRIAGE) {
    return { ...lockdown, GITHUB_TOOLSETS: 'issues' };
  }
  if (action === ACTIONS.EXECUTE) {
    return { ...lockdown, GITHUB_TOOLSETS: 'repos,issues,pull_requests' };
  }
  // research, wireframe, sdd, monitor, test, opened, comment — read GitHub; write files locally
  return {
    ...lockdown,
    GITHUB_READ_ONLY: '1',
    GITHUB_TOOLSETS: 'repos,issues,pull_requests',
  };
}
