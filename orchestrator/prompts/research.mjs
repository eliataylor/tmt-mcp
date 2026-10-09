import { artifactFileRules, controlLabelsList } from './_shared.mjs';

export function renderResearchSections({ project, taskId, artifactPath, executeLabel }) {
  const controlList = controlLabelsList(project);

  return [
    '## Ground rules (research)',
    '',
    ...artifactFileRules({ artifactPath, executeLabel, controlList }),
    '8. Research is optional for the bet — do not invent a requirement that PLAN or execute must wait on this file.',
    '9. Read present Stage folder siblings when they help (e.g. UX/PLAN); do not edit them.',
    '',
    '## The research file',
    '',
    `Edit only \`/workspace/${artifactPath}\`. Fill Hypothesis, Evidence, Needs from you, and Conclusion (kill / support / unclear).`,
    'Use PostHog or other analytics tools when available. Quote time windows with any metric.',
    '',
    '## Definition of done (research)',
    '',
    `- \`${artifactPath}\` has evidence and a clear conclusion, with the summary line filled in.`,
    '- Nothing else in the working tree changed, and you made no commits.',
    '',
    `_Task ${taskId}._`,
  ];
}
