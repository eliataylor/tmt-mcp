import { controlLabelsList } from './_shared.mjs';

/**
 * Wireframe mode writes UX.md plus uncompressed draw.io wireframes under wireframes/.
 * Not the single-file artifactFileRules — companion .drawio files are part of the deliverable.
 */
export function renderWireframeSections({ project, taskId, artifactPath, executeLabel }) {
  const controlList = controlLabelsList(project);
  const issueDir = artifactPath.replace(/\/[^/]+$/, '');
  const wireDir = `${issueDir}/wireframes`;

  return [
    '## Ground rules (wireframes)',
    '',
    `1. **No product code changes** — edit only \`/workspace/${artifactPath}\` and files under \`/workspace/${wireDir}/\` (uncompressed \`.drawio\` only). Do not install dependencies beyond what reading the tree needs.`,
    '2. **No git writes** — do not commit, push, or open a PR. When you exit, the orchestrator commits the index and wireframes, upserts the sticky issue card, and links that version. Edits anywhere else are reverted.',
    '3. Stay inside `/workspace` for read-only exploration (search, read files, `git log`, `git diff`).',
    `4. Do not add or remove GitHub labels yourself. Never touch control labels (${controlList}). Humans wake execute by commenting \`${executeLabel}\` while you are assigned.`,
    '5. Do **not** post or edit the sticky issue card (`<!-- tmt:card:… -->`). The orchestrator mirrors the index into that comment.',
    '6. Fill in the `<!-- summary: ... -->` line with one sentence on what this revision says or changed.',
    '7. Put numbered human asks under `## Needs from you` (or write "None").',
    '8. Reference visuals already attached on the issue by URL or description. Do not invent PNG/JPEG/binary mockups — wireframes are draw.io XML only.',
    '9. Read present siblings in the Stage folder (especially RESEARCH.md and PLAN.md) before drawing; align screens to known constraints. Do not edit those files.',
    '',
    '## Wireframe format (draw.io)',
    '',
    `Write one uncompressed \`.drawio\` file per primary screen or flow under \`${wireDir}/\` (e.g. \`home.drawio\`, \`match-card.drawio\`).`,
    'Use `<mxfile compressed="false">` with a full nested `<mxGraphModel>` (not deflate-compressed diagram text).',
    'Minimal valid skeleton:',
    '',
    '```xml',
    '<mxfile compressed="false">',
    '  <diagram id="page-1" name="Page-1">',
    '    <mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1"',
    '                  tooltips="1" connect="1" arrows="1" fold="1"',
    '                  page="1" pageScale="1" pageWidth="850" pageHeight="1100"',
    '                  math="0" shadow="0">',
    '      <root>',
    '        <mxCell id="0" />',
    '        <mxCell id="1" parent="0" />',
    '        <!-- vertices: vertex="1" parent="1"; edges: edge="1" parent="1" -->',
    '      </root>',
    '    </mxGraphModel>',
    '  </diagram>',
    '</mxfile>',
    '```',
    '',
    'Low-fidelity only: rectangles, labels, nav chrome, primary CTAs, empty/loading/error callouts. Not polished visual design. Prefer simple `rounded=1;whiteSpace=wrap;html=1;` styles.',
    '',
    '## The index file',
    '',
    `Edit \`/workspace/${artifactPath}\`. List each wireframe with its relative path and a one-line purpose. Cover primary screens and key states.`,
    'Do not paste full draw.io XML into the markdown — paths and short notes only.',
    '',
    '## Definition of done (wireframes)',
    '',
    `- \`${artifactPath}\` indexes the wireframes, with the summary line filled in.`,
    `- At least one uncompressed \`.drawio\` exists under \`${wireDir}/\`.`,
    '- Nothing outside those paths changed, and you made no commits.',
    '',
    `_Task ${taskId}._`,
  ];
}
