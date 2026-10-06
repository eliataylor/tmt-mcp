import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ACTIONS } from '../src/triggers.mjs';
import { loadConfig } from './config.mjs';
import { ensureCredentialProxy, proxyUrl, registerGrant, revokeGrant, runnerSecrets } from './cred-proxy-host.mjs';
import { directNoProxy, egressOptionsFrom } from './egress.mjs';
import { assertNoLeak, leakNeedles } from './leak.mjs';
import { githubMcpEnv } from './mcp.mjs';
import { createQueueClient } from './queue-client.mjs';
import { createStore } from './state.mjs';
import { createGithubClient } from './github.mjs';
import { createNeonClient } from './neon.mjs';
import { paneRunLogArgv, resolveHerdrSurface, workspaceLabelFor } from './herdr.mjs';
import { buildPrompt } from './prompt.mjs';
import { extractPlanSummary, isPlanAction, planBranchLink, renderPlanComment } from './plan.mjs';
import { resolvePosthogRunnerEnv } from './posthog.mjs';
import { awaitPreviews, renderPreviewComment } from './preview.mjs';
import {
  buildRunArgs,
  containerNameFor,
  createDocker,
  homeVolumeFor,
  modulesVolumeFor,
  npmCacheVolumeFor,
} from './runner.mjs';
import {
  assertPlanPathTracked,
  commitPlanRevision,
  createStartCommit,
  ensureWorkdir,
  planFileExists,
  prepareClone,
  readHeadSha,
  readPushedSha,
  renderPlanScaffold,
  resolvePlanRelativePath,
  restoreGitMetadata,
  setCommitIdentity,
  snapshotGitMetadata,
  writePlanScaffold,
} from './repo.mjs';
import {
  createTaskDir,
  readLogTail,
  readResult,
  sanitizeText,
  shredSecrets,
  writeEnvLocal,
  writeManifest,
  writePrompt,
  writeSecrets,
} from './taskdir.mjs';

const logger = console;

/**
 * Boot checks. Every one of these fails loudly with a specific message, because the alternative is
 * a daemon that polls happily and only breaks on the first real task.
 */
async function bootChecks(ctx) {
  const { config, queue, docker, herdrAvailable } = ctx;

  const missing = ['AGENT_POLL_SECRET', 'GITHUB_TOKEN', 'CURSOR_API_KEY'].filter(
    (name) => !config.secrets[name]
  );
  if (missing.length) {
    throw new Error(
      `Missing required secret(s): ${missing.join(', ')}. Set them in .env.orchestrator, or ` +
        'enable SECRETS_FROM_KEYCHAIN=true to read them from the macOS Keychain.'
    );
  }

  const needsNeon = [...config.projects.values()].some((p) => p.neon);
  if (needsNeon && !config.secrets.NEON_API_KEY) {
    const slugs = [...config.projects.values()].filter((p) => p.neon).map((p) => p.slug);
    throw new Error(
      `NEON_API_KEY is required because these projects declare a neon block: ${slugs.join(', ')}`
    );
  }

  if (!config.projects.size) {
    throw new Error(
      'No projects are registered. Copy config/projects.example.json to config/projects.json.'
    );
  }

  let health;
  try {
    health = await queue.health();
  } catch (err) {
    throw new Error(
      `Cannot reach the queue control listener at ${queue.describe()}: ${err.message}. ` +
        'Is the stack up (docker compose -f docker-compose.dev.yml up) and is the control port ' +
        'published to 127.0.0.1?'
    );
  }
  logger.log(
    `[Boot] queue ok at ${queue.describe()} (sqlite ${health.sqlite_version}, ${health.journal_mode})`
  );

  if (!(await docker.available())) {
    throw new Error('`docker info` failed. Is Docker Desktop running?');
  }

  if (!(await docker.imageExists(config.runner.image))) {
    throw new Error(
      `Runner image "${config.runner.image}" is not built. Run: ` +
        `docker build -f docker/agent-runner.Dockerfile -t ${config.runner.image} .`
    );
  }

  // Runners are started with `docker run`, not compose, so the isolated network may not exist yet.
  // The credential proxy joins that network before the egress rules, which name its address.
  await docker.ensureNetwork(config.runner.network);
  ctx.proxy = await ensureCredentialProxy({
    docker,
    image: config.runner.image,
    network: config.runner.network,
    token: config.secrets.GITHUB_TOKEN,
    workdir: config.paths.workdir,
    dryRun: config.dryRun,
    logger,
  });
  const egress = await docker.ensureEgress({
    ...egressOptionsFrom(config),
    sidecarIp: ctx.proxy.sidecarIp,
  });
  ctx.gatewayIp = egress.gateway;

  logger.log(
    `[Boot] herdr ${herdrAvailable ? 'available' : 'unavailable (containers will run detached)'}`
  );
  logger.log(`[Boot] projects: ${config.slugs().join(', ')}`);
  logger.log(`[Boot] workdir: ${config.paths.workdir}`);
  logger.log(
    `[Boot] node_modules: ${config.runner.modulesTmpfs ? 'tmpfs (per task)' : 'named Docker volume'}`
  );
}

