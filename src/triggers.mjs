/**
 * Decide whether a delivery becomes an agent task, and under which action.
 *
 * Returns one of:
 *   { kind: 'enqueue', action }  - queue a task
 *   { kind: 'cancel', reason }   - drop this issue's pending tasks
 *   { kind: 'ignore', reason }   - acknowledge with 200 so GitHub does not retry
 *
 * Plan vs execute:
 *   trigger_label (default agent:assigned) — context + issue comment with plan/questions; no code.
 *   execute_label (default agent:execute) — implement on the task branch.
 */

export const ACTIONS = {
  ASSIGNED: 'agent:assigned',
  OPENED: 'agent:opened',
  EXECUTE: 'agent:execute',
  COMMENT: 'comment_created',
};

function labelNames(payload) {
  return (payload?.issue?.labels || []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
}

function hasLabel(payload, name) {
  return name ? labelNames(payload).some((l) => l === name) : false;
}

function hasTriggerLabel(payload, project) {
  return hasLabel(payload, project.trigger_label);
}

function hasExecuteLabel(payload, project) {
  return hasLabel(payload, project.execute_label);
}

function ignore(reason) {
  return { kind: 'ignore', reason };
}

/**
 * The agent's own comments must never re-trigger it.
 *
 * Plan mode's deliverable is an issue comment, and the issue still carries its trigger label when
 * that comment lands — so without this the agent answers itself until a human removes the label.
 * A GitHub App is recognised by type; a machine user needs `agent_login` to match the token the
 * orchestrator posts with. Leave `agent_login` unset only when the agent posts as a Bot.
 */
function isAgentAuthor(user, project) {
  if (!user) return false;
  if (user.type === 'Bot') return true;
  const login = project.agent_login;
  return Boolean(login) && String(user.login || '').toLowerCase() === String(login).toLowerCase();
}

/** Follow-up comments run in execute mode when the execute label is already on the issue. */
function commentAction(payload, project) {
  return hasExecuteLabel(payload, project) ? ACTIONS.EXECUTE : ACTIONS.COMMENT;
}

export function classify({ event, payload, project }) {
  if (!project) return ignore('unregistered repository');
  if (event === 'ping') return ignore('ping');
  if (!payload?.issue) return ignore(`unsupported event "${event}"`);

  const action = payload.action;

  if (event === 'issues') {
    switch (action) {
      case 'labeled': {
        const name = payload.label?.name;
        if (name === project.execute_label) {
          return { kind: 'enqueue', action: ACTIONS.EXECUTE };
        }
        if (name === project.trigger_label) {
          return { kind: 'enqueue', action: ACTIONS.ASSIGNED };
        }
        return ignore(`label "${name}" is not a trigger or execute label`);
      }

      case 'assigned':
        if (project.agent_login && payload.assignee?.login === project.agent_login) {
          return { kind: 'enqueue', action: ACTIONS.ASSIGNED };
        }
        return ignore('assignee is not the agent login');

      case 'opened':
      case 'reopened':
        if (hasExecuteLabel(payload, project)) {
          return { kind: 'enqueue', action: ACTIONS.EXECUTE };
        }
        if (hasTriggerLabel(payload, project)) {
          return { kind: 'enqueue', action: ACTIONS.OPENED };
        }
        return ignore('issue does not carry a trigger or execute label');

      case 'closed':
        return { kind: 'cancel', reason: 'issue closed' };

      case 'unlabeled':
        if (payload.label?.name === project.trigger_label) {
          return { kind: 'cancel', reason: 'trigger label removed' };
        }
        return ignore(`label "${payload.label?.name}" is not the trigger label`);

      default:
        return ignore(`issues.${action} is not a trigger`);
    }
  }

  if (event === 'issue_comment') {
    if (action !== 'created') return ignore(`issue_comment.${action} is not a trigger`);
    if (isAgentAuthor(payload.comment?.user, project)) {
      return ignore('comment was written by the agent');
    }
    const body = payload.comment?.body || '';
    if (project.mention && body.includes(project.mention)) {
      return { kind: 'enqueue', action: commentAction(payload, project) };
    }
    if (hasExecuteLabel(payload, project)) {
      return { kind: 'enqueue', action: ACTIONS.EXECUTE };
    }
    if (hasTriggerLabel(payload, project)) {
      return { kind: 'enqueue', action: ACTIONS.COMMENT };
    }
    return ignore('comment has no agent mention and the issue lacks trigger or execute labels');
  }

  return ignore(`unsupported event "${event}"`);
}
