import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ACTIONS, configuredControlLabels } from '../src/triggers.mjs';
import { normalizePlanFolder } from '../src/projects.mjs';

/** Stage artifact kinds written under `.agent/plans/{n}/`. */
export const ARTIFACT_KINDS = {
  RESEARCH: 'RESEARCH',
  UX: 'UX',
  PLAN: 'PLAN',
  TEST: 'TEST',
  MONITOR: 'MONITOR',
};

/** Markdown stage files listed in the prompt Stage folder inventory (order fixed). */
export const STAGE_INVENTORY_KINDS = [
  ARTIFACT_KINDS.RESEARCH,
  ARTIFACT_KINDS.UX,
  ARTIFACT_KINDS.PLAN,
  ARTIFACT_KINDS.TEST,
  ARTIFACT_KINDS.MONITOR,
];

/** Sticky usage card when a mention cannot resolve an Action. */
export const MENTION_HELP_MARKER = '<!-- tmt:mention-help -->';

const CARD_BODY_MAX = 50 * 1024;

const KIND_TITLES = {
  RESEARCH: 'Research',
  UX: 'Wireframes',
  PLAN: 'System design',
  TEST: 'Test',
  MONITOR: 'Monitor / ROI',
};

/** Queue actions whose deliverable is a revision of a stage markdown file (not product code). */
export function isArtifactAction(action) {
  return (
    action === ACTIONS.SDD ||
    action === ACTIONS.OPENED ||
    action === ACTIONS.COMMENT ||
    action === ACTIONS.RESEARCH ||
    action === ACTIONS.GRAPHIC ||
    action === ACTIONS.MONITOR
  );
}

export function isTriageAction(action) {
  return action === ACTIONS.TRIAGE;
}

export function isMentionHelpAction(action) {
  return action === ACTIONS.MENTION_HELP;
}

export function isExecuteAction(action) {
  return action === ACTIONS.EXECUTE;
}

export function isTestAction(action) {
  return action === ACTIONS.TEST;
}

/** Modes that need a task branch + draft PR (everything except triage / mention help). */
export function needsTaskBranch(action) {
  return !isTriageAction(action) && !isMentionHelpAction(action);
}

/**
 * Sticky comment explaining how to wake the agent with a mention.
 * @param {{ project: object }} opts
 */
export function renderMentionHelpComment({ project }) {
  const mention = project.mention || (project.agent_login ? `@${project.agent_login}` : '@agent');
  const labels = configuredControlLabels(project);
  const labelList = labels.map((name) => `\`${name}\``).join(', ');
  const example = labels[0] || 'agent:sdd';
  return [
    MENTION_HELP_MARKER,
    '',
    'To wake me with a mention, include a control label in the same comment (or put that label on the issue):',
    '',
    '```',
    `${mention} ${example} …`,
    '```',
    '',
    `Configured labels: ${labelList || '_(none configured)_'}.`,
    '',
    'Preference: label string in the mentioning text → control label already on the issue → this help.',
  ].join('\n');
}

/** Modes that commit only their stage file after the run (orchestrator-owned). */
export function commitsArtifactOnly(action) {
  return isArtifactAction(action) || isTestAction(action);
}

export function artifactKindForAction(action) {
  switch (action) {
    case ACTIONS.RESEARCH:
      return ARTIFACT_KINDS.RESEARCH;
    case ACTIONS.GRAPHIC:
      return ARTIFACT_KINDS.UX;
    case ACTIONS.SDD:
    case ACTIONS.OPENED:
    case ACTIONS.COMMENT:
      return ARTIFACT_KINDS.PLAN;
    case ACTIONS.MONITOR:
      return ARTIFACT_KINDS.MONITOR;
    case ACTIONS.TEST:
    case ACTIONS.EXECUTE:
      return ARTIFACT_KINDS.TEST;
    default:
      return null;
  }
}

export function artifactFileName(kind) {
  return `${kind}.md`;
}

/** `.agent/plans/{n}` relative to the repo root. */
export function resolveIssueArtifactDir(project, issueNumber) {
  const n = Number(issueNumber);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`issue number must be a positive integer, got "${issueNumber}"`);
  }
  return `${normalizePlanFolder(project?.plan_folder)}/${n}`;
}

/** Primary write path for an action, e.g. `.agent/plans/42/PLAN.md`. */
export function resolveArtifactRelativePath(project, issueNumber, kind) {
  if (!kind) throw new Error('artifact kind is required');
  return `${resolveIssueArtifactDir(project, issueNumber)}/${artifactFileName(kind)}`;
}