function issueEnvValues({ context, branch, prNumber, neonInfo }) {
  return {
    DATABASE_URL: neonInfo?.databaseUrl || null,
    DATABASE_URL_UNPOOLED: neonInfo?.databaseUrlUnpooled || null,
    GITHUB_ISSUE_NUMBER: String(context.issue.number),
    GITHUB_ISSUE_URL: context.issue.url,
    AGENT_BRANCH: branch,
    ...(prNumber ? { AGENT_PR_NUMBER: String(prNumber) } : {}),
  };
}

/**
 * Run one task end to end.
 *
 * Ordered so anything that can fail cheaply fails before anything expensive is provisioned, and so
 * a failure before the PR exists leaves no Neon branch that no PR-close event will ever collect.
 */
async function handleTask(ctx, task) {
  const { config, queue, store, docker, herdr, herdrAvailable } = ctx;
  const slug = task.project_slug;
  const issueNumber = task.github_issue_number;
  const context = task.context;
  const label = `${slug} #${issueNumber}`;

  const project = config.project(slug);
  if (!project) {
    await queue.fail(
      task.id,
      `Project "${slug}" is in the queue registry but has no orchestrator config entry.`
    );
    return;
  }

  const prior = store.get(slug, issueNumber) || {};
  const containerName = containerNameFor({ slug, issueNumber, taskId: task.id });

  // Triage only reads the tree and writes labels and one comment, so it skips everything that
  // exists to support code: no task branch, no start commit, no PR, no database branch, no
  // .env.local. An issue that later gets planned or executed still gets all of that then.
  const triage = task.action === ACTIONS.TRIAGE;
  const planning = isPlanAction(task.action);
  const planPath = triage ? null : resolvePlanRelativePath(project, issueNumber);

  const paths = createTaskDir({
    tasksDir: config.paths.tasks,
    slug,
    issueNumber,
    taskId: task.id,
  });

  let neonInfo = null;
  let neonCreatedHere = false;
  let prNumber = prior.pr_number || null;
  let workspaceId = null;
  let clonePath = null;
  let gitMetaDir = null;
  let succeeded = false;
  let releaseGrant = async () => {};
  const canary = `tmt-canary-${randomBytes(16).toString('hex')}`;
  const needles = leakNeedles({ secrets: config.secrets, canary });

  const stopHeartbeat = startHeartbeat(ctx, task, containerName, label);

  try {
    writeManifest(paths, context);

    const clone = await prepareClone({
      mirrorsDir: config.paths.mirrors,
      clonesDir: config.paths.clones,
      slug,
      fetchUrl: project.fetch_url,
      pushUrl: project.push_url,
      localPath: project.local_path,
      issueNumber,
      taskId: task.id,
      defaultBranch: project.default_branch,
      readOnly: triage,
      logger,
    });
    clonePath = clone.clonePath;

    const [owner, repoName] = project.repo.split('/');
    const gh = createGithubClient({ token: config.secrets.GITHUB_TOKEN, logger });
    let pr = null;
    let headBefore = null;
    let planExists = false;

    if (!triage) {
      // The fallback address is deliberately undeliverable, but Vercel rejects a deployment whose
      // commit author it cannot resolve to an account. Any project with preview deploys must set
      // GIT_AUTHOR_EMAIL to a real address verified on the agent's GitHub account.
      await setCommitIdentity({
        clonePath,
        name: process.env.GIT_AUTHOR_NAME || 'tmt agent',
        email: process.env.GIT_AUTHOR_EMAIL || 'agent@tmt.local',
      });

      const scaffold = renderPlanScaffold({
        issue: issueNumber,
        issue_title: context.issue.title,
        issue_url: context.issue.url,
        task_id: task.id,
        created_at: new Date().toISOString(),
      });

      // The branch's first commit adds the plan scaffold, whichever mode started the work. It is
      // also what makes a draft PR legal: GitHub rejects a PR with no commits between base and head.
      if (!clone.resume) {
        await createStartCommit({
          clonePath,
          issueNumber,
          branch: clone.branch,
          planPath,
          scaffold,
          logger,
        });
      } else if (planning && !planFileExists({ clonePath, planPath })) {
        // A branch from before plan files existed. The scaffold lands with this run's revision.
        writePlanScaffold({ clonePath, planPath, content: scaffold });
        await assertPlanPathTracked(clonePath, planPath);
      }
      planExists = planFileExists({ clonePath, planPath });
      headBefore = await readHeadSha(clonePath);

      const planLink = planBranchLink({ owner, repo: repoName, branch: clone.branch, planPath });
      const ensured = await gh.ensurePullRequest({
        owner,
        repo: repoName,
        branch: clone.branch,
        base: clone.defaultBranch,
        title: `${context.issue.title} (#${issueNumber})`,
        body:
          `Automated work for #${issueNumber}.\n\n` +
          `Plan: [\`${planPath}\`](${planLink}) — every plan run is its own commit, linked from the issue.\n\n` +
          `Branch \`${clone.branch}\`, driven by the local agent orchestrator.\n` +
          'Closing this PR also releases the ephemeral database branch.',
      });
      pr = ensured.pr;
      prNumber = pr.number;
      store.merge(slug, issueNumber, { pr_number: prNumber, pr_url: pr.html_url });

      if (ensured.created) {
        await gh.commentOnIssue({
          owner,
          repo: repoName,
          issueNumber,
          body:
            `Picked this up locally. Working on \`${clone.branch}\`, tracking in #${prNumber}.\n\n` +
            `The plan lives in [\`${planPath}\`](${planLink}). I will link each revision here.`,
        });
      }

      if (project.neon) {
        const neon = createNeonClient({ apiKey: config.secrets.NEON_API_KEY, logger });
        neonInfo = await neon.ensureBranch({
          projectId: project.neon.project_id,
          parentBranch: project.neon.parent_branch,
          issueNumber,
          initSource: project.neon.init_source,
        });
        neonCreatedHere = neonInfo.created;
        store.merge(slug, issueNumber, { neon_branch_id: neonInfo.branchId });
      }

      // Refuses unless git already ignores .env.local, so the agent cannot commit a live database
      // URL.
      await writeEnvLocal({
        clonePath,
        template: project.env_template,
        values: issueEnvValues({ context, branch: clone.branch, prNumber, neonInfo }),
      });
    }

    writePrompt(
      paths,
      buildPrompt({
        context,
        branch: clone.branch,
        prNumber,
        prUrl: pr?.html_url || null,
        action: task.action,
        taskId: task.id,
        neon: neonInfo,
        planPath,
        planExists,
        canary,
      })
    );

    // Runner credentials only. The GitHub token stays in the credential proxy; this file gets a
    // per-task grant in the proxy URL, which is useless off the runner network. writeSecrets
    // hard-fails on the Neon key and the queue token. PostHog is optional (see posthog.mjs).
    const grant = randomBytes(32).toString('hex');
    const egressOpts = egressOptionsFrom(config);
    if (ctx.proxy?.adminSecret) {
      if (!ctx.proxy.sidecarIp) throw new Error('credential proxy has no address');
      await registerGrant({
        adminPort: ctx.proxy.adminPort,
        adminSecret: ctx.proxy.adminSecret,
        grant,
        owner,
        repo: repoName,
      });
      releaseGrant = () =>
        revokeGrant({
          adminPort: ctx.proxy.adminPort,
          adminSecret: ctx.proxy.adminSecret,
          grant,
        }).catch((err) => {
          logger.warn(`[Task] ${label} could not revoke the proxy grant: ${err.message}`);
        });
    }
    writeSecrets(
      paths,
      runnerSecrets({
        cursorApiKey: config.secrets.CURSOR_API_KEY,
        proxyUrl: proxyUrl({
          host: ctx.proxy?.sidecarIp || '127.0.0.1',
          port: ctx.proxy?.proxyPort,
          grant,
        }),
        noProxy: directNoProxy({ posthog: egressOpts.posthog, extra: egressOpts.extraHosts }),
        posthogEnv: resolvePosthogRunnerEnv({ project, secrets: config.secrets }),
      })
    );

    const runArgs = buildRunArgs({
      image: config.runner.image,
      network: config.runner.network,
      containerName,
      clonePath,
      taskDir: paths.dir,
      outDir: paths.outDir,
      secretsFile: paths.secretsEnv,
      homeVolume: homeVolumeFor({ slug, issueNumber }),
      npmCacheVolume: npmCacheVolumeFor({ slug }),
      modulesVolume: modulesVolumeFor({ slug }),
      modulesTmpfs: config.runner.modulesTmpfs,
      memory: config.runner.memory,
      cpus: config.runner.cpus,
      pidsLimit: config.runner.pidsLimit,
      noExecTmp: config.runner.noExecTmp,
      env: {
        TASK_ID: task.id,
        AGENT_MODEL: project.agent.model,
        SETUP_CMD: project.agent.setup_cmd,
        CHAT_ID: prior.chat_id,
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'tmt agent',
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'agent@tmt.local',
        ...githubMcpEnv(task.action),
      },
      gatewayIp: ctx.gatewayIp,
      caCert: ctx.proxy?.caCert,
      labels: { project: slug, issue: String(issueNumber), 'task-id': task.id },
      // Always detached: herdr pane run only submits Enter in the pane and returns immediately.
      detach: true,
    });

    if (herdrAvailable) {
      const ws = await herdr.createWorkspace({
        cwd: clonePath,
        label: workspaceLabelFor({ slug, issueNumber, title: context.issue.title }),
      });
      workspaceId = ws.workspaceId;
      store.merge(slug, issueNumber, { herdr_workspace_id: workspaceId });
      // Touch before the pane tails so Herdr/nvm startup cannot miss a short-lived container.
      writeFileSync(paths.runLog, '', { flag: 'a' });
      await herdr.runInPane({
        paneId: ws.paneId,
        argv: paneRunLogArgv(paths.runLog),
      });
    }
    gitMetaDir = join(paths.dir, 'git-meta');
    snapshotGitMetadata(clonePath, gitMetaDir);

    await docker.start(runArgs);

    logger.log(`[Task] ${label} running as ${containerName}`);

    const exitCode = await waitForContainer(ctx, containerName, label);
    // Before any host git: the container can rewrite .git/config and hooks, and those run as us.
    restoreGitMetadata(clonePath, gitMetaDir);
    const result = readResult(paths);

    succeeded = result.valid ? result.exitCode === 0 : exitCode === 0;

    if (result.chatId && result.chatId !== prior.chat_id) {
      store.merge(slug, issueNumber, { chat_id: result.chatId });
    }
    store.merge(slug, issueNumber, {
      clone_path: clonePath,
      last_task_id: task.id,
      last_exit_code: result.valid ? result.exitCode : exitCode,
    });

    let planFailure = null;
    if (succeeded && planning) {
      try {
        await publishPlanRevision({
          gh,
          owner,
          repo: repoName,
          issueNumber,
          clonePath,
          planPath,
          branch: clone.branch,
          headBefore,
          taskId: task.id,
          label,
          needles,
        });
      } catch (err) {
        planFailure = `plan revision could not be published: ${err.message}`;
        logger.error(`[Task] ${label} ${planFailure}`);
        succeeded = false;
      }
    }

    if (planFailure) {
      await queue.fail(task.id, sanitizeText(planFailure, 2000));
    } else if (succeeded) {
      // Before completing, so the lease and its heartbeat still cover the wait on the build.
      await commentPreviewUrl(ctx, {
        gh,
        owner,
        repo: repoName,
        issueNumber,
        branch: clone.branch,
        clonePath,
        action: task.action,
        label,
        needles,
      });
      await queue.complete(task.id);
      logger.log(`[Task] ${label} completed`);
    } else {
      await queue.fail(task.id, describeFailure({ result, exitCode, paths }));
      logger.warn(`[Task] ${label} failed`);
    }
  } catch (err) {
    // Any stage throwing lands here, including the .env.local guard and the secrets assertion.
    logger.error(`[Task] ${label} error: ${err.message}`);
    await queue.fail(task.id, sanitizeText(`orchestrator error: ${err.message}`, 2000));

    // A Neon branch created during a run that never reached a PR has nothing to clean it up later,
    // so it gets removed here rather than left orphaned.
    if (neonCreatedHere && !prNumber && project.neon) {
      try {
        const neon = createNeonClient({ apiKey: config.secrets.NEON_API_KEY, logger });
        await neon.deleteBranch({
          projectId: project.neon.project_id,
          branchId: neonInfo?.branchId,
        });
      } catch (cleanupErr) {
        logger.warn(`[Task] ${label} could not delete orphan Neon branch: ${cleanupErr.message}`);
      }
    }
  } finally {
    await releaseGrant();
    stopHeartbeat();
    // The secrets file is shredded on every exit path, successful or not.
    shredSecrets(paths);
    await cleanupArtifacts(ctx, {
      label,
      containerName,
      clonePath,
      workspaceId,
      taskDir: paths.dir,
      succeeded,
    });
  }
}

