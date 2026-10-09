export const DAY_MS = 24 * 60 * 60 * 1000;

export function ageInDays(timestamp, now) {
  const then = Date.parse(timestamp ?? '');
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now - then) / DAY_MS));
}

export function describeAge(days) {
  if (days === null) return null;
  if (days === 0) return 'today';
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

export function fence(label, text) {
  return `<<<${label}\n${text}\n${label}>>>`;
}

export function controlLabels(project) {
  return [
    project.trigger_label || 'agent:sdd',
    project.execute_label || 'agent:execute',
    project.triage_label || 'agent:triage',
    project.research_label || 'agent:research',
    project.wireframe_label || 'agent:wireframe',
    project.monitor_label || 'agent:monitor',
    project.test_label || 'agent:test',
  ];
}

export function controlLabelsList(project) {
  return controlLabels(project)
    .map((l) => `\`${l}\``)
    .join(', ');
}

function branchHasParentRows(initSource) {
  return initSource !== 'parent-schema' && initSource !== 'schema-only';
}

export function renderDatabaseSection(neon, { execute, now }) {
  const forkedAt = neon.createdAt;
  const age = describeAge(ageInDays(forkedAt, now));
  const origin = `forked from \`${neon.parentBranch || 'the parent branch'}\`${
    forkedAt ? ` at ${forkedAt}${age ? ` (${age})` : ''}` : ''
  }`;

  return [
    '## Your database',
    '',
    `- \`/workspace/.env.local\` holds \`DATABASE_URL\` (pooled) and \`DATABASE_URL_UNPOOLED\` (direct). The file is gitignored; leave it that way.`,
    '- **Neither is exported into your shell.** `echo $DATABASE_URL` is empty by design — read the file, or use whatever this repo already uses to load it.',
    `- It points at the Neon branch \`${neon.name}\`, yours alone, ${origin}. Writes land only there, and it is deleted when the pull request closes.`,
    branchHasParentRows(neon.initSource)
      ? `- The fork carried the parent's rows, so you can query real data. It is a snapshot, not a live replica: a count answers "as of ${forkedAt || 'the fork'}", never "right now". Quote the as-of time with any number you report.`
      : '- The fork carried **schema only, no rows**. Every table is empty. Do not read a count here as evidence about production data.',
    execute
      ? '- Read as much as you need. Write only what the task actually calls for — a migration, a seed row — and never point tooling at a connection string this file did not give you.'
      : '- Read as much as you need; this mode writes nothing. Run queries, not migrations, and never point tooling at a connection string this file did not give you.',
    '',
  ];
}

/** Shared rules for modes that edit exactly one stage markdown file. */
export function artifactFileRules({ artifactPath, executeLabel, controlList }) {
  return [
    `1. **No product code changes** — the only file you may edit is \`/workspace/${artifactPath}\`. Do not install dependencies beyond what reading the tree needs.`,
    '2. **No git writes** — do not commit, push, or open a PR. When you exit, the orchestrator commits this file as its own revision, upserts the sticky issue card, and links that version. Edits anywhere else are reverted.',
    '3. Stay inside `/workspace` for read-only exploration (search, read files, `git log`, `git diff`).',
    `4. Do not add or remove GitHub labels yourself. Never touch control labels (${controlList}). Humans wake execute by commenting \`${executeLabel}\` while you are assigned.`,
    '5. Do **not** post or edit the sticky issue card (`<!-- tmt:card:… -->`). The orchestrator mirrors this file into that comment.',
    '6. Fill in the `<!-- summary: ... -->` line with one sentence on what this revision says or changed.',
    '7. Put numbered human asks under `## Needs from you` (or write "None").',
  ];
}
