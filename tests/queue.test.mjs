import assert from 'node:assert/strict';
import test, { beforeEach, describe } from 'node:test';

import { openDatabase } from '../src/db.mjs';
import { buildContext } from '../src/context.mjs';
import * as queue from '../src/queue.mjs';
import { PROJECT, expireLease, fixture } from './helpers.mjs';

let db;

function add(deliveryId, { issueNumber = 42, issueId = 2938471055, action = 'agent:assigned', maxAttempts = 3 } = {}) {
  const payload = fixture('issues.labeled.json');
  payload.issue.number = issueNumber;
  payload.issue.id = issueId;
  const context = buildContext({ event: 'issues', action, payload, project: PROJECT, deliveryId });
  return queue.enqueue(db, { deliveryId, project: PROJECT, payload, context, action, maxAttempts });
}

beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('enqueue', () => {
  test('stores both identifiers, the generated repo column and parsed JSON', () => {
    const { task } = add('d1');
    assert.equal(task.project_slug, 'main-app');
    assert.equal(task.repo_full_name, 'my-org/primary-app');
    assert.equal(task.github_issue_number, 42);
    assert.equal(task.github_issue_id, 2938471055);
    assert.notEqual(task.github_issue_id, task.github_issue_number);
    assert.equal(task.status, 'pending');
    assert.equal(task.attempts, 0);
    assert.equal(task.context.schema_version, 1);
    assert.equal(task.payload.issue.number, 42);
  });

  test('a redelivery of the same X-GitHub-Delivery does not create a second task', () => {
    const first = add('same-delivery');
    const second = add('same-delivery');
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.task.id, first.task.id);
    assert.equal(queue.listTasks(db).length, 1);
  });

  test('distinct deliveries for the same issue both queue', () => {
    add('d1');
    add('d2', { action: 'comment_created' });
    assert.equal(queue.listTasks(db).length, 2);
  });
});

describe('claim', () => {
  test('leases the oldest task and counts the attempt', () => {
    add('d1');
    const task = queue.claim(db, { worker: 'orchestrator-1', leaseSeconds: 900 });
    assert.equal(task.status, 'processing');
    assert.equal(task.attempts, 1);
    assert.equal(task.locked_by, 'orchestrator-1');
    assert.ok(task.lease_expires_at > task.locked_at);
  });

  test('returns null when the queue is empty', () => {
    assert.equal(queue.claim(db, {}), null);
  });

  test('never hands out two tasks for the same issue at once', () => {
    add('d1');
    add('d2', { action: 'comment_created' });
    assert.ok(queue.claim(db, { worker: 'w1' }));
    assert.equal(queue.claim(db, { worker: 'w2' }), null, 'second task on the same issue must wait');
  });

  test('a different issue is still claimable', () => {
    add('d1');
    add('d2', { issueNumber: 99, issueId: 7777 });
    assert.equal(queue.claim(db, { worker: 'w1' }).github_issue_number, 42);
    assert.equal(queue.claim(db, { worker: 'w2' }).github_issue_number, 99);
  });

  test('project_slug filtering only returns the requested tenants', () => {
    add('d1');
    const other = fixture('issues.labeled.json');
    other.issue.number = 5;
    const otherProject = { ...PROJECT, slug: 'side-project' };
    queue.enqueue(db, {
      deliveryId: 'd2',
      project: otherProject,
      payload: other,
      context: buildContext({ event: 'issues', action: 'agent:assigned', payload: other, project: otherProject }),
      action: 'agent:assigned',
    });

    assert.equal(queue.claim(db, { projectSlugs: ['side-project'] }).project_slug, 'side-project');
    assert.equal(queue.claim(db, { projectSlugs: ['side-project'] }), null);
    assert.equal(queue.claim(db, { projectSlugs: ['main-app'] }).project_slug, 'main-app');
  });

  test('a backed-off task is not claimable until available_at passes', () => {
    add('d1');
    const task = queue.claim(db, {});
    queue.fail(db, task.id, 'boom', { backoffSeconds: 3600 });
    assert.equal(queue.claim(db, {}), null);
  });
});

