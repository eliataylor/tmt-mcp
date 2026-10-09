import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { normalizePlanFolder } from '../src/projects.mjs';
import {
  commitPlanRevision,
  createStartCommit,
  parsePorcelainPaths,
  readHeadSha,
  readPushedSha,
  renderPlanScaffold,
  resolvePlanRelativePath,
} from '../orchestrator/repo.mjs';
import {
  compareLink,
  extractPlanSummary,
  isMentionHelpAction,
  isPlanAction,
  isTmtCardComment,
  MENTION_HELP_MARKER,
  needsTaskBranch,
  planPermalink,
  renderMentionHelpComment,
  renderPlanComment,
} from '../orchestrator/plan.mjs';
import { PROJECT } from './helpers.mjs';

const quiet = { log() {}, warn() {} };

function sh(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/** A clone on `agent/issue-42` whose origin is a local bare repo, so pushes stay on disk. */
function makeClone() {
  const root = mkdtempSync(join(tmpdir(), 'plan-test-'));
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

const PLAN = '.agent/plans/42/PLAN.md';
const SCAFFOLD = '# Plan\n\n<!-- summary: -->\n\n## Understanding\n';

async function started() {
  const repo = makeClone();
  await createStartCommit({
    clonePath: repo.clone,
    issueNumber: 42,
    branch: 'agent/issue-42',
    planPath: PLAN,
    scaffold: SCAFFOLD,
    logger: quiet,
  });
  return { ...repo, headBefore: await readHeadSha(repo.clone) };
}

function revise(clone, text) {
  mkdirSync(dirname(join(clone, PLAN)), { recursive: true });
  writeFileSync(join(clone, PLAN), text);
}

const commit = (repo, taskId = 'task-aaaaaaaa-1') =>
  commitPlanRevision({
    clonePath: repo.clone,
    planPath: PLAN,
    issueNumber: 42,
    taskId,
    branch: 'agent/issue-42',
    headBefore: repo.headBefore,
    logger: quiet,
  });

describe('plan paths', () => {
  test('defaults to .agent/plans and names the file after the issue', () => {
    assert.equal(resolvePlanRelativePath({}, 42), '.agent/plans/42/PLAN.md');
    assert.equal(resolvePlanRelativePath({ plan_folder: 'docs/plans/' }, 7), 'docs/plans/7/PLAN.md');
  });

  test('normalizes harmless spellings of a folder', () => {
    assert.equal(normalizePlanFolder('./docs//plans'), 'docs/plans');
  });

  // The orchestrator writes <clone>/<plan_folder> on the host, so an escape is a real write.
  for (const bad of ['../outside', '/etc', 'a/../../b', '.', '.git/hooks', 'C:/plans']) {
    test(`rejects "${bad}"`, () => {
      assert.throws(() => normalizePlanFolder(bad));
    });
  }

  test('rejects an issue number that is not a positive integer', () => {
    assert.throws(() => resolvePlanRelativePath({}, '42/../x'));
  });
});

describe('plan scaffold', () => {
  test('substitutes known placeholders and leaves unknown ones', () => {
    const out = renderPlanScaffold(
      { issue: 42, issue_title: 'Fix it' },
      '# #{issue} {issue_title} {unknown}'
    );
    assert.equal(out, '# #42 Fix it {unknown}');
  });

  test('a title containing a placeholder is written literally, and on one line', () => {
    const out = renderPlanScaffold({ issue: 42, issue_title: 'Support {issue}\nlinks' }, '{issue_title}');
    assert.equal(out, 'Support {issue} links');
  });

  test('the shipped template has the three plan sections and a summary slot', () => {
    const out = renderPlanScaffold({
      issue: 42,
      issue_title: 't',
      issue_url: 'u',
      task_id: 'x',
      created_at: 'now',
    });
    for (const heading of ['## Understanding', '## Needs from you', '## Implementation plan']) {
      assert.match(out, new RegExp(heading));
    }
    assert.match(out, /<!-- summary: -->/);
    assert.doesNotMatch(out, /\{(issue|issue_title|issue_url|task_id|created_at)\}/);
  });
});

describe('readPushedSha', () => {
  test('asks origin when the local remote-tracking ref is stale', async () => {
    const { clone, remote } = await started();
    const stale = sh(clone, 'rev-parse', 'HEAD');

    writeFileSync(join(clone, 'app.js'), 'console.log("agent push");\n');
    sh(clone, 'add', 'app.js');
    sh(clone, 'commit', '-q', '-m', 'agent product commit');
    sh(clone, 'push', '-q', 'origin', 'agent/issue-42');
    const tip = sh(remote, 'rev-parse', 'agent/issue-42');
    assert.notEqual(tip, stale);

    // Simulate a container push that left refs/remotes/origin/<branch> on the pre-run tip.
    sh(clone, 'update-ref', 'refs/remotes/origin/agent/issue-42', stale);
    assert.equal(sh(clone, 'rev-parse', 'refs/remotes/origin/agent/issue-42'), stale);

    assert.equal(await readPushedSha({ clonePath: clone, branch: 'agent/issue-42' }), tip);
  });
});

describe('start commit', () => {
  test('the branch opens with the plan scaffold and is pushed', async () => {
    const { clone, remote } = await started();
    assert.equal(sh(clone, 'log', '-1', '--format=%s'), 'chore(#42): add plan scaffold');
    assert.equal(readFileSync(join(clone, PLAN), 'utf8'), SCAFFOLD);
    assert.equal(sh(remote, 'rev-parse', 'agent/issue-42'), sh(clone, 'rev-parse', 'HEAD'));
  });

  test('refuses a plan folder the repo ignores', async () => {
    const { clone } = makeClone();
    writeFileSync(join(clone, '.gitignore'), '.env.local\n.agent/\n');
    await assert.rejects(
      createStartCommit({
        clonePath: clone,
        issueNumber: 42,
        branch: 'agent/issue-42',
        planPath: PLAN,
        scaffold: SCAFFOLD,
        logger: quiet,
      }),
      /covered by \.gitignore/
    );
  });
});

describe('plan revisions', () => {
  test('each changed run is one pushed commit touching only the plan file', async () => {
    const repo = await started();
    revise(repo.clone, '# Plan v1\n');
    const first = await commit(repo);
    assert.equal(first.changed, true);
    assert.equal(first.revision, 1);
    assert.match(sh(repo.clone, 'log', '-1', '--format=%s'), /^plan\(#42\): revision 1 \(task task-aaa\)$/);
    assert.equal(sh(repo.clone, 'show', '--name-only', '--format=', 'HEAD'), PLAN);
    assert.equal(sh(repo.remote, 'rev-parse', 'agent/issue-42'), first.sha);

    repo.headBefore = first.sha;
    revise(repo.clone, '# Plan v2\n');
    const second = await commit(repo, 'task-bbbbbbbb-2');
    assert.equal(second.revision, 2);
    assert.equal(second.prevSha, first.sha);
  });

  test('an untouched plan makes no commit', async () => {
    const repo = await started();
    const result = await commit(repo);
    assert.equal(result.changed, false);
    assert.equal(result.sha, repo.headBefore);
    assert.equal(sh(repo.clone, 'rev-parse', 'HEAD'), repo.headBefore);
  });

  test('edits outside the plan are reverted, ignored files are kept', async () => {
    const repo = await started();
    revise(repo.clone, '# Plan v1\n');
    writeFileSync(join(repo.clone, 'app.js'), 'console.log("changed");\n');
    writeFileSync(join(repo.clone, 'stray.txt'), 'new\n');
    writeFileSync(join(repo.clone, '.env.local'), 'DATABASE_URL=x\n');
    sh(repo.clone, 'add', 'stray.txt');

    const result = await commit(repo);
    assert.equal(sh(repo.clone, 'show', '--name-only', '--format=', 'HEAD'), PLAN);
    assert.equal(readFileSync(join(repo.clone, 'app.js'), 'utf8'), 'console.log(1);\n');
    assert.equal(existsSync(join(repo.clone, 'stray.txt')), false);
    assert.equal(existsSync(join(repo.clone, '.env.local')), true);
    assert.match(result.warnings.join('\n'), /reverted edits outside the plan: app\.js, stray\.txt/);
  });

  test('commits the agent made are kept, flagged, and the plan lands on top', async () => {
    const repo = await started();
    writeFileSync(join(repo.clone, 'app.js'), 'console.log(2);\n');
    sh(repo.clone, 'commit', '-q', '-am', 'agent did this');
    revise(repo.clone, '# Plan v1\n');

    const result = await commit(repo);
    assert.equal(result.changed, true);
    assert.equal(sh(repo.clone, 'log', '-2', '--format=%s'), `${sh(repo.clone, 'log', '-1', '--format=%s')}\nagent did this`);
    assert.match(result.warnings.join('\n'), /made 1 commit\(s\) of its own/);
  });

  test('a branch that predates plan files commits the scaffold as revision 1', async () => {
    const repo = makeClone();
    sh(repo.clone, 'commit', '-q', '--allow-empty', '-m', 'chore(#42): start agent work');
    repo.headBefore = await readHeadSha(repo.clone);
    execFileSync('mkdir', ['-p', join(repo.clone, '.agent/plans')]);
    revise(repo.clone, SCAFFOLD);

    const result = await commit(repo);
    assert.equal(result.changed, true);
    assert.equal(result.revision, 1);
    assert.equal(result.prevSha, null);
  });

  test('porcelain parsing reports renames by their destination', () => {
    assert.deepEqual(parsePorcelainPaths(' M a.js\nR  old.js -> new.js\n?? "sp ace.txt"\n'), [
      'a.js',
      'new.js',
      'sp ace.txt',
    ]);
  });
});

describe('plan comment', () => {
  const base = { owner: 'my-org', repo: 'primary-app', planPath: PLAN };
  const sha = 'b'.repeat(40);
  const prevSha = 'a'.repeat(40);

  test('plan actions are the three planning triggers', () => {
    for (const action of ['agent:sdd', 'agent:opened', 'comment_created']) {
      assert.equal(isPlanAction(action), true, action);
    }
    for (const action of ['agent:execute', 'agent:triage']) {
      assert.equal(isPlanAction(action), false, action);
    }
  });

  test('links the exact version and the diff from the previous revision', () => {
    const body = renderPlanComment({ ...base, changed: true, sha, prevSha, revision: 3, summary: 'Narrowed scope.' });
    assert.match(body, /System design/);
    assert.match(body, /Rev 3/);
    assert.match(body, /<!-- tmt:card:PLAN -->/);
    assert.ok(body.includes(planPermalink({ ...base, sha })));
    assert.ok(body.includes(`/blob/${sha}/.agent/plans/42/PLAN.md`));
    assert.ok(body.includes(compareLink({ ...base, fromSha: prevSha, toSha: sha })));
    assert.match(body, /> Narrowed scope\./);
  });

  test('the first revision has no compare link', () => {
    const body = renderPlanComment({ ...base, changed: true, sha, prevSha: null, revision: 1 });
    assert.doesNotMatch(body, /compare\//);
  });

  test('an unchanged plan says so and links the current version', () => {
    const body = renderPlanComment({ ...base, changed: false, sha: prevSha, prevSha, revision: null });
    assert.match(body, /Unchanged since last run/);
    assert.ok(body.includes(`/blob/${prevSha}/`));
  });

  test('nothing to link means no comment', () => {
    assert.equal(renderPlanComment({ ...base, changed: false, sha: null }), null);
  });

  test('warnings are surfaced to the humans reading the thread', () => {
    const body = renderPlanComment({ ...base, changed: true, sha, revision: 1, warnings: ['reverted edits outside the plan: app.js'] });
    assert.match(body, /_Note: reverted edits outside the plan: app\.js\._/);
  });

  test('the summary is one capped line, and an empty slot yields none', () => {
    assert.equal(extractPlanSummary('<!-- summary: -->'), null);
    assert.equal(extractPlanSummary('# x\n<!-- summary:  Two\n lines  -->'), 'Two lines');
    assert.equal(extractPlanSummary(`<!-- summary: ${'x'.repeat(400)} -->`).length, 280);
    assert.equal(extractPlanSummary('no slot'), null);
  });
});

describe('mention help', () => {
  test('mention_help skips the task branch and is recognized as a sticky card', () => {
    assert.equal(isMentionHelpAction('mention_help'), true);
    assert.equal(needsTaskBranch('mention_help'), false);
    assert.equal(needsTaskBranch('agent:sdd'), true);
  });

  test('renders a sticky usage card with configured tokens', () => {
    const body = renderMentionHelpComment({ project: PROJECT });
    assert.ok(body.startsWith(MENTION_HELP_MARKER));
    assert.match(body, /assign `dev-agent`/);
    assert.match(body, /`agent:sdd`/);
    assert.match(body, /backticked control token/);
    assert.equal(isTmtCardComment(body), true);
  });
});
