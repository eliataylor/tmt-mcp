import { rmSync, writeFileSync } from 'node:fs';

import { loadConfig } from './config.mjs';
import { createQueueClient } from './queue-client.mjs';
import { createStore } from './state.mjs';
import { createGithubClient } from './github.mjs';
import { createNeonClient } from './neon.mjs';
import { paneRunLogArgv, resolveHerdrSurface, workspaceLabelFor } from './herdr.mjs';
import { buildPrompt } from './prompt.mjs';
import {
  buildRunArgs,
  containerNameFor,
  createDocker,
  homeVolumeFor,
  modulesVolumeFor,
  npmCacheVolumeFor,
} from './runner.mjs';
import {
  createStartCommit,
  ensureWorkdir,
  prepareClone,
  setCommitIdentity,
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
  await docker.ensureNetwork(config.runner.network);

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
  let succeeded = false;

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
      logger,
    });
    clonePath = clone.clonePath;

    await setCommitIdentity({
      clonePath,
      name: process.env.GIT_AUTHOR_NAME || 'tmt agent',
      email: process.env.GIT_AUTHOR_EMAIL || 'agent@tmt.local',
    });

    const [owner, repoName] = project.repo.split('/');
    const gh = createGithubClient({ token: config.secrets.GITHUB_TOKEN, logger });

    // An empty commit is what makes a draft PR legal: GitHub rejects a PR with no commits between
    // base and head, so pushing a branch identical to the default branch cannot open one.
    if (!clone.resume) {
      await createStartCommit({ clonePath, issueNumber, branch: clone.branch, logger });
    }

    const { pr, created } = await gh.ensurePullRequest({
      owner,
      repo: repoName,
      branch: clone.branch,
      base: clone.defaultBranch,
      title: `${context.issue.title} (#${issueNumber})`,
      body:
        `Automated work for #${issueNumber}.\n\n` +
        `Branch \`${clone.branch}\`, driven by the local agent orchestrator.\n` +
        'Closing this PR also releases the ephemeral database branch.',
    });
    prNumber = pr.number;
    store.merge(slug, issueNumber, { pr_number: prNumber, pr_url: pr.html_url });

    if (created) {
      await gh.commentOnIssue({
        owner,
        repo: repoName,
        issueNumber,
        body:
          `Picked this up locally. Working on \`${clone.branch}\`, tracking in #${prNumber}.\n\n` +
          'I will comment again with my understanding before making changes.',
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

    // Refuses unless git already ignores .env.local, so the agent cannot commit a live database URL.
    await writeEnvLocal({
      clonePath,
      template: project.env_template,
      values: issueEnvValues({ context, branch: clone.branch, prNumber, neonInfo }),
    });

    writePrompt(
      paths,
      buildPrompt({
        context,
        branch: clone.branch,
        prNumber,
        prUrl: pr.html_url,
        action: task.action,
        taskId: task.id,
      })
    );

    // Only the two credentials the runner genuinely needs. writeSecrets hard-fails on anything
    // from the forbidden list, so the Neon key and the queue token cannot leak in here.
    writeSecrets(paths, {
      GITHUB_TOKEN: config.secrets.GITHUB_TOKEN,
      CURSOR_API_KEY: config.secrets.CURSOR_API_KEY,
    });

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
      },
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
    await docker.start(runArgs);

    logger.log(`[Task] ${label} running as ${containerName}`);

    const exitCode = await waitForContainer(ctx, containerName, label);
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

    if (succeeded) {
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
