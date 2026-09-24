/**
 * Decide whether a delivery becomes an agent task, and under which action.
 *
 * Returns one of:
 *   { kind: 'enqueue', action }  - queue a task
 *   { kind: 'cancel', reason }   - drop this issue's pending tasks
 *   { kind: 'ignore', reason }   - acknowledge with 200 so GitHub does not retry
 *
 * Plan vs execute vs triage:
 *   trigger_label (default agent:assigned) — plan/questions committed to the plan file on the task
 *     branch, linked from a short issue comment; no code.
 *   execute_label (default agent:execute) — implement on the task branch.
 *   triage_label (default agent:triage) — label the issue and cross-link related ones; no code.
 */

export const ACTIONS = {
  ASSIGNED: 'agent:assigned',
  OPENED: 'agent:opened',
  EXECUTE: 'agent:execute',
  TRIAGE: 'agent:triage',
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

function hasTriageLabel(payload, project) {
  return hasLabel(payload, project.triage_label);
}

function ignore(reason) {
  return { kind: 'ignore', reason };
}

/**
 * The agent's own comments and label changes must never re-trigger it.
 *
 * Every plan run ends in an issue comment linking the new plan revision, and the issue still carries
 * its trigger label when that comment lands — so without this the agent answers itself until a
 * human removes the label.
 * Triage mode's deliverable is a set of labels, which arrive back as `issues.labeled` deliveries.
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
        // A triage run applies labels, so its own deliveries come straight back here. Escalation
        // has to stay a human decision: without this, one triage label could label its way into
        // execute mode.
        if (isAgentAuthor(payload.sender, project)) {
          return ignore('label was applied by the agent');
        }
        const name = payload.label?.name;
        if (name === project.execute_label) {
          return { kind: 'enqueue', action: ACTIONS.EXECUTE };
        }
        if (name === project.trigger_label) {
          return { kind: 'enqueue', action: ACTIONS.ASSIGNED };
        }
        if (name === project.triage_label) {
          return { kind: 'enqueue', action: ACTIONS.TRIAGE };
        }
        return ignore(`label "${name}" is not a trigger, execute or triage label`);
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
        // Last, because an issue opened with both wants the plan; triage is what you reach for when
        // nobody has decided the issue is worth planning yet.
        if (hasTriageLabel(payload, project)) {
          return { kind: 'enqueue', action: ACTIONS.TRIAGE };
        }
        return ignore('issue does not carry a trigger, execute or triage label');

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
    // The triage label is deliberately not listed: triage is a one-shot classification, so a
    // triaged issue should go quiet again rather than re-triaging on every later comment.
    return ignore('comment has no agent mention and the issue lacks trigger or execute labels');
  }

  return ignore(`unsupported event "${event}"`);
}
