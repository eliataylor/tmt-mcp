import express from 'express';
import { pathToFileURL } from 'node:url';

import { openDatabase, databaseInfo, DEFAULT_DB_PATH } from './db.mjs';
import { loadRegistry } from './projects.mjs';
import { peekRepoFullName, requireBearer, resolveWebhookSecret, verifySignature } from './auth.mjs';
import { classify } from './triggers.mjs';
import { buildContext } from './context.mjs';
import * as queue from './queue.mjs';
import { announceWebhookUrl } from './tunnel.mjs';

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    dbPath: env.DB_PATH || DEFAULT_DB_PATH,
    pollSecret: env.AGENT_POLL_SECRET || '',
    leaseSeconds: Number(env.LEASE_SECONDS || 1800),
    maxAttempts: Number(env.MAX_ATTEMPTS || 3),
    backoffSeconds: Number(env.RETRY_BACKOFF_SECONDS || 60),
    reaperIntervalSeconds: Number(env.REAPER_INTERVAL_SECONDS || 30),
    tunnelMetricsUrl: env.TUNNEL_METRICS_URL || '',
  };
}

function timestamp() {
  return new Date().toISOString();
}

export function createLogger(scope = 'Server', sink = console) {
  return {
    info: (msg) => sink.log(`${timestamp()} [${scope}] ${msg}`),
    warn: (msg) => sink.warn(`${timestamp()} [${scope}] ${msg}`),
    error: (msg) => sink.error(`${timestamp()} [${scope}] ${msg}`),
  };
}

export function createApp({ db, registry, config, log = createLogger() }) {
  const app = express();
  app.disable('x-powered-by');

  // Keep the untouched bytes. The HMAC must be computed over exactly what GitHub sent;
  // re-serializing the parsed object does not reproduce them.
  app.use(
    express.json({
      limit: '10mb',
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  // ---------------------------------------------------------------- webhook

  app.post('/api/agent/webhook', (req, res) => {
    const event = req.get('x-github-event') || 'unknown';
    const deliveryId = req.get('x-github-delivery') || null;
    const rawBody = req.rawBody;

    if (!Buffer.isBuffer(rawBody)) {
      return res.status(400).json({ error: 'Missing request body' });
    }

    // Peek at the repo only to choose which secret to check against. Nothing from the
    // payload is acted on until the signature verifies below.
    const repoFullName = peekRepoFullName(rawBody);
    const project = registry.byRepo(repoFullName);
    const { secret, source, missing } = resolveWebhookSecret(project);

    if (missing || !secret) {
      log.error(`No webhook secret available (${source}) for ${repoFullName || 'unknown repo'}`);
      return res.status(503).json({ error: `Webhook secret ${source} is not configured` });
    }

    if (!verifySignature(rawBody, req.get('x-hub-signature-256'), secret)) {
      log.warn(`Rejected delivery ${deliveryId || '(no id)'} for ${repoFullName || 'unknown repo'}: bad signature`);
      return res.status(401).json({ error: 'Invalid HMAC signature' });
    }

    if (event === 'ping') {
      return res.json({ ok: true, pong: true, project_slug: project?.slug ?? null });
    }

    if (!project) {
      // Signed correctly but the repo is not in the registry. Ack so GitHub stops, and log
      // it loudly because it is almost always a missing projects.json entry.
      log.warn(
        `Unregistered repository "${repoFullName}". Add it to ${registry.configPath}` +
          (registry.scopedSlug ? ` (this instance is pinned to "${registry.scopedSlug}")` : '')
      );
      return res.status(202).json({ ok: true, ignored: true, reason: 'unregistered repository' });
    }

    const payload = req.body;
    const verdict = classify({ event, payload, project });

    if (verdict.kind === 'ignore') {
      return res.json({ ok: true, ignored: true, reason: verdict.reason });
    }

    if (verdict.kind === 'cancel') {
      const cancelled = queue.cancelPending(db, {
        projectSlug: project.slug,
        issueNumber: payload.issue?.number,
        reason: verdict.reason,
      });
      if (cancelled.length) {
        log.info(
          `Cancelled ${cancelled.length} pending task(s) for ${project.slug} #${payload.issue?.number}: ${verdict.reason}`
        );
      }
      return res.json({ ok: true, cancelled, reason: verdict.reason });
    }

    const context = buildContext({
      event,
      action: verdict.action,
      payload,
      project,
      deliveryId,
      deliveredAt: timestamp(),
    });

    const { task, duplicate } = queue.enqueue(db, {
      deliveryId,
      project,
      payload,
      context,
      action: verdict.action,
      maxAttempts: config.maxAttempts,
    });

    if (duplicate) {
      log.info(`Duplicate delivery ${deliveryId} ignored (task ${task?.id})`);
      return res.json({ ok: true, duplicate: true, task_id: task?.id ?? null });
    }

    log.info(
      `Queued ${verdict.action} for ${project.slug} (${repoFullName}) issue #${payload.issue?.number} -> ${task.id}`
    );
    return res.status(201).json({
      ok: true,
      duplicate: false,
      task_id: task.id,
      project_slug: project.slug,
      action: verdict.action,
    });
  });

  // ---------------------------------------------------------------- orchestrator

  const guard = requireBearer(() => config.pollSecret);

  app.post('/api/agent/poll', guard, (req, res) => {
    const body = req.body || {};

    let projectSlugs = [];
    if (registry.scopedSlug) {
      // Isolated mode: the instance decides, not the caller.
      projectSlugs = [registry.scopedSlug];
    } else if (Array.isArray(body.project_slugs)) {
      projectSlugs = body.project_slugs;
    } else if (body.project_slug) {
      projectSlugs = [body.project_slug];
    }

    const task = queue.claim(db, {
      worker: body.worker || 'orchestrator',
      projectSlugs,
      leaseSeconds: Number(body.lease_seconds) || config.leaseSeconds,
    });

    if (task) {
      log.info(`Leased ${task.id} (${task.project_slug} #${task.github_issue_number}) to ${task.locked_by}`);
    }
    return res.json({ task: task || null });
  });

  app.post('/api/agent/tasks/:id/complete', guard, (req, res) => {
    const task = queue.complete(db, req.params.id);
    if (!task) return res.status(409).json(notProcessing(db, req.params.id));
    log.info(`Completed ${task.id}`);
    return res.json({ ok: true, task });
  });

  app.post('/api/agent/tasks/:id/fail', guard, (req, res) => {
    const error = (req.body || {}).error ?? null;
    const task = queue.fail(db, req.params.id, error, { backoffSeconds: config.backoffSeconds });
    if (!task) return res.status(409).json(notProcessing(db, req.params.id));
    log.warn(
      `Failed ${task.id} (attempt ${task.attempts}/${task.max_attempts}) -> ${task.status}` +
        (task.status === 'pending' ? `, retry at ${task.available_at}` : '')
    );
    return res.json({ ok: true, task });
  });

  app.post('/api/agent/tasks/:id/heartbeat', guard, (req, res) => {
    const leaseSeconds = Number((req.body || {}).lease_seconds) || config.leaseSeconds;
    const task = queue.heartbeat(db, req.params.id, leaseSeconds);
    if (!task) return res.status(409).json(notProcessing(db, req.params.id));
    return res.json({ ok: true, lease_expires_at: task.lease_expires_at });
  });

  app.get('/api/agent/tasks', guard, (req, res) => {
    const tasks = queue.listTasks(db, {
      status: req.query.status || null,
      projectSlug: registry.scopedSlug || req.query.project_slug || null,
      limit: req.query.limit,
    });
    return res.json({ tasks, count: tasks.length });
  });

  app.get('/api/agent/tasks/:id', guard, (req, res) => {
    const task = queue.getTask(db, req.params.id);
    if (!task) return res.status(404).json({ error: 'No such task' });
    return res.json({ task });
  });

  // ---------------------------------------------------------------- ops

  app.get('/api/health', (_req, res) => {
    return res.json({
      ok: true,
      ...databaseInfo(db),
      mode: registry.scopedSlug ? 'isolated' : 'shared',
      project_slug: registry.scopedSlug,
      projects: registry.slugs(),
      allow_unknown_repos: registry.allowUnknownRepos,
      registry_error: registry.loadError ? registry.loadError.message : null,
      tasks: queue.statusCounts(db),
    });
  });

  app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }));

  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) log.error(`Unhandled: ${err.stack || err.message}`);
    res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
  });

  return app;
}

