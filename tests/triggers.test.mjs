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

  test('the execute label enqueues execute mode', () => {
    const payload = labeled();
    payload.label = { name: 'agent:execute' };
    assert.deepEqual(classify({ event: 'issues', payload, project: PROJECT }), {
      kind: 'enqueue',
      action: ACTIONS.EXECUTE,
    });
  });

  test('the triage label enqueues triage mode', () => {
    const payload = labeled();
    payload.label = { name: 'agent:triage' };
    assert.deepEqual(classify({ event: 'issues', payload, project: PROJECT }), {
      kind: 'enqueue',
      action: ACTIONS.TRIAGE,
    });
  });

  test('a label the agent applied itself never enqueues', () => {
    for (const sender of [
      { login: 'Dev-Agent', type: 'User' },
      { login: 'some-app[bot]', type: 'Bot' },
    ]) {
      for (const name of ['agent:triage', 'agent:assigned', 'agent:execute']) {
        const payload = labeled();
        payload.label = { name };
        payload.sender = sender;
        assert.equal(
          classify({ event: 'issues', payload, project: PROJECT }).kind,
          'ignore',
          `${sender.login} adding ${name}`
        );
      }
    }
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

  test('an issue opened with only the triage label is triaged', () => {
    const payload = labeled();
    payload.action = 'opened';
    payload.issue.labels = [{ name: 'bug' }, { name: 'agent:triage' }];
    assert.equal(classify({ event: 'issues', payload, project: PROJECT }).action, ACTIONS.TRIAGE);
  });

  test('an issue opened with both triage and trigger labels gets the plan', () => {
    const payload = labeled();
    payload.action = 'opened';
    payload.issue.labels = [{ name: 'agent:triage' }, { name: 'agent:assigned' }];
    assert.equal(classify({ event: 'issues', payload, project: PROJECT }).action, ACTIONS.OPENED);
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

  test('a comment on an issue with execute label runs in execute mode', () => {
    const payload = commented();
    payload.issue.labels = [{ name: 'agent:assigned' }, { name: 'agent:execute' }];
    payload.comment.body = 'go ahead with the plan';
    assert.equal(classify({ event: 'issue_comment', payload, project: PROJECT }).action, ACTIONS.EXECUTE);
  });

  test('an unrelated comment on an unlabeled issue is ignored', () => {
    const payload = commented();
    payload.comment.body = 'thanks for the report';
    payload.issue.labels = [{ name: 'bug' }];
    assert.equal(classify({ event: 'issue_comment', payload, project: PROJECT }).kind, 'ignore');
  });

  test('a later comment does not re-triage an already triaged issue', () => {
    const payload = commented();
    payload.issue.labels = [{ name: 'agent:triage' }, { name: 'bug' }];
    payload.comment.body = 'still seeing this on 2.1';
    assert.equal(classify({ event: 'issue_comment', payload, project: PROJECT }).kind, 'ignore');
  });

  test("the agent's own comment never re-triggers it", () => {
    const byLogin = commented();
    byLogin.comment.user = { login: 'Dev-Agent', id: 99120034, type: 'User' };
    assert.equal(classify({ event: 'issue_comment', payload: byLogin, project: PROJECT }).kind, 'ignore');

    const byBot = commented();
    byBot.comment.user = { login: 'some-app[bot]', id: 99120035, type: 'Bot' };
    assert.equal(classify({ event: 'issue_comment', payload: byBot, project: PROJECT }).kind, 'ignore');
  });

  test('without an agent_login, user comments are left alone', () => {
    const payload = commented();
    const project = { ...PROJECT, agent_login: null };
    assert.equal(classify({ event: 'issue_comment', payload, project }).action, ACTIONS.COMMENT);
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
