/**
 * Queue operations. Every function takes the database handle first so tests can drive an
 * in-memory database without touching module state.
 */

export const QUEUE_DEFAULTS = {
  leaseSeconds: Number(process.env.LEASE_SECONDS || 1800),
  maxAttempts: Number(process.env.MAX_ATTEMPTS || 3),
  backoffSeconds: Number(process.env.RETRY_BACKOFF_SECONDS || 60),
};

const RETURNING_COLUMNS = `
  id, delivery_id, project_slug, repo_full_name, github_issue_id, github_issue_number,
  issue_title, action, status, attempts, max_attempts, available_at,
  locked_by, locked_at, lease_expires_at, last_error, completed_at, created_at, updated_at,
  json(payload) AS payload, json(context) AS context
`;

/** payload and context come back as JSON text from json(); give callers real objects. */
function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    payload: row.payload ? JSON.parse(row.payload) : null,
    context: row.context ? JSON.parse(row.context) : null,
  };
}

/**
 * Insert a task, ignoring a redelivery of the same X-GitHub-Delivery.
 * GitHub retries on timeout or a non-2xx reply, and without this the orchestrator would
 * open a second worktree for an issue it is already working.
 */
export function enqueue(db, { deliveryId = null, project, payload, context, action, maxAttempts }) {
  const issue = payload?.issue ?? {};

  const inserted = db
    .prepare(
      `INSERT INTO agent_tasks
         (delivery_id, project_slug, github_issue_id, github_issue_number,
          issue_title, action, payload, context, max_attempts)
       VALUES
         (@delivery_id, @project_slug, @github_issue_id, @github_issue_number,
          @issue_title, @action, jsonb(@payload), jsonb(@context), @max_attempts)
       ON CONFLICT(delivery_id) DO NOTHING
       RETURNING ${RETURNING_COLUMNS}`
    )
    .get({
      delivery_id: deliveryId,
      project_slug: project.slug,
      github_issue_id: issue.id ?? 0,
      github_issue_number: issue.number ?? 0,
      issue_title: issue.title ?? '(untitled)',
      action,
      payload: JSON.stringify(payload),
      context: JSON.stringify(context),
      max_attempts: maxAttempts ?? QUEUE_DEFAULTS.maxAttempts,
    });

  if (inserted) return { task: hydrate(inserted), duplicate: false };

  const existing = db
    .prepare(`SELECT ${RETURNING_COLUMNS} FROM agent_tasks WHERE delivery_id = ?`)
    .get(deliveryId);
  return { task: hydrate(existing), duplicate: true };
}

// Prepared statements belong to the handle that created them, so the cache is keyed by
// database first and slug count second.
const claimStatements = new WeakMap();

function claimStatement(db, slugCount) {
  let perDb = claimStatements.get(db);
  if (!perDb) {
    perDb = new Map();
    claimStatements.set(db, perDb);
  }
  if (perDb.has(slugCount)) return perDb.get(slugCount);

  const slugFilter =
    slugCount === 0
      ? ''
      : ` AND t.project_slug IN (${Array.from({ length: slugCount }, (_, i) => `@slug${i}`).join(', ')})`;

  const statement = db.prepare(`
    UPDATE agent_tasks
       SET status = 'processing',
           attempts = attempts + 1,
           locked_by = @worker,
           locked_at = datetime('now'),
           lease_expires_at = datetime('now', '+' || @lease_seconds || ' seconds'),
           updated_at = datetime('now')
     WHERE id = (
       SELECT t.id FROM agent_tasks t
        WHERE t.status = 'pending'
          AND t.available_at <= datetime('now')${slugFilter}
          AND NOT EXISTS (
            SELECT 1 FROM agent_tasks b
             WHERE b.project_slug = t.project_slug
               AND b.github_issue_number = t.github_issue_number
               AND b.status = 'processing')
        ORDER BY t.created_at, t.rowid
        LIMIT 1)
    RETURNING ${RETURNING_COLUMNS}
  `);

  perDb.set(slugCount, statement);
  return statement;
}

/**
 * Lease the oldest eligible task.
 *
 * The NOT EXISTS anti-join skips any issue that already has a task in flight, so a burst
 * of comments on one issue cannot make the orchestrator open two worktrees for it.
 */
export function claim(db, { worker = 'orchestrator', projectSlugs = [], leaseSeconds } = {}) {
  const slugs = (Array.isArray(projectSlugs) ? projectSlugs : [projectSlugs]).filter(Boolean);
  const params = {
    worker,
    lease_seconds: leaseSeconds ?? QUEUE_DEFAULTS.leaseSeconds,
  };
  slugs.forEach((slug, i) => {
    params[`slug${i}`] = slug;
  });

  const statement = claimStatement(db, slugs.length);
  // Take the write lock up front so a concurrent claim cannot slip between select and update.
  const run = db.transaction((p) => statement.get(p));
  return hydrate(run.immediate(params));
}

