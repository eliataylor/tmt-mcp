#!/usr/bin/env node
/**
 * Walk every orchestrator stage for a fixture delivery, printing what would happen without
 * touching Docker, Neon, GitHub, or the filesystem.
 *
 * Usage:
 *   node scripts/dry-run-task.mjs
 *   node scripts/dry-run-task.mjs --fixture issue_comment.created.json --resume
 *   node scripts/dry-run-task.mjs --project main-app --issue 42
 */
import { readFileSync } from 'node:fs';

import { buildContext } from '../src/context.mjs';
import { ACTIONS, classify } from '../src/triggers.mjs';
import { loadRegistry } from '../src/projects.mjs';
import {
  branchNameFor,
  clonePathFor,
  mirrorPathFor,
  resolveBranchPlan,
  resolvePlanRelativePath,
} from '../orchestrator/repo.mjs';
import { isArtifactAction } from '../orchestrator/plan.mjs';
import { buildCreateBranchBody, branchNameFor as neonBranchNameFor } from '../orchestrator/neon.mjs';
import { githubMcpEnv } from '../orchestrator/mcp.mjs';
import { buildPrompt } from '../orchestrator/prompt.mjs';
import {
  buildRunArgs,
  containerNameFor,
  homeVolumeFor,
  modulesVolumeFor,
  npmCacheVolumeFor,
  mountTargetsFrom,
} from '../orchestrator/runner.mjs';
import { taskDirFor } from '../orchestrator/taskdir.mjs';
import { workspaceLabelFor } from '../orchestrator/herdr.mjs';
import { shellJoin } from '../orchestrator/exec.mjs';
import { loadConfig } from '../orchestrator/config.mjs';

function parseArgs(argv) {
  const args = { fixture: 'issues.labeled.json', resume: false, taskId: 'dryrun00' };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fixture') args.fixture = argv[++i];
    else if (arg === '--project') args.project = argv[++i];
    else if (arg === '--issue') args.issue = Number(argv[++i]);
    else if (arg === '--resume') args.resume = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function heading(title) {
  console.log(`\n${'─'.repeat(78)}\n${title}\n${'─'.repeat(78)}`);
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace('/**', ''));
  process.exit(0);
}

const fixturePath = new URL(`../fixtures/${args.fixture}`, import.meta.url);
const payload = JSON.parse(readFileSync(fixturePath, 'utf8'));

// Nothing below writes anything; DRY_RUN keeps the docker and herdr wrappers in reporting mode too.
process.env.DRY_RUN = 'true';
const config = loadConfig();

const registry = loadRegistry();
const repoFullName = payload.repository?.full_name;
const registryEntry = registry.byRepo(repoFullName);

if (!registryEntry) {
  console.error(`No project registered for ${repoFullName}. Add it to ${registry.configPath}.`);
  process.exit(1);
}

const slug = args.project || registryEntry.slug;
const project = config.project(slug) || {
  ...registryEntry,
  clone_url: `https://github.com/${registryEntry.repo}.git`,
  env_template: {},
  agent: { model: null, setup_cmd: null },
  neon: null,
  local_path: null,
};

const event = args.fixture.startsWith('issue_comment') ? 'issue_comment' : 'issues';
const verdict = classify({ event, payload, project: registryEntry });

heading('1. Trigger classification');
console.log(`event      : ${event}.${payload.action}`);
console.log(`project    : ${slug} (${project.repo})`);
console.log(`verdict    : ${verdict.kind}${verdict.action ? ` -> ${verdict.action}` : ''}`);
if (verdict.reason) console.log(`reason     : ${verdict.reason}`);
if (verdict.kind !== 'enqueue') {
  console.log('\nThis delivery would not create a task. Nothing further to walk.');
  process.exit(0);
}

const context = buildContext({
  event,
  action: verdict.action,
  payload,
  project: registryEntry,
  deliveryId: 'dry-run-delivery',
  deliveredAt: new Date().toISOString(),
});

const issueNumber = args.issue || context.issue.number;
const taskId = args.taskId;

heading('2. Context manifest');
console.log(`issue         : #${issueNumber} ${context.issue.title}`);
console.log(`author        : @${context.issue.author}`);
console.log(`files cited   : ${context.references.files.length}`);
for (const file of context.references.files.slice(0, 8)) {
  const range = file.line_start ? `:${file.line_start}` : '';
  console.log(`                ${file.path}${range} (${file.source})`);
}
console.log(`thread        : ${context.fetch.comment_count} comment(s), ${context.fetch.comments_included} embedded`);