/**
 * Commit the agent's plan edit as its own revision and link it from the issue.
 *
 * The orchestrator does this rather than the agent so that every plan run is guaranteed to leave
 * exactly one commit touching only the plan file, and a comment that points at that exact version.
 */
async function publishPlanRevision({
  gh,
  owner,
  repo,
  issueNumber,
  clonePath,
  planPath,
  branch,
  headBefore,
  taskId,
  label,
  needles,
}) {
  let planText = null;
  try {
    planText = readFileSync(join(clonePath, planPath), 'utf8');
  } catch {
    planText = null;
  }
  if (planText !== null) assertNoLeak(planText, needles);

  const revision = await commitPlanRevision({
    clonePath,
    planPath,
    issueNumber,
    taskId,
    branch,
    headBefore,
    logger,
  });

  let summary = null;
  try {
    summary = extractPlanSummary(readFileSync(join(clonePath, planPath), 'utf8'));
  } catch {
    // A missing plan file just means there is no summary line to quote.
  }

  const body = renderPlanComment({ owner, repo, planPath, summary, ...revision });
  if (!body) {
    throw new Error(`${planPath} has never been committed and the agent did not write it`);
  }
  assertNoLeak(body, needles);
  await gh.commentOnIssue({ owner, repo, issueNumber, body });
  logger.log(
    `[Task] ${label} ${revision.changed ? `linked plan revision ${revision.revision}` : 'plan unchanged; commented'}`
  );
}

