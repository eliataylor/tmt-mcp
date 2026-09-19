import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { git, run } from './exec.mjs';

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

  if (!existsSync(mirror)) {
    // A local repo can seed the mirror cheaply; otherwise clone from GitHub.
    const source = localPath && existsSync(join(localPath, '.git')) ? localPath : fetchUrl;
    logger.log(`[Repo] creating mirror for ${slug} from ${source}`);
    await run('git', ['clone', '--mirror', source, mirror]);
    // A mirror seeded locally would otherwise keep fetching from the local path forever.
    await git(mirror).run(['remote', 'set-url', 'origin', fetchUrl]);
  }

  logger.log(`[Repo] refreshing mirror for ${slug}`);
  await git(mirror).run(['remote', 'update', '--prune']);
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

  // HTTPS origin with no token in the URL. The runner's entrypoint installs a credential helper
  // that reads GITHUB_TOKEN from the environment (SSH is not available inside the container).
  await g.run(['remote', 'set-url', 'origin', pushUrl]);
  await g.run(['switch', '--create', plan.branch, plan.startPoint]);

  logger.log(
    `[Repo] ${slug} #${issueNumber}: ${plan.resume ? 'resuming' : 'starting'} ${plan.branch} from ${plan.startPoint}`
  );

  return { clonePath, mirror, defaultBranch: effectiveDefault, ...plan };
}

/**
 * GitHub rejects a pull request with no commits between base and head, so a branch identical to
 * the default branch cannot open one. An empty commit is what makes the draft PR legal.
 */
export async function createStartCommit({ clonePath, issueNumber, branch, logger = console }) {
  const g = git(clonePath);
  await g.run(['commit', '--allow-empty', '-m', `chore(#${issueNumber}): start agent work`]);
  await g.run(['push', '--set-upstream', 'origin', branch]);
  logger.log(`[Repo] pushed ${branch}`);
}

export async function pushBranch({ clonePath, branch }) {
  await git(clonePath).run(['push', '--set-upstream', 'origin', branch]);
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

/** Configures the identity commits will carry. Run on the host so the container needs no git config. */
export async function setCommitIdentity({ clonePath, name, email }) {
  const g = git(clonePath);
  await g.run(['config', 'user.name', name]);
  await g.run(['config', 'user.email', email]);
}
