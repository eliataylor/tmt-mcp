import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { ACTIONS, classify } from '../src/triggers.mjs';
import { PROJECT, fixture } from './helpers.mjs';

const labeled = () => fixture('issues.labeled.json');
const commented = () => fixture('issue_comment.created.json');

describe('issues events', () => {
  test('the trigger label enqueues', () => {
    assert.deepEqual(classify({ event: 'issues', payload: labeled(), project: PROJECT }), {
      kind: 'enqueue',
      action: ACTIONS.ASSIGNED,
    });
  });

  test('a different label is ignored', () => {
    const payload = labeled();
    payload.label = { name: 'documentation' };
    assert.equal(classify({ event: 'issues', payload, project: PROJECT }).kind, 'ignore');
  });

  test('assignment to the agent login enqueues', () => {
    const payload = labeled();
    payload.action = 'assigned';
    payload.assignee = { login: 'dev-agent' };
    assert.equal(classify({ event: 'issues', payload, project: PROJECT }).action, ACTIONS.ASSIGNED);
  });

  test('assignment to a human is ignored', () => {
    const payload = labeled();
    payload.action = 'assigned';
    payload.assignee = { login: 'eliataylor' };
    assert.equal(classify({ event: 'issues', payload, project: PROJECT }).kind, 'ignore');
  });

  test('opened enqueues only when the trigger label is already on the issue', () => {
    const withLabel = labeled();
    withLabel.action = 'opened';
    assert.equal(classify({ event: 'issues', payload: withLabel, project: PROJECT }).action, ACTIONS.OPENED);

    const withoutLabel = labeled();
    withoutLabel.action = 'opened';
    withoutLabel.issue.labels = [{ name: 'bug' }];
    assert.equal(classify({ event: 'issues', payload: withoutLabel, project: PROJECT }).kind, 'ignore');
  });

  test('closing cancels queued work', () => {
    const payload = labeled();
    payload.action = 'closed';
    assert.deepEqual(classify({ event: 'issues', payload, project: PROJECT }), {
      kind: 'cancel',
      reason: 'issue closed',
    });
  });

  test('removing the trigger label cancels queued work', () => {
    const payload = labeled();
    payload.action = 'unlabeled';
    assert.equal(classify({ event: 'issues', payload, project: PROJECT }).kind, 'cancel');
  });

  test('unrelated actions are ignored', () => {
    for (const action of ['edited', 'milestoned', 'pinned', 'transferred']) {
      const payload = labeled();
      payload.action = action;
      assert.equal(classify({ event: 'issues', payload, project: PROJECT }).kind, 'ignore', action);
    }
  });
});

describe('issue_comment events', () => {
  test('a mention enqueues', () => {
    assert.deepEqual(classify({ event: 'issue_comment', payload: commented(), project: PROJECT }), {
      kind: 'enqueue',
      action: ACTIONS.COMMENT,
    });
  });

  test('a comment on an already-labeled issue enqueues without a mention', () => {
    const payload = commented();
    payload.comment.body = 'bumping this, still broken';
    assert.equal(classify({ event: 'issue_comment', payload, project: PROJECT }).action, ACTIONS.COMMENT);
  });

  test('an unrelated comment on an unlabeled issue is ignored', () => {
    const payload = commented();
    payload.comment.body = 'thanks for the report';
    payload.issue.labels = [{ name: 'bug' }];
    assert.equal(classify({ event: 'issue_comment', payload, project: PROJECT }).kind, 'ignore');
  });

  test('edits and deletions are ignored', () => {
    for (const action of ['edited', 'deleted']) {
      const payload = commented();
      payload.action = action;
      assert.equal(classify({ event: 'issue_comment', payload, project: PROJECT }).kind, 'ignore', action);
    }
  });
});

describe('non-triggers', () => {
  test('ping, unknown events and unregistered repos are ignored', () => {
    assert.equal(classify({ event: 'ping', payload: {}, project: PROJECT }).kind, 'ignore');
    assert.equal(classify({ event: 'push', payload: {}, project: PROJECT }).kind, 'ignore');
    assert.equal(classify({ event: 'issues', payload: labeled(), project: null }).kind, 'ignore');
  });

  test('a project-specific label is honoured over the default', () => {
    const project = { ...PROJECT, trigger_label: 'run-agent' };
    assert.equal(classify({ event: 'issues', payload: labeled(), project }).kind, 'ignore');

    const payload = labeled();
    payload.label = { name: 'run-agent' };
    assert.equal(classify({ event: 'issues', payload, project }).action, ACTIONS.ASSIGNED);
  });
});
