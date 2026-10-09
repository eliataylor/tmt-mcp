import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ARTIFACT_KINDS,
  listWireframeAllowedPaths,
  listStageFolderInventory,
  listWireframePaths,
  renderArtifactCard,
  renderStageFolderSection,
} from '../orchestrator/artifacts.mjs';
import { buildPrompt } from '../orchestrator/prompt.mjs';
import { commitArtifactRevision, readHeadSha } from '../orchestrator/repo.mjs';
import { PROJECT } from './helpers.mjs';

const quiet = { log() {}, warn() {} };

const DRAWIO = `<mxfile compressed="false">
  <diagram id="page-1" name="Page-1">
    <mxGraphModel>
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;

function sh(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function makeClone() {
  const root = mkdtempSync(join(tmpdir(), 'wireframe-test-'));
  const remote = join(root, 'remote.git');
  const clone = join(root, 'clone');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', clone]);
  sh(clone, 'config', 'user.name', 'test');
  sh(clone, 'config', 'user.email', 'test@example.com');
  sh(clone, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(clone, '.gitignore'), '.env.local\n');
  writeFileSync(join(clone, 'app.js'), 'console.log(1);\n');
  sh(clone, 'add', '.');
  sh(clone, 'commit', '-q', '-m', 'init');
  sh(clone, 'remote', 'add', 'origin', remote);
  sh(clone, 'push', '-q', 'origin', 'main');
  sh(clone, 'switch', '-q', '-c', 'agent/issue-42');
  return { clone, remote };
}

const issueContext = {
  issue: {
    number: 42,
    title: 'Wireframe the match card',
    author: 'alice',
    labels: ['agent:wireframe'],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    url: 'https://github.com/my-org/primary-app/issues/42',
    body: { raw: 'Need wireframes.', task_list: [] },
  },
  repo: { full_name: 'my-org/primary-app', private: false },
  project: PROJECT,
  trigger_comment: null,
  references: { files: [], issues: [] },
  fetch: null,
};

describe('stage folder inventory', () => {
  test('lists present and missing siblings plus draw.io files', () => {
    const { clone } = makeClone();
    mkdirSync(join(clone, '.agent/plans/42/wireframes'), { recursive: true });
    writeFileSync(join(clone, '.agent/plans/42/UX.md'), '# Wireframes\n');
    writeFileSync(join(clone, '.agent/plans/42/wireframes/home.drawio'), DRAWIO);

    const inv = listStageFolderInventory({
      clonePath: clone,
      project: PROJECT,
      issueNumber: 42,
    });
    assert.equal(inv.dir, '.agent/plans/42');
    const ux = inv.files.find((f) => f.path.endsWith('UX.md'));
    const plan = inv.files.find((f) => f.path.endsWith('PLAN.md'));
    assert.equal(ux.present, true);
    assert.equal(plan.present, false);
    assert.deepEqual(inv.wireframes, ['.agent/plans/42/wireframes/home.drawio']);

    const section = renderStageFolderSection(inv).join('\n');
    assert.match(section, /## Stage folder/);
    assert.match(section, /Read present siblings/);
    assert.match(section, /`\.agent\/plans\/42\/UX\.md`/);
    assert.match(section, /PLAN\.md` — missing/);
    assert.match(section, /home\.drawio/);
  });

  test('listWireframeAllowedPaths includes UX.md and every .drawio', () => {
    const { clone } = makeClone();
    mkdirSync(join(clone, '.agent/plans/42/wireframes'), { recursive: true });
    writeFileSync(join(clone, '.agent/plans/42/UX.md'), '# Wireframes\n');
    writeFileSync(join(clone, '.agent/plans/42/wireframes/a.drawio'), DRAWIO);
    writeFileSync(join(clone, '.agent/plans/42/wireframes/b.drawio'), DRAWIO);
    writeFileSync(join(clone, '.agent/plans/42/wireframes/notes.txt'), 'ignore');

    assert.deepEqual(listWireframeAllowedPaths({ clonePath: clone, project: PROJECT, issueNumber: 42 }), [
      '.agent/plans/42/UX.md',
      '.agent/plans/42/wireframes/a.drawio',
      '.agent/plans/42/wireframes/b.drawio',
    ]);
  });
});