describe('complete, fail and heartbeat', () => {
  test('complete only applies to a processing task', () => {
    add('d1');
    const task = queue.claim(db, {});
    assert.equal(queue.complete(db, task.id).status, 'completed');
    assert.equal(queue.complete(db, task.id), null, 'completing twice is a no-op');
    assert.equal(queue.complete(db, 'missing-id'), null);
  });

  test('fail re-queues with doubling backoff, then gives up at max_attempts', () => {
    add('d1', { maxAttempts: 3 });

    const first = queue.fail(db, queue.claim(db, {}).id, 'attempt 1', { backoffSeconds: 10 });
    assert.equal(first.status, 'pending');
    assert.equal(first.attempts, 1);
    assert.equal(first.last_error, 'attempt 1');

    // available_at moved into the future, so undo it to claim again in the same test.
    db.prepare("UPDATE agent_tasks SET available_at = datetime('now','-1 hours')").run();
    const second = queue.fail(db, queue.claim(db, {}).id, 'attempt 2', { backoffSeconds: 10 });
    assert.equal(second.status, 'pending');
    assert.equal(second.attempts, 2);

    db.prepare("UPDATE agent_tasks SET available_at = datetime('now','-1 hours')").run();
    const third = queue.fail(db, queue.claim(db, {}).id, 'attempt 3', { backoffSeconds: 10 });
    assert.equal(third.status, 'failed', 'a spent task must not be retried forever');
    assert.equal(third.attempts, 3);
    assert.ok(third.completed_at);
  });

  test('backoff grows with each attempt', () => {
    add('d1', { maxAttempts: 5 });
    const delays = [];
    for (let i = 0; i < 3; i++) {
      const task = queue.claim(db, {});
      const failed = queue.fail(db, task.id, null, { backoffSeconds: 100 });
      delays.push(
        db
          .prepare("SELECT CAST((julianday(available_at) - julianday('now')) * 86400 AS INTEGER) AS s FROM agent_tasks WHERE id = ?")
          .get(task.id).s
      );
      db.prepare("UPDATE agent_tasks SET available_at = datetime('now','-1 hours') WHERE id = ?").run(failed.id);
    }
    assert.ok(delays[1] > delays[0], `expected growth, got ${delays}`);
    assert.ok(delays[2] > delays[1], `expected growth, got ${delays}`);
  });

  test('heartbeat pushes the lease out', () => {
    add('d1');
    const task = queue.claim(db, { leaseSeconds: 60 });
    const extended = queue.heartbeat(db, task.id, 3600);
    assert.ok(extended.lease_expires_at > task.lease_expires_at);
    assert.equal(queue.heartbeat(db, 'missing-id', 60), null);
  });

  test('heartbeat does nothing for a task that is not processing', () => {
    add('d1');
    assert.equal(queue.heartbeat(db, queue.listTasks(db)[0].id, 60), null);
  });
});

describe('reap', () => {
  test('an expired lease returns to pending and can be claimed again', () => {
    add('d1');
    const task = queue.claim(db, { worker: 'crashed-worker' });
    expireLease(db, task.id);

    const reaped = queue.reap(db, { backoffSeconds: 0 });
    assert.deepEqual(reaped.map((r) => r.status), ['pending']);

    const requeued = queue.getTask(db, task.id);
    assert.equal(requeued.status, 'pending');
    assert.equal(requeued.locked_by, null);
    assert.equal(requeued.lease_expires_at, null);
    assert.equal(requeued.last_error, 'lease expired');

    assert.equal(queue.claim(db, { worker: 'fresh-worker' }).attempts, 2);
  });

  test('a live lease is left alone', () => {
    add('d1');
    queue.claim(db, { leaseSeconds: 3600 });
    assert.deepEqual(queue.reap(db, {}), []);
  });

  test('an exhausted task is failed rather than requeued forever', () => {
    add('d1', { maxAttempts: 1 });
    const task = queue.claim(db, {});
    expireLease(db, task.id);
    assert.deepEqual(queue.reap(db, {}).map((r) => r.status), ['failed']);
    assert.equal(queue.getTask(db, task.id).status, 'failed');
  });
});

describe('cancelPending', () => {
  test('closing an issue cancels queued work and work in flight', () => {
    add('d1');
    add('d2', { action: 'comment_created' });
    const inFlight = queue.claim(db, {});

    const cancelled = queue.cancelPending(db, { projectSlug: 'main-app', issueNumber: 42, reason: 'issue closed' });
    // Both rows go: the orchestrator notices the in-flight one left 'processing' on its next
    // heartbeat and stops the container.
    assert.equal(cancelled.length, 2);
    assert.equal(queue.getTask(db, inFlight.id).status, 'cancelled');
    assert.equal(queue.getTask(db, inFlight.id).last_error, 'issue closed');
  });

  test('a cancelled in-flight task can no longer be heartbeat, which is the stop signal', () => {
    add('d1');
    const inFlight = queue.claim(db, {});
    queue.cancelPending(db, { projectSlug: 'main-app', issueNumber: 42, reason: 'issue closed' });
    assert.equal(queue.heartbeat(db, inFlight.id, 60), null);
  });

  test('another issue is untouched', () => {
    add('d1');
    add('d2', { issueNumber: 99, issueId: 7777 });
    assert.deepEqual(queue.cancelPending(db, { projectSlug: 'main-app', issueNumber: 1234 }), []);
    assert.equal(queue.statusCounts(db).pending, 2);
  });
});

describe('listTasks', () => {
  test('filters by status and project and caps the limit', () => {
    add('d1');
    add('d2', { issueNumber: 99, issueId: 7777 });
    queue.claim(db, {});

    assert.equal(queue.listTasks(db, { status: 'processing' }).length, 1);
    assert.equal(queue.listTasks(db, { status: 'pending' }).length, 1);
    assert.equal(queue.listTasks(db, { projectSlug: 'nope' }).length, 0);
    assert.equal(queue.listTasks(db, { limit: 1 }).length, 1);
    assert.equal(queue.listTasks(db, { limit: 10_000 }).length, 2);
  });

  test('the listing omits the heavy blobs', () => {
    add('d1');
    const [row] = queue.listTasks(db);
    assert.equal(row.payload, undefined);
    assert.equal(row.context, undefined);
  });
});
