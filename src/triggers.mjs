/**
 * Decide whether a delivery becomes an agent task, and under which action.
 *
 * Returns one of:
 *   { kind: 'enqueue', action }  - queue a task
 *   { kind: 'cancel', reason }   - drop this issue's pending tasks
 *   { kind: 'ignore', reason }   - acknowledge with 200 so GitHub does not retry
 */

export const ACTIONS = {
  ASSIGNED: 'agent:assigned',
  OPENED: 'agent:opened',
  COMMENT: 'comment_created',
};

function labelNames(payload) {
  return (payload?.issue?.labels || []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
}

function hasTriggerLabel(payload, project) {
  return labelNames(payload).some((name) => name === project.trigger_label);
}

function ignore(reason) {
  return { kind: 'ignore', reason };
}

export function classify({ event, payload, project }) {
  if (!project) return ignore('unregistered repository');
  if (event === 'ping') return ignore('ping');
  if (!payload?.issue) return ignore(`unsupported event "${event}"`);

  const action = payload.action;

  if (event === 'issues') {
    switch (action) {
      case 'labeled':
        return payload.label?.name === project.trigger_label
          ? { kind: 'enqueue', action: ACTIONS.ASSIGNED }
          : ignore(`label "${payload.label?.name}" is not the trigger label`);

      case 'assigned':
        if (project.agent_login && payload.assignee?.login === project.agent_login) {
          return { kind: 'enqueue', action: ACTIONS.ASSIGNED };
        }
        return ignore('assignee is not the agent login');

      case 'opened':
      case 'reopened':
        return hasTriggerLabel(payload, project)
          ? { kind: 'enqueue', action: ACTIONS.OPENED }
          : ignore('issue does not carry the trigger label');

      case 'closed':
        return { kind: 'cancel', reason: 'issue closed' };

      case 'unlabeled':
        return payload.label?.name === project.trigger_label
          ? { kind: 'cancel', reason: 'trigger label removed' }
          : ignore(`label "${payload.label?.name}" is not the trigger label`);

      default:
        return ignore(`issues.${action} is not a trigger`);
    }
  }

  if (event === 'issue_comment') {
    if (action !== 'created') return ignore(`issue_comment.${action} is not a trigger`);
    const body = payload.comment?.body || '';
    if (project.mention && body.includes(project.mention)) {
      return { kind: 'enqueue', action: ACTIONS.COMMENT };
    }
    // A follow-up on an issue the agent already owns counts, even without a mention.
    if (hasTriggerLabel(payload, project)) {
      return { kind: 'enqueue', action: ACTIONS.COMMENT };
    }
    return ignore('comment has no agent mention and the issue lacks the trigger label');
  }

  return ignore(`unsupported event "${event}"`);
}