/**
 * Comment the preview URL for whatever the agent just pushed.
 *
 * Execute tasks only: a plan task pushes nothing but the plan file, so its deployment is a preview of
 * the base branch and tells nobody anything. Silent when the repo has no hosting integration
 * reporting deployments to GitHub.
 */
async function commentPreviewUrl(ctx, { gh, owner, repo, issueNumber, branch, clonePath, action, label, needles }) {
  const { preview } = ctx.config;
  if (!preview.enabled || action !== ACTIONS.EXECUTE) return;

  try {
    const sha = await readPushedSha({ clonePath, branch });
    if (!sha) {
      logger.warn(`[Task] ${label} could not read the pushed commit; skipping the preview comment`);
      return;
    }

    const previews = await awaitPreviews({
      gh,
      owner,
      repo,
      sha,
      graceMs: preview.graceMs,
      timeoutMs: preview.timeoutMs,
      intervalMs: preview.intervalMs,
    });

    const body = renderPreviewComment({ previews, branch, sha });
    if (!body) {
      logger.log(`[Task] ${label} no deployment reported for ${sha.slice(0, 7)}`);
      return;
    }

    assertNoLeak(body, needles);
    await gh.commentOnIssue({ owner, repo, issueNumber, body });
    logger.log(`[Task] ${label} commented ${previews.length} preview URL(s)`);
  } catch (err) {
    // The work is already pushed and the task already succeeded. A hosting integration being slow,
    // absent, or rate-limited is not a reason to report that back as a failed task.
    logger.warn(`[Task] ${label} could not comment the preview URL: ${err.message}`);
  }
}

