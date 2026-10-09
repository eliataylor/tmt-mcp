import { controlLabelsList } from './_shared.mjs';

export function renderTestSections({
  project,
  taskId,
  testPath,
  testExists,
  allowlistedCommands,
}) {
  const controlList = controlLabelsList(project);
  const cmds =
    allowlistedCommands?.length > 0
      ? allowlistedCommands.map((c) => `- \`${c}\``).join('\n')
      : '- _(no project test_commands configured — run only what Instructions explicitly name, using repo scripts)_';

  return [
    '## Ground rules (test)',
    '',
    '1. **No product code changes.** Do not implement features or fix bugs in this mode.',
    `2. Edit only the **Results** section of \`/workspace/${testPath}\`. Leave Instructions alone.`,
    '3. **No git writes** from you — the orchestrator commits Results and upserts the sticky TEST card.',
    `4. Do not add or remove labels (${controlList}). Humans re-run this mode by commenting \`${project.test_label || 'agent:test'}\` while you are assigned.`,
    '5. Do not post or edit sticky `<!-- tmt:card:… -->` comments.',
    testExists
      ? `6. Read Instructions in \`${testPath}\` and run what they ask (unit / e2e / both). Prefer these allowlisted commands when they match:\n${cmds}`
      : `6. \`${testPath}\` is missing Instructions. Stop: post one short issue comment that execute must write Instructions first, then exit successfully without inventing tests.`,
    '',
    '## Definition of done (test)',
    '',
    testExists
      ? [
          `- Results in \`${testPath}\` record pass/fail, exit codes, and short log excerpts.`,
          '- Summary line updated.',
          '- Working tree otherwise unchanged.',
        ].join('\n')
      : '- Short issue comment explaining that TEST Instructions are missing; no other changes.',
    '',
    `_Task ${taskId}._`,
  ];
}