export function complete(db, id) {
  return hydrate(
    db
      .prepare(
        `UPDATE agent_tasks
            SET status = 'completed',
                locked_by = NULL, locked_at = NULL, lease_expires_at = NULL,
                last_error = NULL,
                completed_at = datetime('now'),
                updated_at = datetime('now')
          WHERE id = @id AND status = 'processing'
         RETURNING ${RETURNING_COLUMNS}`
      )
      .get({ id })
  );
}

/**
 * Report a failure. Re-queues with exponential backoff until max_attempts is spent,
 * then parks the task as failed.
 */
export function fail(db, id, error = null, { backoffSeconds } = {}) {
  const base = backoffSeconds ?? QUEUE_DEFAULTS.backoffSeconds;
  return hydrate(
    db
      .prepare(
        `UPDATE agent_tasks
            SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
                locked_by = NULL, locked_at = NULL, lease_expires_at = NULL,
                last_error = @error,
                available_at = CASE
                  WHEN attempts >= max_attempts THEN available_at
                  ELSE datetime('now', '+' || (@base * (1 << (attempts - 1))) || ' seconds')
                END,
                completed_at = CASE WHEN attempts >= max_attempts THEN datetime('now') ELSE NULL END,
                updated_at = datetime('now')
          WHERE id = @id AND status = 'processing'
         RETURNING ${RETURNING_COLUMNS}`
      )
      .get({ id, error, base })
  );
}

/** Extend a lease so a long-running task is not reaped out from under the orchestrator. */
export function heartbeat(db, id, leaseSeconds) {
  return hydrate(
    db
      .prepare(
        `UPDATE agent_tasks
            SET lease_expires_at = datetime('now', '+' || @lease_seconds || ' seconds'),
                updated_at = datetime('now')
          WHERE id = @id AND status = 'processing'
         RETURNING ${RETURNING_COLUMNS}`
      )
      .get({ id, lease_seconds: leaseSeconds ?? QUEUE_DEFAULTS.leaseSeconds })
  );
}

/**
 * Drop an issue's queued work when it is closed or loses the trigger label.
 * Tasks already in flight are left alone; cancelling the row would not stop the worker.
 */
export function cancelPending(db, { projectSlug, issueNumber, reason = 'cancelled' }) {
  return db
    .prepare(
      `UPDATE agent_tasks
          SET status = 'cancelled',
              last_error = @reason,
              completed_at = datetime('now'),
              updated_at = datetime('now')
        WHERE project_slug = @slug AND github_issue_number = @number AND status = 'pending'
       RETURNING id`
    )
    .all({ slug: projectSlug, number: issueNumber, reason })
    .map((r) => r.id);
}

/**
 * Return expired leases to the queue. Without this, an orchestrator that crashes mid-task
 * leaves the row 'processing' forever and the issue is never retried.
 */
export function reap(db, { backoffSeconds } = {}) {
  const base = backoffSeconds ?? QUEUE_DEFAULTS.backoffSeconds;
  return db
    .prepare(
      `UPDATE agent_tasks
          SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
              locked_by = NULL, locked_at = NULL, lease_expires_at = NULL,
              last_error = 'lease expired',
              available_at = CASE
                WHEN attempts >= max_attempts THEN available_at
                ELSE datetime('now', '+' || (@base * (1 << (attempts - 1))) || ' seconds')
              END,
              completed_at = CASE WHEN attempts >= max_attempts THEN datetime('now') ELSE NULL END,
              updated_at = datetime('now')
        WHERE status = 'processing'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= datetime('now')
       RETURNING id, status, attempts`
    )
    .all({ base });
}

export function getTask(db, id) {
  return hydrate(db.prepare(`SELECT ${RETURNING_COLUMNS} FROM agent_tasks WHERE id = ?`).get(id));
}

/** Inspection endpoint backing. Omits the payload and context blobs to keep replies small. */
export function listTasks(db, { status = null, projectSlug = null, limit = 50 } = {}) {
  const clauses = [];
  const params = { limit: Math.min(Math.max(Number(limit) || 50, 1), 500) };
  if (status) {
    clauses.push('status = @status');
    params.status = status;
  }
  if (projectSlug) {
    clauses.push('project_slug = @project_slug');
    params.project_slug = projectSlug;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  return db
    .prepare(
      `SELECT id, delivery_id, project_slug, repo_full_name, github_issue_id, github_issue_number,
              issue_title, action, status, attempts, max_attempts, available_at,
              locked_by, lease_expires_at, last_error, completed_at, created_at, updated_at
         FROM agent_tasks ${where}
        ORDER BY created_at DESC, rowid DESC
        LIMIT @limit`
    )
    .all(params);
}

export function statusCounts(db) {
  const rows = db.prepare('SELECT status, COUNT(*) AS count FROM agent_tasks GROUP BY status').all();
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}
