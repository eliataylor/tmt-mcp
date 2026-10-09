import { artifactFileRules, controlLabelsList } from './_shared.mjs';

export function renderMonitorSections({ project, taskId, artifactPath, executeLabel }) {
  const controlList = controlLabelsList(project);

  return [
    '## Ground rules (monitor / ROI)',
    '',
    ...artifactFileRules({ artifactPath, executeLabel, controlList }),
    '8. Prefer production analytics over the Neon task branch for post-ship evidence.',
    '9. Read present Stage folder siblings (RESEARCH.md, PLAN.md, UX.md) when comparing outcomes; do not edit them.',
    '',
    '## The monitor file',
    '',
    `Edit only \`/workspace/${artifactPath}\`. Compare shipped outcomes to the hypothesis.`,
    'Cite RESEARCH.md and PLAN.md under the same issue folder when they exist.',
    '',
    '## Definition of done (monitor)',
    '',
    `- \`${artifactPath}\` has metrics vs bet and a ship/iterate/revert recommendation, with the summary line filled in.`,
    '- Nothing else in the working tree changed, and you made no commits.',
    '',
    `_Task ${taskId}._`,
  ];
}
