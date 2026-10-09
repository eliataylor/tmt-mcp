import { controlLabelsList } from './_shared.mjs';

export function renderExecuteSections({
  project,
  taskId,
  branch,
  prNumber,
  planPath,
  planExists,
  testPath,
}) {
  const controlList = controlLabelsList(project);

  return [
    '## Ground rules (execute)',
    '',
    planExists
      ? `1. Follow the plan in \`${planPath}\` on this branch, plus any later human corrections in the issue thread. That file is the source of truth. Do not rewrite PLAN.md to match what you built; say where you deviated in your PR summary.`
      : '1. No PLAN.md is on this branch yet. Follow what the thread agreed on. Prefer asking a human to run System Design (`agent:sdd`) if the change is large; for a small fix, proceed carefully.',
    '2. **Consult present Stage folder siblings.** When `UX.md` or `wireframes/*.drawio` exist, open them for UI-facing work and match the visual contract. RESEARCH.md is optional evidence. Do not edit RESEARCH.md, UX.md, PLAN.md, MONITOR.md, or `.drawio` files.',
    `3. Work only on \`${branch}\`. Never commit to or force-push \`${project.default_branch}\`.`,
    '4. Never rewrite published history. No amending or rebasing commits that are already pushed.',
    '5. Never commit `.env.local` or any secret. It is gitignored — leave it that way.',
    '6. Stay inside `/workspace`. Do not try to reach the host or other containers.',
    '7. If the thread changed materially since the plan — a new blocker, a revised approach — post a brief issue comment before your first edit. Otherwise proceed.',
    `8. Do not add or remove labels (${controlList}). A human wakes the next stage with a backticked control token in a comment while you are assigned.`,
    `9. Commit in logical steps and push to \`origin ${branch}\` when done.`,
    prNumber
      ? `10. Summarize what you changed as a comment on PR #${prNumber} when finished.`
      : '10. Open a pull request against the base branch when finished.',
    `11. Write or update **only the Instructions section** of \`${testPath}\` with concrete commands and checks for \`${project.test_label || 'agent:test'}\`. Do not fill Results.`,
    '12. Do not post or edit sticky `<!-- tmt:card:… -->` comments; the orchestrator upserts them.',
    '',
    '## Definition of done (execute)',
    '',
    '- The issue is addressed, or you have posted a comment explaining precisely what blocked you.',
    `- Your work is committed and pushed to \`${branch}\`.`,
    `- \`${testPath}\` Instructions list how to verify (unit/e2e/manual).`,
    '- Existing checks and lint pass, or you have said why they cannot.',
    '',
    `_Task ${taskId}._`,
  ];
}
