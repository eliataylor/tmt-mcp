import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { git, run } from './exec.mjs';
import {
  ARTIFACT_KINDS,
  artifactKindForAction,
  resolveArtifactRelativePath,
  resolvePlanRelativePath,
} from './artifacts.mjs';

const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));

const SCAFFOLD_FILES = {
  [ARTIFACT_KINDS.PLAN]: 'plan.scaffold.md',
  [ARTIFACT_KINDS.RESEARCH]: 'research.scaffold.md',
  [ARTIFACT_KINDS.UX]: 'ux.scaffold.md',
  [ARTIFACT_KINDS.TEST]: 'test.scaffold.md',
  [ARTIFACT_KINDS.MONITOR]: 'monitor.scaffold.md',
};

export { resolvePlanRelativePath, resolveArtifactRelativePath };

/**
 * Git isolation.
 *
 * The container never sees the real repository. Each task gets its own clone from a local bare
 * mirror, so the worst a runaway agent can do is push to its own branch — bounded by the PAT's
 * scope and by branch protection.
 *
 * A git worktree would not work here: its `.git` is a file holding an absolute path to the parent
 * repository, which lands outside the bind mount, so every git command inside the container fails.
 */

/** No git transport by this name, so `git push` in a read-only clone fails instead of reaching GitHub. */
export const READ_ONLY_PUSH_URL = 'read-only://triage-tasks-do-not-push';

export function branchNameFor(issueNumber) {
  // Keeps `issue-<n>` so the Neon cleanup workflow's `issue-\K\d+` regex still matches.
  return `agent/issue-${issueNumber}`;
}

export function mirrorPathFor(mirrorsDir, slug) {
  return join(mirrorsDir, `${slug}.git`);
}

export function clonePathFor(clonesDir, slug, issueNumber, taskId) {
  return join(clonesDir, `${slug}-issue-${issueNumber}-${String(taskId).slice(0, 8)}`);
}

