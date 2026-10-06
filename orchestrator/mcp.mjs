/**
 * GitHub MCP environment for one task mode.
 *
 * Toolsets are the server's own groups (github-mcp-server). Lockdown mode is always on.
 * Execute may write repository contents and pull requests; it does not get the actions toolset,
 * which is where workflow secrets live, or org admin. Plan is read-only. Triage gets issues
 * only, so it can label and comment without a contents-write tool.
 */
export function githubMcpEnv(action) {
  const lockdown = { GITHUB_LOCKDOWN_MODE: '1' };
  if (action === 'agent:triage') {
    return { ...lockdown, GITHUB_TOOLSETS: 'issues' };
  }
  if (action === 'agent:execute') {
    return { ...lockdown, GITHUB_TOOLSETS: 'repos,issues,pull_requests' };
  }
  return {
    ...lockdown,
    GITHUB_READ_ONLY: '1',
    GITHUB_TOOLSETS: 'repos,issues,pull_requests',
  };
}
