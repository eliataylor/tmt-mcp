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

/** GitHub's write-level associations. CONTRIBUTOR has landed a commit and still cannot push. */
const WRITE_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function loginTrusted(login, project) {
  if (!login) return false;
  const needle = String(login).toLowerCase();
  return (project.trusted_logins || []).some((entry) => String(entry).toLowerCase() === needle);
}

/**
 * Comments and newly opened issues can come from anyone who can see the repo. Label and assign
 * events are emitted only for users GitHub already allowed to edit the issue, so a missing
 * association does not fail those closed. An explicit NONE still does.
 */
function isTrustedActor(event, payload, project) {
  if (event === 'issue_comment') {
    const login = payload.comment?.user?.login;
    if (loginTrusted(login, project)) return true;
    return WRITE_ASSOCIATIONS.has(payload.comment?.author_association);
  }

  const login = payload.sender?.login;
  if (loginTrusted(login, project)) return true;
  if (WRITE_ASSOCIATIONS.has(payload.sender?.author_association)) return true;

  const action = payload.action;
  if (action === 'opened' || action === 'reopened') {
    const author = payload.issue?.user?.login;
    const same = login && author && login.toLowerCase() === String(author).toLowerCase();
    return Boolean(same) && WRITE_ASSOCIATIONS.has(payload.issue?.author_association);
  }

  if (action === 'labeled' || action === 'assigned') {
    return !payload.sender?.author_association;
  }

  return false;
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

/** @-mentions and issue bodies that call the agent in without a control label yet. */
function mentionAction(payload, project) {
  return hasExecuteLabel(payload, project) ? ACTIONS.EXECUTE : ACTIONS.ASSIGNED;
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textHasMention(text, project) {
  if (!text) return false;
  const haystack = String(text);
  if (project.mention && haystack.includes(project.mention)) return true;
  const login = project.agent_login;
  if (!login) return false;
  const re = new RegExp(`@${escapeRegex(login)}(?:\\[bot\\])?(?:[^a-zA-Z0-9-]|$)`, 'i');
  return re.test(haystack);
}

function issueBodyHasMention(payload, project) {
  return textHasMention(payload?.issue?.body || '', project);
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
        if (!isTrustedActor(event, payload, project)) {
          return ignore('actor is not a write collaborator or a trusted login');
        }
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
        if (!(project.agent_login && payload.assignee?.login === project.agent_login)) {
          return ignore('assignee is not the agent login');
        }
        if (!isTrustedActor(event, payload, project)) {
          return ignore('actor is not a write collaborator or a trusted login');
        }
        return { kind: 'enqueue', action: ACTIONS.ASSIGNED };

      case 'opened':
      case 'reopened':
        if (!isTrustedActor(event, payload, project)) {
          return ignore('actor is not a write collaborator or a trusted login');
        }
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
        if (issueBodyHasMention(payload, project)) {
          return { kind: 'enqueue', action: mentionAction(payload, project) };
        }
        return ignore('issue does not carry a trigger, execute or triage label and body has no mention');

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
    if (!isTrustedActor(event, payload, project)) {
      return ignore('actor is not a write collaborator or a trusted login');
    }
    const body = payload.comment?.body || '';
    if (textHasMention(body, project)) {
      return { kind: 'enqueue', action: mentionAction(payload, project) };
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