/** Explain a 409 precisely: unknown id versus wrong status. */
function notProcessing(db, id) {
  const task = queue.getTask(db, id);
  if (!task) return { error: 'No such task' };
  return { error: `Task is "${task.status}", not "processing"`, status: task.status };
}

export function startReaper(db, { intervalSeconds, backoffSeconds }, log) {
  const timer = setInterval(() => {
    try {
      const reaped = queue.reap(db, { backoffSeconds });
      if (reaped.length) {
        const requeued = reaped.filter((r) => r.status === 'pending').length;
        log.warn(`Reaped ${reaped.length} expired lease(s): ${requeued} requeued, ${reaped.length - requeued} failed`);
      }
    } catch (err) {
      log.error(`Reaper error: ${err.message}`);
    }
  }, intervalSeconds * 1000);
  timer.unref();
  return timer;
}

export function main() {
  const log = createLogger();
  const config = loadConfig();

  if (!config.pollSecret) {
    log.error('AGENT_POLL_SECRET is not set. Generate one with: openssl rand -hex 32');
    process.exit(1);
  }

  const db = openDatabase(config.dbPath);
  const registry = loadRegistry();

  log.info(`SQLite ${databaseInfo(db).sqlite_version} at ${config.dbPath} (${databaseInfo(db).journal_mode})`);
  log.info(
    registry.scopedSlug
      ? `Isolated mode: serving only "${registry.scopedSlug}"`
      : `Shared mode: serving ${registry.slugs().length} project(s) [${registry.slugs().join(', ')}]`
  );

  const app = createApp({ db, registry, config, log });
  const reaper = startReaper(db, config, log);

  const server = app.listen(config.port, () => {
    log.info(`Listening on port ${config.port}`);
    announceWebhookUrl((msg) => log.info(msg), { metricsUrl: config.tunnelMetricsUrl });
  });

  process.on('SIGHUP', () => {
    try {
      const result = registry.reload();
      log.info(`Reloaded registry: ${result.ok ? `${result.count} project(s)` : result.error.message}`);
    } catch (err) {
      log.error(`Registry reload failed, keeping previous config: ${err.message}`);
    }
  });

  const shutdown = (signal) => {
    log.info(`${signal} received, shutting down`);
    clearInterval(reaper);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { app, server, db, registry };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
