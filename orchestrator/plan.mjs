import { ACTIONS } from '../src/triggers.mjs';

/** Actions whose deliverable is a revision of the plan file. */
export function isPlanAction(action) {
  return action === ACTIONS.ASSIGNED || action === ACTIONS.OPENED || action === ACTIONS.COMMENT;
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** A link to one version of the file. A branch link would drift, and old comments would lie. */
export function planPermalink({ owner, repo, sha, planPath }) {
  return `https://github.com/${owner}/${repo}/blob/${sha}/${encodePath(planPath)}`;
}

export function planBranchLink({ owner, repo, branch, planPath }) {
  return `https://github.com/${owner}/${repo}/blob/${encodePath(branch)}/${encodePath(planPath)}`;
}

export function compareLink({ owner, repo, fromSha, toSha }) {
  return `https://github.com/${owner}/${repo}/compare/${fromSha}...${toSha}`;
}

const SUMMARY_MAX = 280;

/** The agent's one-line summary from `<!-- summary: ... -->`, or null when it left it empty. */
export function extractPlanSummary(text) {
  const match = /<!--\s*summary:([\s\S]*?)-->/i.exec(text || '');
  if (!match) return null;
  const summary = match[1].replace(/\s+/g, ' ').trim();
  if (!summary) return null;
  return summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1)}…` : summary;
}

/**
 * The issue comment for one plan run. Deliberately short: the plan is in the file, and the thread
 * only needs to say that a revision exists, where it is, and what changed since the last one.
 */
export function renderPlanComment({
  owner,
  repo,
  planPath,
  changed,
  sha,
  prevSha,
  revision,
  summary,
  warnings = [],
}) {
  if (!sha) return null;
  const permalink = planPermalink({ owner, repo, sha, planPath });
  const lines = [];

  if (changed) {
    lines.push(`**Plan revision ${revision}:** [\`${planPath}\`](${permalink}) @ \`${sha.slice(0, 7)}\``);
    if (prevSha && prevSha !== sha) {
      lines.push(`**Changes:** [${prevSha.slice(0, 7)}...${sha.slice(0, 7)}](${compareLink({ owner, repo, fromSha: prevSha, toSha: sha })})`);
    }
  } else {
    lines.push(`**Plan unchanged:** reviewed and left as is. Current version: [\`${planPath}\`](${permalink}) @ \`${sha.slice(0, 7)}\``);
  }

  if (summary) lines.push('', `> ${summary}`);
  if (warnings.length) {
    lines.push('', ...warnings.map((w) => `_Note: ${w}._`));
  }
  return lines.join('\n');
}