// Triage reads the tree and writes labels, so every code-bearing stage below is skipped for it.
const triage = verdict.action === ACTIONS.TRIAGE;
const planning = isArtifactAction(verdict.action);
const planPath = triage ? null : resolvePlanRelativePath(project, issueNumber);

heading('3. Git isolation');
const mirror = mirrorPathFor(config.paths.mirrors, slug);
const clonePath = clonePathFor(config.paths.clones, slug, issueNumber, taskId);
const plan = resolveBranchPlan({
  issueNumber,
  defaultBranch: project.default_branch,
  remoteBranches: args.resume
    ? [project.default_branch, branchNameFor(issueNumber)]
    : [project.default_branch],
});
console.log(`mirror        : ${mirror}`);
const fetchUrl = project.fetch_url || project.clone_url;
const pushUrl = project.push_url || fetchUrl;
console.log(`  git clone --mirror ${fetchUrl} ${mirror}      (first time)`);
console.log(`  git -C ${mirror} remote update --prune`);
console.log(`clone         : ${clonePath}`);
console.log(`  git clone --local ${mirror} ${clonePath}`);
console.log(`  git -C ${clonePath} remote set-url origin ${pushUrl}   (HTTPS + PAT in runner)`);
if (triage) {
  console.log(`branch        : ${project.default_branch} (read-only clone; triage creates no branch)`);
} else {
  console.log(`branch        : ${plan.branch} ${plan.resume ? '(resuming)' : '(new)'}`);
  console.log(`  git -C ${clonePath} switch --create ${plan.branch} ${plan.startPoint}`);
}

heading('4. GitHub');
const [owner, repoName] = project.repo.split('/');
if (triage) {
  console.log('No start commit, no branch push, and no pull request for a triage task.');
  console.log(`The runner labels issue #${issueNumber} and comments on it over the GitHub MCP server.`);
} else if (!plan.resume) {
  console.log(`  write ${planPath} from templates/plan.scaffold.md`);
  console.log(`  git add -- ${planPath} && git commit -m "chore(#${issueNumber}): add plan scaffold"`);
  console.log(`  git push --set-upstream origin ${plan.branch}`);
  console.log(`  POST /repos/${owner}/${repoName}/pulls  { head: "${plan.branch}", base: "${project.default_branch}", draft: true }`);
  console.log('        (falls back to draft:false if the repo/plan rejects draft PRs)');
  console.log(`  POST /repos/${owner}/${repoName}/issues/${issueNumber}/comments`);
} else {
  console.log(`  GET  /repos/${owner}/${repoName}/pulls?head=${owner}:${plan.branch}&state=open   (reuse)`);
  if (planning) console.log(`  write ${planPath} from the scaffold if the branch predates plan files`);
}

heading('5. Neon');
if (triage) {
  console.log('No database branch for a triage task; it never runs migrations or the app.');
} else if (!project.neon) {
  console.log(`No "neon" block for ${slug} in config/orchestrator.json; no database branch.`);
} else {
  const body = buildCreateBranchBody({
    issueNumber,
    parentId: 'br-RESOLVED-AT-RUNTIME',
    initSource: project.neon.init_source,
  });
  console.log(`  GET  /projects/${project.neon.project_id}/branches   (resolve "${project.neon.parent_branch}" -> br-...)`);
  console.log(`  POST /projects/${project.neon.project_id}/branches`);
  console.log(`${JSON.stringify(body, null, 2).split('\n').map((l) => `       ${l}`).join('\n')}`);
  console.log(`  reuse if ${neonBranchNameFor(issueNumber)} already exists`);
}

heading('6. Task directory');
const taskDir = taskDirFor(config.paths.tasks, slug, issueNumber, taskId);
console.log(`${taskDir}/`);
console.log('  task.json      the full context manifest');
console.log('  prompt.md      rendered below');
console.log('  out/           result.json and run.log come back here');
console.log('  secrets.env    0600, proxy grant + CURSOR_API_KEY (+ PostHog when POSTHOG_MCP_API_KEY is set)');
console.log(
  triage
    ? '\n  no .env.local: a triage task gets no database URL because it runs nothing'
    : `\n  git -C ${clonePath} check-ignore -q .env.local   <- must exit 0 before .env.local is written`
);

