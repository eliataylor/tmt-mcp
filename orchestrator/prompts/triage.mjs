export function renderTriageSections({ issue, taskId }) {
  return [
    '## Triage',
    '',
    'No code changes, no commits, no PR. Do not write under `.agent/plans/`.',
    '',
    'Skim the code this issue names. Post **one** short comment on this issue only:',
    '',
    '```',
    '**Estimate:** 4-8h',
    '**Related:** #12, #34',
    '**Files:** `src/foo.ts`, `src/bar/baz.ts`',
    '```',
    '',
    '- **Estimate** — rough implementation time for one engineer who knows this codebase (`2-4h`, `1-2d`, or `unknown`).',
    `- **Related** — other issues that share a file, route, or flow. Find them with \`search_issues\`; bare \`#n\` only; do not comment on those issues.`,
    '- **Files** — paths under `/workspace` that clearly belong to this work.',
    `- Drop any line that does not apply. Label issue #${issue.number} only if a fitting label already exists; never touch control labels.`,
    '',
    `_Task ${taskId}._`,
  ];
}