/** PLAN.md path — execute SoT. */
export function resolvePlanRelativePath(project, issueNumber) {
  return resolveArtifactRelativePath(project, issueNumber, ARTIFACT_KINDS.PLAN);
}

export function resolveTestRelativePath(project, issueNumber) {
  return resolveArtifactRelativePath(project, issueNumber, ARTIFACT_KINDS.TEST);
}

/** `.agent/plans/{n}/wireframes` relative to the repo root. */
export function resolveWireframesDir(project, issueNumber) {
  return `${resolveIssueArtifactDir(project, issueNumber)}/wireframes`;
}

/**
 * Inventory of stage markdown + draw.io wireframes under `.agent/plans/{n}/`.
 * Orchestrator-built for the agent prompt — zero model discovery.
 *
 * @returns {{ dir: string, files: { path: string, present: boolean }[], wireframes: string[] }}
 */
export function listStageFolderInventory({ clonePath, project, issueNumber }) {
  const dir = resolveIssueArtifactDir(project, issueNumber);
  const files = STAGE_INVENTORY_KINDS.map((kind) => {
    const path = resolveArtifactRelativePath(project, issueNumber, kind);
    return {
      path,
      present: Boolean(clonePath) && existsSync(join(clonePath, path)),
    };
  });
  const wireframes = listWireframePaths({ clonePath, project, issueNumber });
  return { dir, files, wireframes };
}

/** Relative paths of `*.drawio` under the issue wireframes folder (sorted). */
export function listWireframePaths({ clonePath, project, issueNumber }) {
  if (!clonePath) return [];
  const wireDir = resolveWireframesDir(project, issueNumber);
  const abs = join(clonePath, wireDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((name) => name.endsWith('.drawio') && !name.startsWith('.'))
    .sort()
    .map((name) => `${wireDir}/${name}`);
}

/**
 * Paths graphic mode may keep when committing a revision: UX.md plus every `.drawio`
 * currently on disk under wireframes/.
 */
export function listGraphicAllowedPaths({ clonePath, project, issueNumber }) {
  const uxPath = resolveArtifactRelativePath(project, issueNumber, ARTIFACT_KINDS.UX);
  return [uxPath, ...listWireframePaths({ clonePath, project, issueNumber })];
}

/** Markdown lines for the shared Stage folder prompt section. */
export function renderStageFolderSection(inventory) {
  if (!inventory?.dir) return [];
  const lines = [
    '## Stage folder',
    '',
    `Issue stage files live under \`${inventory.dir}/\`. Read present siblings before writing your deliverable. Edit only what your mode allows.`,
    '',
  ];
  for (const f of inventory.files || []) {
    lines.push(f.present ? `- \`${f.path}\`` : `- \`${f.path}\` — missing`);
  }
  const drawios = inventory.wireframes || [];
  if (drawios.length) {
    lines.push('', 'Wireframes (draw.io):');
    for (const path of drawios) lines.push(`- \`${path}\``);
  } else {
    lines.push('', `- \`${inventory.dir}/wireframes/*.drawio\` — none yet`);
  }
  lines.push('');
  return lines;
}

export function cardMarker(kind) {
  return `<!-- tmt:card:${kind} -->`;
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function artifactPermalink({ owner, repo, sha, path }) {
  return `https://github.com/${owner}/${repo}/blob/${sha}/${encodePath(path)}`;
}

export function artifactBranchLink({ owner, repo, branch, path }) {
  return `https://github.com/${owner}/${repo}/blob/${encodePath(branch)}/${encodePath(path)}`;
}

export function compareLink({ owner, repo, fromSha, toSha }) {
  return `https://github.com/${owner}/${repo}/compare/${fromSha}...${toSha}`;
}

const SUMMARY_MAX = 280;

/** One-line summary from `<!-- summary: ... -->`. */
export function extractSummary(text) {
  const match = /<!--\s*summary:([\s\S]*?)-->/i.exec(text || '');
  if (!match) return null;
  const summary = match[1].replace(/\s+/g, ' ').trim();
  if (!summary) return null;
  return summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1)}…` : summary;
}

/** @deprecated Use extractSummary. */
export function extractPlanSummary(text) {
  return extractSummary(text);
}

/**
 * Numbered asks under `## Needs from you` (or Open questions as fallback for PLAN).
 * Returns markdown lines without the heading, or null.
 */
export function extractNeedsFromYou(text) {
  if (!text) return null;
  const match =
    /^##\s*Needs from you\s*\n([\s\S]*?)(?=^##\s|\Z)/im.exec(text) ||
    /^##\s*Open questions\s*\n([\s\S]*?)(?=^##\s|\Z)/im.exec(text);
  if (!match) return null;
  const block = match[1].trim();
  if (!block || /^none\b/i.test(block)) return null;
  const lines = block
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => /^\d+[.)]\s+\S/.test(l.trim()) || /^[-*]\s+\S/.test(l.trim()));
  if (!lines.length) return null;
  return lines.slice(0, 12).join('\n');
}

