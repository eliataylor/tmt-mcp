import { buildContext } from './context.mjs';
import * as queue from './queue.mjs';
import { classify } from './triggers.mjs';

/**
 * Shared webhook / manual ingest path: classify, cancel, or enqueue.
 */
export function handleDelivery({
  db,
  registry,
  config,
  log,
  event,
  payload,
  deliveryId = null,
  deliveredAt = null,
}) {
  const repoFullName = payload?.repository?.full_name ?? null;
  const project = registry.byRepo(repoFullName);

  if (!project) {
    return {
      status: 202,
      body: { ok: true, ignored: true, reason: 'unregistered repository' },
    };
  }

  if (event === 'ping') {
    return { status: 200, body: { ok: true, pong: true, project_slug: project.slug } };
  }

  const verdict = classify({ event, payload, project });

  if (verdict.kind === 'ignore') {
    return { status: 200, body: { ok: true, ignored: true, reason: verdict.reason } };
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
    return { status: 200, body: { ok: true, cancelled, reason: verdict.reason } };
  }

  const at = deliveredAt || new Date().toISOString();
  const context = buildContext({
    event,
    action: verdict.action,
    payload,
    project,
    deliveryId,
    deliveredAt: at,
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
    return {
      status: 200,
      body: { ok: true, duplicate: true, task_id: task?.id ?? null, action: verdict.action },
    };
  }

  log.info(
    `Queued ${verdict.action} for ${project.slug} (${repoFullName}) issue #${payload.issue?.number} -> ${task.id}`
  );
  return {
    status: 201,
    body: {
      ok: true,
      duplicate: false,
      task_id: task.id,
      project_slug: project.slug,
      action: verdict.action,
    },
  };
}