function describeFailure({ result, exitCode, paths }) {
  const tail = readLogTail(paths, 4000);
  const header = result.valid
    ? `agent exited ${result.exitCode}${result.reason ? ` (${result.reason})` : ''}`
    : result.present
      ? `runner result was unusable: ${result.reason}`
      : `runner produced no result.json (container exit ${exitCode ?? 'unknown'})`;
  return sanitizeText(tail ? `${header}\n\n--- log tail ---\n${tail}` : header, 8000);
}

/**
 * Holds the lease while the container runs, and doubles as the cancellation watch: a heartbeat that
 * comes back "not applied" means the row left processing, which is how a closed issue or an expired
 * lease reaches a container that is still working.
 */
function startHeartbeat(ctx, task, containerName, label) {
  const intervalMs = Math.max(ctx.config.task.heartbeatSeconds, 5) * 1000;

  const timer = setInterval(async () => {
    try {
      const { applied } = await ctx.queue.heartbeat(task.id);
      if (applied) return;

      logger.warn(`[Task] ${label} is no longer processing upstream; stopping ${containerName}`);
      clearInterval(timer);
      await ctx.docker.stop(containerName);
    } catch (err) {
      logger.warn(`[Task] ${label} heartbeat failed: ${err.message}`);
    }
  }, intervalMs);

  return () => clearInterval(timer);
}