describe('wireframe / cross-mode prompts', () => {
  test('wireframe mode asks for uncompressed draw.io wireframes', () => {
    const inventory = listStageFolderInventory({
      clonePath: null,
      project: PROJECT,
      issueNumber: 42,
    });
    const prompt = buildPrompt({
      context: issueContext,
      branch: 'agent/issue-42',
      prNumber: 101,
      action: 'agent:wireframe',
      taskId: 't-wireframe',
      artifactPath: '.agent/plans/42/UX.md',
      artifactExists: true,
      stageInventory: inventory,
    });
    assert.match(prompt, /\*\*Wireframes\*\*/);
    assert.match(prompt, /Ground rules \(wireframes\)/);
    assert.match(prompt, /compressed="false"/);
    assert.match(prompt, /wireframes\//);
    assert.match(prompt, /## Stage folder/);
    assert.match(prompt, /Do not invent PNG/);
  });

  test('sdd must read UX/wireframes when present', () => {
    const prompt = buildPrompt({
      context: { ...issueContext, issue: { ...issueContext.issue, labels: ['agent:sdd'] } },
      branch: 'agent/issue-42',
      prNumber: 101,
      action: 'agent:sdd',
      taskId: 't-sdd',
      planPath: '.agent/plans/42/PLAN.md',
      planExists: true,
      stageInventory: {
        dir: '.agent/plans/42',
        files: [
          { path: '.agent/plans/42/RESEARCH.md', present: false },
          { path: '.agent/plans/42/UX.md', present: true },
          { path: '.agent/plans/42/PLAN.md', present: true },
          { path: '.agent/plans/42/TEST.md', present: false },
          { path: '.agent/plans/42/MONITOR.md', present: false },
        ],
        wireframes: ['.agent/plans/42/wireframes/home.drawio'],
      },
    });
    assert.match(prompt, /Read present Stage folder siblings/);
    assert.match(prompt, /wireframes\/\*\.drawio/);
    assert.match(prompt, /home\.drawio/);
  });

  test('execute must consult UX/wireframes and not edit them', () => {
    const prompt = buildPrompt({
      context: { ...issueContext, issue: { ...issueContext.issue, labels: ['agent:execute'] } },
      branch: 'agent/issue-42',
      prNumber: 101,
      action: 'agent:execute',
      taskId: 't-exec',
      planPath: '.agent/plans/42/PLAN.md',
      planExists: true,
      testPath: '.agent/plans/42/TEST.md',
      testExists: true,
      stageInventory: {
        dir: '.agent/plans/42',
        files: [
          { path: '.agent/plans/42/RESEARCH.md', present: false },
          { path: '.agent/plans/42/UX.md', present: true },
          { path: '.agent/plans/42/PLAN.md', present: true },
          { path: '.agent/plans/42/TEST.md', present: true },
          { path: '.agent/plans/42/MONITOR.md', present: false },
        ],
        wireframes: ['.agent/plans/42/wireframes/home.drawio'],
      },
    });
    assert.match(prompt, /Consult present Stage folder siblings/);
    assert.match(prompt, /Do not edit RESEARCH\.md, UX\.md, PLAN\.md/);
  });

  test('triage omits the Stage folder section', () => {
    const prompt = buildPrompt({
      context: { ...issueContext, issue: { ...issueContext.issue, labels: ['agent:triage'] } },
      branch: 'main',
      action: 'agent:triage',
      taskId: 't-triage',
      stageInventory: {
        dir: '.agent/plans/42',
        files: [],
        wireframes: [],
      },
    });
    assert.doesNotMatch(prompt, /## Stage folder/);
  });
});

describe('wireframe publish allowlist', () => {
  test('commits UX.md and .drawio; reverts stray product edits', async () => {
    const { clone } = makeClone();
    const ux = '.agent/plans/42/UX.md';
    const drawio = '.agent/plans/42/wireframes/home.drawio';
    mkdirSync(dirname(join(clone, drawio)), { recursive: true });
    writeFileSync(join(clone, ux), '# Wireframes\n\n<!-- summary: first pass -->\n');
    writeFileSync(join(clone, drawio), DRAWIO);
    sh(clone, 'add', ux, drawio);
    sh(clone, 'commit', '-q', '-m', 'scaffold');
    const headBefore = await readHeadSha(clone);

    writeFileSync(
      join(clone, ux),
      '# Wireframes\n\n<!-- summary: home screen -->\n\n## Wireframes\n\n| File | Purpose |\n| --- | --- |\n| `wireframes/home.drawio` | Home |\n'
    );
    writeFileSync(join(clone, drawio), DRAWIO.replace('page-1', 'home'));
    writeFileSync(join(clone, 'app.js'), 'console.log("tamper");\n');
    writeFileSync(join(clone, 'stray.txt'), 'nope\n');

    const allowed = listWireframeAllowedPaths({ clonePath: clone, project: PROJECT, issueNumber: 42 });
    const result = await commitArtifactRevision({
      clonePath: clone,
      artifactPath: ux,
      issueNumber: 42,
      taskId: 'task-wireframe-1',
      branch: 'agent/issue-42',
      headBefore,
      logger: quiet,
      kind: ARTIFACT_KINDS.UX,
      allowedPaths: allowed,
    });

    assert.equal(result.changed, true);
    assert.equal(result.revision, 1);
    assert.match(sh(clone, 'show', 'HEAD:app.js'), /console\.log\(1\)/);
    assert.equal(sh(clone, 'ls-files', 'stray.txt'), '');
    assert.match(sh(clone, 'show', `HEAD:${drawio}`), /id="home"/);
    assert.match(sh(clone, 'show', `HEAD:${ux}`), /home screen/);
  });
});

describe('UX sticky card', () => {
  test('titles Wireframes and links companion .drawio files', () => {
    const body = renderArtifactCard({
      kind: ARTIFACT_KINDS.UX,
      owner: 'my-org',
      repo: 'primary-app',
      artifactPath: '.agent/plans/42/UX.md',
      changed: true,
      sha: 'abcdef0123456789',
      prevSha: null,
      revision: 1,
      summary: 'Home and match card.',
      needs: null,
      bodyMarkdown: '# Wireframes\n',
      wireframePaths: [
        '.agent/plans/42/wireframes/home.drawio',
        '.agent/plans/42/wireframes/match-card.drawio',
      ],
    });
    assert.match(body, /### Wireframes/);
    assert.match(body, /\*\*Wireframes\*\*/);
    assert.match(body, /home\.drawio/);
    assert.match(body, /match-card\.drawio/);
    assert.match(body, /blob\/abcdef0123456789\/\.agent\/plans\/42\/wireframes\/home\.drawio/);
  });
});

describe('listWireframePaths', () => {
  test('ignores non-drawio files and sorts', () => {
    const { clone } = makeClone();
    mkdirSync(join(clone, '.agent/plans/42/wireframes'), { recursive: true });
    writeFileSync(join(clone, '.agent/plans/42/wireframes/z.drawio'), DRAWIO);
    writeFileSync(join(clone, '.agent/plans/42/wireframes/a.drawio'), DRAWIO);
    writeFileSync(join(clone, '.agent/plans/42/wireframes/.gitkeep'), '');
    assert.deepEqual(listWireframePaths({ clonePath: clone, project: PROJECT, issueNumber: 42 }), [
      '.agent/plans/42/wireframes/a.drawio',
      '.agent/plans/42/wireframes/z.drawio',
    ]);
  });
});