heading('7. Runner');
const containerName = containerNameFor({ slug, issueNumber, taskId });
const runArgs = buildRunArgs({
  image: config.runner.image,
  network: config.runner.network,
  containerName,
  clonePath,
  taskDir,
  outDir: `${taskDir}/out`,
  secretsFile: `${taskDir}/secrets.env`,
  caCert: `${config.paths.workdir}/cred-proxy/ca.crt`,
  homeVolume: homeVolumeFor({ slug, issueNumber }),
  npmCacheVolume: npmCacheVolumeFor({ slug }),
  modulesVolume: modulesVolumeFor({ slug }),
  modulesTmpfs: config.runner.modulesTmpfs,
  memory: config.runner.memory,
  cpus: config.runner.cpus,
  pidsLimit: config.runner.pidsLimit,
  noExecTmp: config.runner.noExecTmp,
  env: {
    TASK_ID: taskId,
    AGENT_MODEL: project.agent.model,
    SETUP_CMD: project.agent.setup_cmd,
    CHAT_ID: args.resume ? 'chat-from-state-json' : undefined,
    ...githubMcpEnv(verdict.action),
  },
  labels: { project: slug, issue: String(issueNumber), 'task-id': taskId },
  detach: false,
});
console.log(`docker ${shellJoin(runArgs)}`);
console.log(`\nmounts        : ${mountTargetsFrom(runArgs).join(', ')}`);
console.log('never mounted : docker socket, herdr socket, ~/.ssh, ~/.gitconfig, ~/.cursor, ~/.aws,');
console.log('                the mirror cache, the parent repo, ~/.tmt-agent itself');

heading('8. Herdr');
const label = workspaceLabelFor({ slug, issueNumber, title: context.issue.title });
console.log(`herdr workspace create --cwd ${clonePath} --label ${JSON.stringify(label)} --no-focus`);
console.log('herdr pane run <pane_id> <the docker command above, shell-quoted once>');
console.log(`\nsanitized label: ${label}`);

heading('9. Loop closure');
console.log(`docker wait ${containerName}`);
console.log(`read ${taskDir}/out/result.json   (size-capped, shape-validated, control chars stripped)`);
if (planning) {
  console.log(`on exit 0: revert edits outside ${planPath}, stage only the plan file,`);
  console.log(`  git commit -m "plan(#${issueNumber}): revision N (task ${taskId})" && git push origin ${plan.branch}`);
  console.log(`  POST /repos/${project.repo}/issues/${issueNumber}/comments   (permalink + compare link, or "plan unchanged")`);
}
console.log('POST /api/agent/tasks/<id>/complete   on exit 0');
console.log('POST /api/agent/tasks/<id>/fail      otherwise, with the log tail');
console.log(`heartbeat every ${config.task.heartbeatSeconds}s; a 409 means the task was cancelled -> docker stop`);
console.log(`timeout after ${config.task.timeoutMs}ms -> docker stop (SIGTERM trap writes result.json)`);
console.log(`secrets.env is shredded on every exit path; KEEP_ARTIFACTS=${config.task.keepArtifacts}`);
if (config.preview.enabled && verdict.action === ACTIONS.EXECUTE) {
  console.log(
    `on success, GET /repos/${project.repo}/deployments?sha=<pushed head> then its statuses, ` +
      `for up to ${config.preview.timeoutMs}ms -> comment the preview URL on issue #${issueNumber}`
  );
}

heading('10. prompt.md');
// The real prompt describes the branch Neon reports back, which can differ from what was asked
// for. A dry run has no branch to ask about, so it previews the request instead.
const neonPreview =
  triage || !project.neon
    ? null
    : {
        name: neonBranchNameFor(issueNumber),
        parentBranch: project.neon.parent_branch,
        createdAt: new Date().toISOString(),
        initSource: project.neon.init_source || 'parent-data',
      };
console.log(
  buildPrompt({
    context,
    branch: triage ? project.default_branch : plan.branch,
    prNumber: args.resume && !triage ? 101 : null,
    prUrl: args.resume && !triage ? `https://github.com/${project.repo}/pull/101` : null,
    action: verdict.action,
    taskId,
    neon: neonPreview,
    planPath,
    planExists: !triage,
  })
);

console.log('\nDry run complete. Nothing was created, started, or written.');
