/**
 * Optional PostHog MCP credentials for agent runners.
 *
 * Uses a personal API key with the "MCP Server" preset (see PostHog MCP FAQ). OAuth is not
 * available inside headless runner containers.
 */

function readOnlyString(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback ? 'true' : 'false';
  if (value === false || value === 0) return 'false';
  const s = String(value).toLowerCase();
  if (s === 'false' || s === '0' || s === 'no') return 'false';
  return 'true';
}

/**
 * @returns {Record<string, string>} entries for secrets.env (empty when PostHog is not configured)
 */
export function resolvePosthogRunnerEnv({ project, secrets, env = process.env }) {
  const apiKey = secrets.POSTHOG_MCP_API_KEY;
  if (!apiKey) return {};

  const block = project?.posthog || {};
  const out = { POSTHOG_MCP_API_KEY: apiKey };

  const projectId = block.project_id ?? env.POSTHOG_PROJECT_ID;
  if (projectId) out.POSTHOG_PROJECT_ID = String(projectId);

  const orgId = block.organization_id ?? env.POSTHOG_ORGANIZATION_ID;
  if (orgId) out.POSTHOG_ORGANIZATION_ID = String(orgId);

  const readOnly =
    block.read_only !== undefined && block.read_only !== null
      ? block.read_only
      : env.POSTHOG_MCP_READ_ONLY;
  out.POSTHOG_MCP_READ_ONLY = readOnlyString(readOnly, true);

  return out;
}