/** Waits for the container, stopping it if it outlives TASK_TIMEOUT_MS. */
async function waitForContainer(ctx, containerName, label) {
  const timeoutMs = ctx.config.task.timeoutMs;
  let timer;

  const timeout = new Promise((resolvePromise) => {
    timer = setTimeout(async () => {
      logger.warn(`[Task] ${label} exceeded ${timeoutMs}ms; stopping ${containerName}`);
      // The entrypoint's SIGTERM trap writes result.json before the stop timeout elapses.
      await ctx.docker.stop(containerName);
      resolvePromise(null);
    }, timeoutMs);
  });

  try {
    return await Promise.race([ctx.docker.wait(containerName), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function cleanupArtifacts(ctx, { label, containerName, clonePath, workspaceId, taskDir, succeeded }) {
  const policy = ctx.config.task.keepArtifacts;
  const keep = policy === 'always' || (policy === 'on-failure' && !succeeded);

  await ctx.docker.remove(containerName);

  if (keep) {
    logger.log(`[Task] ${label} artifacts kept at ${clonePath || taskDir}`);
    return;
  }

  for (const path of [clonePath, taskDir]) {
    if (!path) continue;
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (err) {
      logger.warn(`[Task] ${label} could not remove ${path}: ${err.message}`);
    }
  }
  if (workspaceId && ctx.herdrAvailable) await ctx.herdr.closeWorkspace(workspaceId);
}

/**
 * Self-scheduling poll loop.
 *
 * A bare setInterval over an async function would overlap runs whenever a poll outlasts the
 * interval. This waits for each cycle, and stops asking for work while the in-flight cap is full.
 */
function startPolling(ctx) {
  const { intervalMs, jitterMs, maxConcurrent, worker } = ctx.config.poll;
  let inFlight = 0;
  let stopped = false;
  let timer = null;

  async function cycle() {
    if (stopped) return;

    try {
      while (!stopped && inFlight < maxConcurrent) {
        const task = await ctx.queue.poll({ worker, projectSlugs: ctx.config.slugs() });
        if (!task) break;

        inFlight += 1;
        logger.log(
          `[Poll] leased ${task.project_slug} #${task.github_issue_number} ` +
            `(${task.action}, attempt ${task.attempts}) — ${inFlight}/${maxConcurrent} in flight`
        );

        // Deliberately not awaited: tasks run concurrently up to the cap.
        handleTask(ctx, task)
          .catch((err) => logger.error(`[Task] unhandled: ${err.message}`))
          .finally(() => {
            inFlight -= 1;
          });
      }
    } catch (err) {
      logger.warn(`[Poll] ${err.message}`);
    }

    if (stopped) return;
    timer = setTimeout(cycle, intervalMs + Math.floor(Math.random() * jitterMs));
  }

  cycle();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    get inFlight() {
      return inFlight;
    },
  };
}

export async function main() {
  const config = loadConfig();
  ensureWorkdir(config.paths);

  const queue = createQueueClient({
    host: config.queue.host,
    port: config.queue.port,
    socketPath: config.queue.socketPath,
    timeoutMs: config.queue.timeoutMs,
    token: config.secrets.AGENT_POLL_SECRET,
  });

  const docker = createDocker({ logger, dryRun: config.dryRun });
  const { herdr, available: herdrAvailable } = await resolveHerdrSurface({
    bin: config.herdr.bin,
    required: config.herdr.required,
    logger,
    dryRun: config.dryRun,
  });

  const ctx = {
    config,
    queue,
    docker,
    herdr,
    herdrAvailable,
    store: createStore(config.paths.state),
  };

  await bootChecks(ctx);

  const poller = startPolling(ctx);
  logger.log(
    `[Orchestrator] polling every ${config.poll.intervalMs}ms, up to ` +
      `${config.poll.maxConcurrent} concurrent task(s)`
  );

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(
      `[Orchestrator] shutting down; ${poller.inFlight} task(s) still in flight will finish ` +
        'and report their own result.'
    );
    poller.stop();
    // Leases keep running containers alive; the reaper requeues anything that dies unreported.
    setTimeout(() => process.exit(0), 1000).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  main().catch((err) => {
    logger.error(`[Orchestrator] ${err.message}`);
    process.exit(1);
  });
}