/**
 * Sticky issue card: visible summary + asks; full file in a collapsed <details> block.
 * Orchestrator-built — zero model tokens.
 */
export function renderArtifactCard({
  kind,
  owner,
  repo,
  artifactPath,
  changed,
  sha,
  prevSha,
  revision,
  summary,
  needs,
  bodyMarkdown,
  prNumber = null,
  prUrl = null,
  testStatus = null,
  warnings = [],
  /** Relative paths of companion wireframe files to link (UX card). */
  wireframePaths = [],
}) {
  if (!sha) return null;
  const permalink = artifactPermalink({ owner, repo, sha, path: artifactPath });
  const title = KIND_TITLES[kind] || kind;
  const headerBits = [
    `### ${title}`,
    revision != null ? `Rev ${revision}` : null,
    `[\`${artifactPath.split('/').pop()}\` @ ${sha.slice(0, 7)}](${permalink})`,
  ].filter(Boolean);

  if (prevSha && prevSha !== sha && changed) {
    headerBits.push(
      `[diff](${compareLink({ owner, repo, fromSha: prevSha, toSha: sha })})`
    );
  }
  if (prNumber) {
    headerBits.push(prUrl ? `[PR #${prNumber}](${prUrl})` : `PR #${prNumber}`);
  }

  const lines = [cardMarker(kind), headerBits.join(' · ')];

  if (!changed && revision == null) {
    lines.push('', '_Unchanged since last run._');
  }

  if (testStatus) {
    lines.push('', `**Result:** ${testStatus}`);
  }

  if (summary) lines.push('', `> ${summary}`);

  if (kind === ARTIFACT_KINDS.UX && wireframePaths?.length) {
    lines.push('', '**Wireframes**');
    for (const path of wireframePaths) {
      const link = artifactPermalink({ owner, repo, sha, path });
      lines.push(`- [\`${path.split('/').pop()}\`](${link})`);
    }
  }

  if (needs) {
    lines.push('', '**Needs from you**', needs);
  }

  const includeBody =
    typeof bodyMarkdown === 'string' &&
    bodyMarkdown.length > 0 &&
    bodyMarkdown.length <= CARD_BODY_MAX;

  if (includeBody) {
    lines.push(
      '',
      '<details>',
      `<summary>Full ${artifactFileName(kind)} (click to expand)</summary>`,
      '',
      bodyMarkdown.trimEnd(),
      '',
      '</details>'
    );
  } else if (bodyMarkdown && bodyMarkdown.length > CARD_BODY_MAX) {
    lines.push('', `_Full file omitted (${Math.round(bodyMarkdown.length / 1024)}KB); open the permalink._`);
  }

  lines.push('', '_Reply in a normal comment (e.g. `1: …`). Edits land in the file on the next run._');

  if (warnings.length) {
    lines.push('', ...warnings.map((w) => `_Note: ${w}._`));
  }

  return lines.join('\n');
}

/** @deprecated Prefer renderArtifactCard. Short link-only comment kept for tests. */
export function renderPlanComment(opts) {
  return renderArtifactCard({
    kind: ARTIFACT_KINDS.PLAN,
    artifactPath: opts.planPath,
    bodyMarkdown: null,
    ...opts,
  });
}

export function planPermalink(opts) {
  return artifactPermalink({ ...opts, path: opts.planPath });
}

export function planBranchLink(opts) {
  return artifactBranchLink({ ...opts, path: opts.planPath });
}

/** True when a comment body is a tmt sticky card (skip from agent context). */
export function isTmtCardComment(body) {
  const text = body || '';
  return (
    /<!--\s*tmt:card:[A-Z]+\s*-->/i.test(text) || text.includes(MENTION_HELP_MARKER)
  );
}
