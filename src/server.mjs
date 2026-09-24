import crypto from 'node:crypto';
import express from 'express';
import { pathToFileURL } from 'node:url';

import { openDatabase, databaseInfo, DEFAULT_DB_PATH } from './db.mjs';
import { loadRegistry } from './projects.mjs';
import { peekRepoFullName, requireBearer, resolveWebhookSecret, verifySignature } from './auth.mjs';
import { handleDelivery } from './delivery.mjs';
import * as queue from './queue.mjs';
import { announceWebhookUrl } from './tunnel.mjs';
import { controlPlaneGuard, githubSourceGuard } from './net-guards.mjs';
import { createGithubMeta } from './github-meta.mjs';

export function loadConfig(env = process.env) {
  const controlPort = Number(env.CONTROL_PORT || 3001);
  return {
    port: Number(env.PORT || 3000),
    controlPort,
    // Inside the container both listeners bind 0.0.0.0. Reachability is decided by compose: the
    // webhook port is never published, and the control port is published to 127.0.0.1 only.
    bindAddress: env.BIND_ADDRESS || '0.0.0.0',
    controlAllowedHosts: (
      env.CONTROL_ALLOWED_HOSTS || `127.0.0.1:${controlPort},localhost:${controlPort}`
    )
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    controlRequireLoopbackPeer: env.CONTROL_REQUIRE_LOOPBACK_PEER === 'true',
    // 'enforce' (default) | 'warn' | 'off'. 'off' also skips the /meta fetch entirely.
    webhookIpCheck: ['warn', 'off', 'false'].includes(env.WEBHOOK_IP_CHECK)
      ? env.WEBHOOK_IP_CHECK === 'false'
        ? 'off'
        : env.WEBHOOK_IP_CHECK
      : 'enforce',
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

function baseApp(limit) {
  const app = express();
  app.disable('x-powered-by');

  // Keep the untouched bytes. The HMAC must be computed over exactly what GitHub sent;
  // re-serializing the parsed object does not reproduce them.
  app.use(
    express.json({
      limit,
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  return app;
}

// ---------------------------------------------------------------- webhook

function mountWebhookRoutes(app, { db, registry, config, log }) {
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

    const result = handleDelivery({
      db,
      registry,
      config,
      log,
      event,
      payload: req.body,
      deliveryId,
      deliveredAt: timestamp(),
    });
    return res.status(result.status).json(result.body);
  });

  return app;
}

// ---------------------------------------------------------------- orchestrator

function mountControlRoutes(app, { db, registry, config, log }) {
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

  /**
   * Re-queue a delivery without GitHub HMAC — for recovery after tunnel outages.
   * Body: { "event": "issues", "payload": { ... }, "delivery_id": "optional" }
   */
  app.post('/api/agent/ingest', guard, (req, res) => {
    const body = req.body || {};
    const event = body.event;
    const payload = body.payload;
    if (!event || typeof event !== 'string') {
      return res.status(400).json({ error: 'event is required' });
    }
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'payload is required' });
    }
    const deliveryId =
      body.delivery_id ||
      body.deliveryId ||
      `reconcile-${crypto.randomUUID?.() ?? Date.now()}`;
    const result = handleDelivery({
      db,
      registry,
      config,
      log,
      event,
      payload,
      deliveryId,
      deliveredAt: timestamp(),
    });
    return res.status(result.status).json(result.body);
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

  return app;
}

function mountFallbacks(app, log) {
  app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }));

  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) log.error(`Unhandled: ${err.stack || err.message}`);
    res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
  });

  return app;
}

/**
 * The tunnel-facing app. Mounts only the webhook route, so the public quick-tunnel hostname
 * exposes nothing else.
 *
 * `cloudflared tunnel --url http://webhook-server:3000` proxies every path it can reach, so with a
 * single combined app the orchestrator's endpoints would be live on a public trycloudflare.com
 * hostname — brute-forceable, unrate-limited, and with /api/health handing a scanner the SQLite
 * version and task counts. Those subdomains do get scanned; the random name is not secret-grade.
 */
export function createWebhookApp({ db, registry, config, log = createLogger('Webhook'), meta = null }) {
  const app = baseApp('10mb');
  if (meta && config.webhookIpCheck !== 'off') {
    app.use(githubSourceGuard(meta, { mode: config.webhookIpCheck, logger: log }));
  }
  mountWebhookRoutes(app, { db, registry, config, log });
  return mountFallbacks(app, log);
}

/**
 * The orchestrator-facing app: everything the daemon uses, on a listener the tunnel cannot reach
 * and a browser cannot address. See src/net-guards.mjs for why the header checks are enough.
 */
export function createControlApp({ db, registry, config, log = createLogger('Control') }) {
  const app = baseApp('1mb');
  if (config.controlAllowedHosts?.length) {
    app.use(
      controlPlaneGuard({
        allowedHosts: config.controlAllowedHosts,
        requireLoopbackPeer: config.controlRequireLoopbackPeer,
        logger: log,
      })
    );
  }
  mountControlRoutes(app, { db, registry, config, log });
  return mountFallbacks(app, log);
}

/**
 * Both surfaces on one app. Used by the tests and by anyone running the server directly on the
 * host; the split listeners in main() are what production uses.
 */
export function createApp({ db, registry, config, log = createLogger() }) {
  const app = baseApp('10mb');
  mountWebhookRoutes(app, { db, registry, config, log });
  mountControlRoutes(app, { db, registry, config, log });
  return mountFallbacks(app, log);
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

export async function main() {
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

  // Source-IP verification is defense in depth behind the HMAC. A failure to load the ranges is
  // logged and skipped rather than dropping every delivery.
  let meta = null;
  let metaRefresher = null;
  if (config.webhookIpCheck === 'off') {
    log.info('Source-IP verification disabled (WEBHOOK_IP_CHECK); HMAC only');
  } else {
    meta = createGithubMeta();
    const metaResult = await meta.refresh();
    log.info(
      metaResult.ok
        ? `Loaded ${metaResult.count} GitHub hooks CIDR range(s)`
        : `Could not load GitHub hooks ranges (${metaResult.error.message}); source-IP checks skipped`
    );
    metaRefresher = setInterval(() => meta.refresh(), 6 * 60 * 60 * 1000);
    metaRefresher.unref();
  }

  const webhookApp = createWebhookApp({ db, registry, config, log: createLogger('Webhook'), meta });
  const controlApp = createControlApp({ db, registry, config, log: createLogger('Control') });
  const reaper = startReaper(db, config, log);

  const server = webhookApp.listen(config.port, config.bindAddress, () => {
    // Never published to the host; only cloudflared on agent-net reaches this.
    log.info(`Webhook listener on ${config.bindAddress}:${config.port} (tunnel only)`);
    announceWebhookUrl((msg) => log.info(msg), { metricsUrl: config.tunnelMetricsUrl });
  });

  const controlServer = controlApp.listen(config.controlPort, config.bindAddress, () => {
    log.info(
      `Control listener on ${config.bindAddress}:${config.controlPort} ` +
        `(published to loopback only; Host allowlist: ${config.controlAllowedHosts.join(', ')})`
    );
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
    clearInterval(metaRefresher);
    controlServer.close();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { webhookApp, controlApp, server, controlServer, db, registry };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`Failed to start: ${err.stack || err.message}`);
    process.exit(1);
  });
}