/** Creates the workdir tree with 0700 so another user on the machine cannot walk it. */
export function ensureWorkdir(paths) {
  for (const dir of [paths.workdir, paths.mirrors, paths.clones, paths.tasks]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export async function ensureMirror({ mirrorsDir, slug, fetchUrl, localPath, logger = console }) {
  const mirror = mirrorPathFor(mirrorsDir, slug);
  // The mirror is not mounted into the runner, so this fetch may use ssh-agent. Clones the agent
  // can rewrite still go through git() with ssh disabled.
  const mirrorGit = git(mirror, { allowSsh: true });

  if (!existsSync(mirror)) {
    // A local repo can seed the mirror cheaply; otherwise clone from GitHub.
    const source = localPath && existsSync(join(localPath, '.git')) ? localPath : fetchUrl;
    logger.log(`[Repo] creating mirror for ${slug} from ${source}`);
    await run('git', ['clone', '--mirror', source, mirror]);
  }

  // A mirror outlives config edits. A rename, or a switch from HTTPS to SSH, has to be applied
  // here or refresh keeps the URL from the day the directory was created.
  await mirrorGit.run(['remote', 'set-url', 'origin', fetchUrl]);

  logger.log(`[Repo] refreshing mirror for ${slug}`);
  await mirrorGit.run(['remote', 'update', '--prune']);
  return mirror;
}

/**
 * Decide what the task branch should be based on whether the agent has worked this issue before.
 * Split out from cloning so it can be unit tested without touching a filesystem.
 */
export function resolveBranchPlan({ issueNumber, defaultBranch, remoteBranches }) {
  const branch = branchNameFor(issueNumber);
  const exists = remoteBranches.includes(branch);
  return {
    branch,
    resume: exists,
    // Resuming stacks on the agent's own prior work; a new issue starts from the default branch.
    startPoint: exists ? `origin/${branch}` : `origin/${defaultBranch}`,
  };
}

/**
 * projects.json default_branch must match GitHub. When it does not, prefer mirror HEAD so clone
 * does not fail with "invalid reference: origin/main" on repos that still use master.
 */
export function resolveEffectiveDefaultBranch(configured, mirrorBranches, mirrorHead) {
  if (configured && mirrorBranches.includes(configured)) return configured;
  if (mirrorHead && mirrorBranches.includes(mirrorHead)) return mirrorHead;
  const listed = [...mirrorBranches].sort().join(', ');
  throw new Error(
    `default_branch "${configured}" is not in the repository mirror. ` +
      `Branches present: ${listed || '(none)'}. ` +
      'Set default_branch in projects.json to match the repo on GitHub.'
  );
}

export async function listRemoteBranches(repoPath) {
  const out = await git(repoPath).capture([
    'for-each-ref',
    '--format=%(refname:strip=3)',
    'refs/remotes/origin',
  ]);
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

async function listMirrorBranches(mirrorPath) {
  // A mirror keeps branches at refs/heads, not refs/remotes/origin.
  const out = await git(mirrorPath).capture(['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads']);
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

async function readMirrorHeadBranch(mirrorPath) {
  try {
    return await git(mirrorPath).capture(['symbolic-ref', '--short', 'HEAD']);
  } catch {
    return null;
  }
}

/**
 * Clone the mirror into a per-task directory and put it on the task branch.
 *
 * `--local` hardlinks the object store, so this is near-instant on the same filesystem. Git
 * objects are immutable, so sharing those inodes is safe; `noHardlinks` trades speed for a full
 * copy when that tradeoff is unwelcome.
 */
export async function prepareClone({
  mirrorsDir,
  clonesDir,
  slug,
  fetchUrl,
  pushUrl,
  localPath,
  issueNumber,
  taskId,
  defaultBranch,
  noHardlinks = false,
  readOnly = false,
  logger = console,
}) {
  const mirror = await ensureMirror({ mirrorsDir, slug, fetchUrl, localPath, logger });
  const clonePath = clonePathFor(clonesDir, slug, issueNumber, taskId);

  if (existsSync(clonePath)) rmSync(clonePath, { recursive: true, force: true });

  const mirrorBranches = await listMirrorBranches(mirror);
  const mirrorHead = await readMirrorHeadBranch(mirror);
  const effectiveDefault = resolveEffectiveDefaultBranch(
    defaultBranch,
    mirrorBranches,
    mirrorHead
  );
  if (effectiveDefault !== defaultBranch) {
    logger.warn(
      `[Repo] ${slug}: default_branch in projects.json is "${defaultBranch}" but the mirror ` +
        `HEAD is "${effectiveDefault}"; branching and PR base will use "${effectiveDefault}"`
    );
  }

  const plan = resolveBranchPlan({
    issueNumber,
    defaultBranch: effectiveDefault,
    remoteBranches: mirrorBranches,
  });

  await run('git', [
    'clone',
    '--local',
    ...(noHardlinks ? ['--no-hardlinks'] : []),
    mirror,
    clonePath,
  ]);

  const g = git(clonePath);

  // HTTPS origin with no token in the URL. The runner reaches GitHub through the credential proxy,
  // which injects the token; SSH is not available inside the container.
  await g.run(['remote', 'set-url', 'origin', pushUrl]);

  // A read-only task (triage) stays on the default branch. Creating `agent/issue-<n>` for it would
  // either invent a branch nothing will ever push, or check out an earlier task's unmerged work and
  // describe that as the current state of the code.
  if (readOnly) {
    // Fetch URL kept so tooling can still tell which repository this is; pushes are made to fail on
    // an unknown transport, so "do not push" is enforced by git rather than only by the prompt.
    await g.run(['config', 'remote.origin.pushurl', READ_ONLY_PUSH_URL]);
    logger.log(`[Repo] ${slug} #${issueNumber}: read-only clone on ${effectiveDefault}`);
    return {
      clonePath,
      mirror,
      defaultBranch: effectiveDefault,
      branch: effectiveDefault,
      resume: false,
      startPoint: `origin/${effectiveDefault}`,
      readOnly: true,
    };
  }

  await g.run(['switch', '--create', plan.branch, plan.startPoint]);

  logger.log(
    `[Repo] ${slug} #${issueNumber}: ${plan.resume ? 'resuming' : 'starting'} ${plan.branch} from ${plan.startPoint}`
  );

  return { clonePath, mirror, defaultBranch: effectiveDefault, ...plan };
}

function scaffoldTemplatePath(kind) {
  const file = SCAFFOLD_FILES[kind];
  if (!file) throw new Error(`no scaffold template for artifact kind "${kind}"`);
  return join(TEMPLATES_DIR, file);
}

/**
 * Fill the scaffold's `{placeholder}` tokens in one pass, so a value that itself contains a token
 * (an issue title like "Support {issue} links") is written literally rather than substituted again.
 */
export function renderScaffold(values, template) {
  return template.replace(/\{([a-z_]+)\}/g, (token, key) =>
    Object.hasOwn(values, key) && values[key] !== null && values[key] !== undefined
      ? String(values[key]).replace(/[\r\n]+/g, ' ')
      : token
  );
}

export function renderPlanScaffold(values, template = readFileSync(scaffoldTemplatePath(ARTIFACT_KINDS.PLAN), 'utf8')) {
  return renderScaffold(values, template);
}

export function renderArtifactScaffold(kind, values) {
  return renderScaffold(values, readFileSync(scaffoldTemplatePath(kind), 'utf8'));
}

/** Primary artifact path for a queue action. */
export function resolveActionArtifactPath(project, issueNumber, action) {
  const kind = artifactKindForAction(action);
  if (!kind) return null;
  return resolveArtifactRelativePath(project, issueNumber, kind);
}

/** Writes the scaffold unless the file already exists. Returns whether it wrote anything. */
export function writePlanScaffold({ clonePath, planPath, content }) {
  return writeArtifactScaffold({ clonePath, artifactPath: planPath, content });
}

export function writeArtifactScaffold({ clonePath, artifactPath, content }) {
  const target = join(clonePath, artifactPath);
  if (existsSync(target)) return false;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return true;
}

export function planFileExists({ clonePath, planPath }) {
  return artifactFileExists({ clonePath, artifactPath: planPath });
}

export function artifactFileExists({ clonePath, artifactPath }) {
  return existsSync(join(clonePath, artifactPath));
}

/** A gitignored artifact folder would make every revision commit silently empty. */
export async function assertPlanPathTracked(clonePath, planPath) {
  return assertArtifactPathTracked(clonePath, planPath);
}

export async function assertArtifactPathTracked(clonePath, artifactPath) {
  if (await git(clonePath).succeeds(['check-ignore', '-q', '--', artifactPath])) {
    throw new Error(
      `${artifactPath} is covered by .gitignore in this repository, so stage revisions cannot be ` +
        'committed. Point plan_folder at a tracked folder or un-ignore it.'
    );
  }
}

/**
 * GitHub rejects a pull request with no commits between base and head, so a branch identical to
 * the default branch cannot open one. The branch's first commit adds the plan scaffold, which is
 * what makes the draft PR legal. It falls back to an empty commit when the file already exists on
 * the base branch, which happens when a reviewer kept an earlier plan in a merged PR.
 */
export async function createStartCommit({
  clonePath,
  issueNumber,
  branch,
  planPath,
  scaffold,
  artifactPath = planPath,
  githubToken = null,
  logger = console,
}) {
  const g = git(clonePath);
  const path = artifactPath || planPath;
  const wrote = writeArtifactScaffold({ clonePath, artifactPath: path, content: scaffold });
  if (wrote) {
    await assertArtifactPathTracked(clonePath, path);
    await g.run(['add', '--', path]);
    const base = path.split('/').pop();
    const scaffoldLabel = base === 'PLAN.md' ? 'plan scaffold' : `${base} scaffold`;
    await g.run(['commit', '-m', `chore(#${issueNumber}): add ${scaffoldLabel}`]);
  } else {
    await g.run(['commit', '--allow-empty', '-m', `chore(#${issueNumber}): start agent work`]);
  }
  await pushBranch({ clonePath, branch, githubToken });
  logger.log(`[Repo] pushed ${branch}${wrote ? ` with ${path}` : ''}`);
}

export async function readHeadSha(clonePath) {
  return git(clonePath).capture(['rev-parse', 'HEAD']);
}

/** The last commit that touched the file, or null when it has never been committed. */
export async function readPlanCommitSha({ clonePath, planPath }) {
  return readArtifactCommitSha({ clonePath, artifactPath: planPath });
}

export async function readArtifactCommitSha({ clonePath, artifactPath }) {
  const sha = await git(clonePath).capture(['log', '-1', '--format=%H', '--', artifactPath]);
  return sha || null;
}

const REVISION_SUBJECT = /^(?:plan|artifact)\(#\d+\): revision \d+/;

export function planRevisionMessage({ issueNumber, revision, taskId }) {
  return artifactRevisionMessage({ issueNumber, revision, taskId, kind: 'plan' });
}

export function artifactRevisionMessage({ issueNumber, revision, taskId, kind = 'artifact' }) {
  const label =
    kind === 'PLAN' || kind === 'plan' || kind === ARTIFACT_KINDS.PLAN ? 'plan' : 'artifact';
  return `${label}(#${issueNumber}): revision ${revision} (task ${String(taskId).slice(0, 8)})`;
}

/** Porcelain v1 paths, with a rename reported as its destination. */
export function parsePorcelainPaths(output) {
  return output
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => {
      const path = line.slice(3);
      const arrow = path.indexOf(' -> ');
      const target = arrow === -1 ? path : path.slice(arrow + 4);
      return target.replace(/^"(.*)"$/, '$1');
    });
}

/**
 * Commit whatever the agent wrote to the plan file, and nothing else.
 *
 * Uncommitted edits elsewhere are reverted: plan mode's only output is the plan. Commits the agent
 * made on its own are left in place, because collapsing ones it already pushed would mean a
 * force-push, and they are reported so a human can look at them. Ignored files (`.env.local`,
 * `node_modules`) are never touched.
 */
export async function commitPlanRevision(opts) {
  return commitArtifactRevision({
    ...opts,
    artifactPath: opts.planPath,
    kind: opts.kind || ARTIFACT_KINDS.PLAN,
  });
}

/**
 * Commit whatever the agent wrote to the artifact path(s), and nothing else.
 *
 * Uncommitted edits elsewhere are reverted. Agent commits already on the branch stay.
 * Ignored files (`.env.local`, `node_modules`) are never touched.
 *
 * @param {object} opts
 * @param {string[]|null} [opts.allowedPaths] when set, stage every existing path in the list and
 *   revert everything outside it (e.g. graphic: UX.md + wireframes/*.drawio).
 */
export async function commitArtifactRevision({
  clonePath,
  artifactPath,
  planPath,
  issueNumber,
  taskId,
  branch,
  headBefore,
  githubToken = null,
  logger = console,
  allowedPaths = null,
  kind = 'artifact',
  /** When false (execute TEST publish), only stage the artifact; leave other dirty files alone. */
  revertOthers = true,
}) {
  const path = artifactPath || planPath;
  const stagePaths = allowedPaths?.length ? [...new Set(allowedPaths)] : [path];
  const g = git(clonePath);
  const warnings = [];

  const agentCommits = headBefore
    ? Number(await g.capture(['rev-list', '--count', `${headBefore}..HEAD`]))
    : 0;
  if (agentCommits > 0) {
    warnings.push(`the agent made ${agentCommits} commit(s) of its own; left in place`);
  }

  const { stdout: status } = await g.run(['status', '--porcelain=v1', '--untracked-files=all']);
  const allow = new Set(stagePaths);
  const stray = parsePorcelainPaths(status).filter((p) => !allow.has(p));

  async function stageAllowed() {
    for (const p of stagePaths) {
      if (artifactFileExists({ clonePath, artifactPath: p })) await g.run(['add', '--', p]);
    }
  }

  if (revertOthers) {
    await g.run(['reset', '-q']);
    await stageAllowed();
    if (stray.length) {
      await g.run(['checkout', '--', '.']);
      await g.run(['clean', '-fdq']);
      await stageAllowed();
      const noun = path.endsWith('/PLAN.md') || path.endsWith('PLAN.md') ? 'plan' : 'artifact';
      warnings.push(`reverted edits outside the ${noun}: ${stray.slice(0, 10).join(', ')}`);
    }
  } else {
    // Stage only the primary artifact; do not reset the rest of the tree (execute may have product edits).
    if (artifactFileExists({ clonePath, artifactPath: path })) {
      await g.run(['add', '--', path]);
    }
  }
  for (const w of warnings) logger.warn(`[Repo] #${issueNumber}: ${w}`);

  const prevSha = await readArtifactCommitSha({ clonePath, artifactPath: path });

  if (await g.succeeds(['diff', '--cached', '--quiet', '--', ...stagePaths])) {
    const sha = prevSha || (await readHeadSha(clonePath));
    return { changed: false, sha, prevSha, revision: null, warnings };
  }

  const subjects = prevSha
    ? (await g.capture(['log', '--format=%s', '--', path])).split('\n')
    : [];
  const revision = subjects.filter((s) => REVISION_SUBJECT.test(s)).length + 1;

  await g.run([
    'commit',
    '-m',
    artifactRevisionMessage({ issueNumber, revision, taskId, kind }),
  ]);
  await pushBranch({ clonePath, branch, githubToken });
  const sha = await readHeadSha(clonePath);
  logger.log(`[Repo] #${issueNumber}: pushed ${path} revision ${revision} (${sha.slice(0, 7)})`);

  return { changed: true, sha, prevSha, revision, warnings };
}

export async function pushBranch({ clonePath, branch, githubToken = null }) {
  // HTTPS origin, no token in the URL. The helper reads GITHUB_TOKEN from this process only.
  await git(clonePath, { githubToken }).run(['push', '--set-upstream', 'origin', branch]);
}

/**
 * The commit GitHub actually has for this branch, which is what any deployment was built from.
 *
 * Not the same as local HEAD: the agent pushes from inside the container against this very clone,
 * so the remote-tracking ref is current, but it may also have committed without pushing. HEAD is
 * the fallback only for the case where the branch was never pushed at all.
 */
export async function readPushedSha({ clonePath, branch }) {
  const g = git(clonePath);
  for (const rev of [`refs/remotes/origin/${branch}`, 'HEAD']) {
    try {
      return await g.capture(['rev-parse', rev]);
    } catch {
      // Ref is missing; try the next one.
    }
  }
  return null;
}

/**
 * Refuse to write .env.local unless the repository already ignores it. Without this the agent can
 * commit a live database URL, and no amount of prompt instruction reliably prevents that.
 */
export async function assertEnvLocalIgnored(clonePath, filename = '.env.local') {
  const ignored = await git(clonePath).succeeds(['check-ignore', '-q', filename]);
  if (!ignored) {
    throw new Error(
      `${filename} is not covered by .gitignore in this repository. Refusing to write secrets ` +
        'into a file the agent could commit. Add it to .gitignore and retry.'
    );
  }
}

/**
 * Copy `.git/config` and `.git/hooks` aside before the container starts.
 *
 * Taken before the agent runs, so a later restore cannot follow a symlink the agent planted at
 * the destination: the destination is removed first, then the snapshot is copied back.
 */
export function snapshotGitMetadata(clonePath, destDir) {
  const gitDir = gitDirOf(clonePath);
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  cpSync(join(gitDir, 'config'), join(destDir, 'config'));
  const hooks = join(gitDir, 'hooks');
  if (existsSync(hooks)) {
    cpSync(hooks, join(destDir, 'hooks'), { recursive: true });
  }
}

/** Put the pre-run config and hooks back, discarding whatever the container wrote. */
export function restoreGitMetadata(clonePath, destDir) {
  const gitDir = gitDirOf(clonePath);
  const configSrc = join(destDir, 'config');
  if (!existsSync(configSrc)) {
    throw new Error(`git metadata snapshot at ${destDir} has no config`);
  }
  replacePath(configSrc, join(gitDir, 'config'));
  const hooksSrc = join(destDir, 'hooks');
  const hooksDest = join(gitDir, 'hooks');
  removePath(hooksDest);
  if (existsSync(hooksSrc)) cpSync(hooksSrc, hooksDest, { recursive: true });
  else mkdirSync(hooksDest, { mode: 0o755 });
}

function gitDirOf(clonePath) {
  const gitDir = join(clonePath, '.git');
  let st;
  try {
    st = lstatSync(gitDir);
  } catch {
    throw new Error(`${gitDir} does not exist`);
  }
  if (!st.isDirectory()) {
    throw new Error(`${gitDir} is not a directory; refusing to snapshot it`);
  }
  return gitDir;
}

function removePath(target) {
  let st;
  try {
    st = lstatSync(target);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (st.isSymbolicLink()) unlinkSync(target);
  else if (st.isDirectory()) rmSync(target, { recursive: true, force: true });
  else unlinkSync(target);
}

function replacePath(src, dest) {
  removePath(dest);
  cpSync(src, dest);
}

/** Configures the identity commits will carry. Run on the host so the container needs no git config. */
export async function setCommitIdentity({ clonePath, name, email }) {
  const g = git(clonePath);
  await g.run(['config', 'user.name', name]);
  await g.run(['config', 'user.email', email]);
}
