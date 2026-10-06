import { sanitizeText } from './taskdir.mjs';

/**
 * Preview deployment URLs, read from GitHub rather than from the host that built them.
 *
 * Vercel's Git integration reports every deployment through GitHub's Deployments API and puts a
 * preview URL in the status's `environment_url`. That value is the deployment's own host
 * (`<project>-<id>-<scope>.vercel.app`), which changes on every push. The comment wants the branch
 * alias (`<project>-git-<branch>-<scope>.vercel.app`), which keeps pointing at the newest push.
 * Project and scope still come from the host GitHub reported, so this needs no Vercel API key and
 * no project ids in config. Any other provider's URL is left as reported.
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
 * that deployment host is still the right one to turn into a branch alias.
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

/**
 * Vercel deployment hosts look like `demo-4z8ywkqd0-match-bear.vercel.app`: project, a 9-character
 * deployment id that contains a digit, then the team scope. The branch alias swaps that id for
 * `git-<branch>`, with `/` and other non-alphanumerics in the branch becoming hyphens. The
 * subdomain is capped at 63 characters by shortening the branch slug and keeping project and scope.
 * A host that is not that shape (already an alias, another provider, a custom domain) is returned
 * unchanged.
 */
export function branchPreviewUrl(deploymentUrl, branch) {
  let url;
  try {
    url = new URL(String(deploymentUrl));
  } catch {
    return deploymentUrl;
  }
  if (!url.hostname.endsWith('.vercel.app')) return deploymentUrl;

  const label = url.hostname.slice(0, -'.vercel.app'.length);
  const parts = label.split('-');
  const hashIndexes = [];
  for (let i = 1; i < parts.length; i += 1) {
    if (/^(?=.*\d)[a-z0-9]{9}$/.test(parts[i])) hashIndexes.push(i);
  }
  if (hashIndexes.length !== 1) return url.toString();

  const hashAt = hashIndexes[0];
  const project = parts.slice(0, hashAt).join('-');
  const team = parts.slice(hashAt + 1).join('-');
  const slug = String(branch || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!project || !slug) return url.toString();

  const head = `${project}-git-`;
  const tail = team ? `-${team}` : '';
  const budget = 63 - head.length - tail.length;
  if (budget < 1) return url.toString();
  const trimmed = slug.slice(0, budget).replace(/-+$/g, '');
  if (!trimmed) return url.toString();

  url.hostname = `${head}${trimmed}${tail}.vercel.app`;
  return url.toString();
}

/** Returns null when there is nothing worth saying, so the caller can skip the comment entirely. */
export function renderPreviewComment({ previews, branch, sha }) {
  const found = (previews || []).filter((preview) => preview.state || preview.url);
  if (!found.length) return null;

  const lines = found.map((preview) => {
    const state = STATE_LABEL[preview.state] || preview.state || 'unknown state';
    const target = preview.url ? branchPreviewUrl(preview.url, branch) : '_no URL reported_';
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
