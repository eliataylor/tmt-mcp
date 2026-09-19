import { sanitizeText } from './taskdir.mjs';

/**
 * Preview deployment URLs, read from GitHub rather than from the host that built them.
 *
 * Vercel's Git integration reports every deployment through GitHub's Deployments API and puts the
 * preview URL in the status's `environment_url`. Reading it there costs no new credential — the
 * orchestrator already holds a token with repo scope — and avoids the two brittle alternatives:
 * a Vercel API key plus per-project ids in config, or reconstructing
 * `<project>-git-<branch>-<scope>.vercel.app` by hand and hoping the slug and 63-character
 * truncation rules match. It also works unchanged for any other provider that reports deployments
 * the same way.
 */

/** GitHub deployment status states that mean the build has not finished yet. */
const PENDING_STATES = new Set(['pending', 'queued', 'in_progress']);

const STATE_LABEL = {
  success: 'ready',
  in_progress: 'building',
  queued: 'queued',
  pending: 'queued',
  failure: 'failed',
  error: 'errored',
  inactive: 'superseded',
};

export function isSettled(state) {
  return Boolean(state) && !PENDING_STATES.has(state);
}

/**
 * Only http(s) links reach a comment body. `environment_url` is set by a third-party integration,
 * and GitHub autolinks bare URLs, so a `javascript:` value would otherwise become a clickable link.
 */
export function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function newestFirst(statuses) {
  // GitHub already returns statuses newest first; sorting makes that explicit without relying on
  // it. Array#sort is stable, so statuses sharing a timestamp keep the order GitHub sent.
  return [...statuses].sort((a, b) => {
    const left = Date.parse(b?.created_at) || 0;
    const right = Date.parse(a?.created_at) || 0;
    return left - right;
  });
}

/**
 * Collapse a deployment's status history into the one state and URL worth reporting.
 *
 * State comes from the newest status, but the URL comes from the newest status that carries one:
 * a `failure` status often has no `environment_url` even though an earlier `in_progress` did, and
 * the branch URL is still the right link to hand a human in that case.
 */
export function selectPreviewStatus(statuses = []) {
  const ordered = newestFirst(statuses);
  if (!ordered.length) return null;
  return {
    state: ordered[0]?.state || null,
    url: safeHttpUrl(ordered.find((s) => safeHttpUrl(s?.environment_url))?.environment_url),
    logUrl: safeHttpUrl(ordered.find((s) => safeHttpUrl(s?.log_url))?.log_url),
  };
}

export function summarizeDeployment(deployment, statuses) {
  const picked = selectPreviewStatus(statuses);
  return {
    id: deployment?.id ?? null,
    environment: sanitizeText(deployment?.environment || 'preview', 80),
    state: picked?.state || null,
    url: picked?.url || null,
    logUrl: picked?.logUrl || null,
  };
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll GitHub for the deployments triggered by one commit until they settle.
 *
 * Two separate waits, because "no deployment yet" and "deployment still building" want very
 * different patience. A repo with no hosting attached never produces a deployment at all, so it
 * gives up after `graceMs` instead of holding the task lease for the full timeout. Once a
 * deployment exists, it is worth waiting `timeoutMs` for a state the comment can be honest about.
 */
export async function awaitPreviews({
  gh,
  owner,
  repo,
  sha,
  graceMs = 45000,
  timeoutMs = 180000,
  intervalMs = 5000,
  now = () => Date.now(),
  sleep = sleepMs,
}) {
  const startedAt = now();
  let previews = [];

  for (;;) {
    const deployments = await gh.listDeployments({ owner, repo, sha });

    if (deployments.length) {
      previews = await Promise.all(
        deployments.map(async (deployment) =>
          summarizeDeployment(
            deployment,
            await gh.listDeploymentStatuses({ owner, repo, deploymentId: deployment.id })
          )
        )
      );
      if (previews.every((preview) => isSettled(preview.state))) return previews;
    } else if (now() - startedAt >= graceMs) {
      return [];
    }

    if (now() - startedAt >= timeoutMs) return previews;
    await sleep(intervalMs);
  }
}

/** Returns null when there is nothing worth saying, so the caller can skip the comment entirely. */
export function renderPreviewComment({ previews, branch, sha }) {
  const found = (previews || []).filter((preview) => preview.state || preview.url);
  if (!found.length) return null;

  const lines = found.map((preview) => {
    const state = STATE_LABEL[preview.state] || preview.state || 'unknown state';
    const target = preview.url || '_no URL reported_';
    const log = preview.logUrl ? ` ([build log](${preview.logUrl}))` : '';
    return `- **${preview.environment}** — ${state}: ${target}${log}`;
  });

  return [
    `Deployed \`${branch}\`${sha ? ` at \`${sha.slice(0, 7)}\`` : ''}:`,
    '',
    ...lines,
    '',
    'Branch URLs follow the branch, so these keep pointing at the newest push.',
  ].join('\n');
}
