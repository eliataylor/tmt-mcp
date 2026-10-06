const MIN_SECRET_LENGTH = 12;

/**
 * Names of values that must not show up in anything the orchestrator commits or posts.
 * The canary is planted in the prompt so a model that echoes its instructions is caught here.
 */
export function leakNeedles({ secrets = {}, canary = null } = {}) {
  return {
    canary,
    GITHUB_TOKEN: secrets.GITHUB_TOKEN,
    CURSOR_API_KEY: secrets.CURSOR_API_KEY,
    POSTHOG_MCP_API_KEY: secrets.POSTHOG_MCP_API_KEY,
  };
}

/** Which needle names occur in `text`. Values shorter than a real token are ignored. */
export function leakHits(text, needles) {
  const body = String(text ?? '');
  const hits = [];
  for (const [name, value] of Object.entries(needles || {})) {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) continue;
    if (body.includes(value)) hits.push(name);
  }
  return hits;
}

export function assertNoLeak(text, needles) {
  const hits = leakHits(text, needles);
  if (!hits.length) return;
  throw new Error(`refusing to publish: content contains ${hits.join(', ')}`);
}
