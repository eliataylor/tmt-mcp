/**
 * Decide whether a delivery becomes an agent task, and under which action.
 *
 * Returns one of:
 *   { kind: 'enqueue', action }  - queue a task
 *   { kind: 'cancel', reason }   - drop this issue's pending tasks
 *   { kind: 'ignore', reason }   - acknowledge with 200 so GitHub does not retry
 *
 * Stage labels (defaults):
 *   agent:triage — labels + sizing comment; no branch
 *   agent:research / agent:graphic / agent:sdd / agent:monitor — stage markdown under .agent/plans/{n}/
 *   agent:execute — implement from PLAN.md; write TEST.md Instructions
 *   agent:test — run TEST.md Instructions; write Results
 *
 * trigger_label (default agent:sdd) is the cancel label and the System Design wake.
 */

export const ACTIONS = {
  SDD: 'agent:sdd',
  /** @deprecated Use ACTIONS.SDD. Kept as an alias for older imports. */
  ASSIGNED: 'agent:sdd',
  OPENED: 'agent:opened',
  EXECUTE: 'agent:execute',
  TRIAGE: 'agent:triage',
  RESEARCH: 'agent:research',
  GRAPHIC: 'agent:graphic',
  MONITOR: 'agent:monitor',
  TEST: 'agent:test',
  COMMENT: 'comment_created',
  /** Sticky usage reply when a mention has no Action token and no control labels. */
  MENTION_HELP: 'mention_help',
};

function labelNames(payload) {
  return (payload?.issue?.labels || []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
}

function hasLabel(payload, name) {
  return name ? labelNames(payload).some((l) => l === name) : false;
}

function projectLabels(project) {
  return {
    trigger: project.trigger_label || 'agent:sdd',
    execute: project.execute_label || 'agent:execute',
    triage: project.triage_label || 'agent:triage',
    research: project.research_label || 'agent:research',
    graphic: project.graphic_label || 'agent:graphic',
    monitor: project.monitor_label || 'agent:monitor',
    test: project.test_label || 'agent:test',
  };
}

function ignore(reason) {
  return { kind: 'ignore', reason };
}

/** GitHub's write-level associations. CONTRIBUTOR has landed a commit and still cannot push. */
const WRITE_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * Comments and newly opened issues can come from anyone who can see the repo. Label and assign
 * events are emitted only for users GitHub already allowed to edit the issue, so a missing
 * association does not fail those closed. An explicit NONE still does.
 */
function isTrustedActor(event, payload) {
  if (event === 'issue_comment') {
    return WRITE_ASSOCIATIONS.has(payload.comment?.author_association);
  }

  if (WRITE_ASSOCIATIONS.has(payload.sender?.author_association)) return true;

  const action = payload.action;
  if (action === 'opened' || action === 'reopened') {
    const login = payload.sender?.login;
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
 */
function isAgentAuthor(user, project) {
  if (!user) return false;
  if (user.type === 'Bot') return true;
  const login = project.agent_login;
  return Boolean(login) && String(user.login || '').toLowerCase() === String(login).toLowerCase();
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

/**
 * Priority: execute → test → sdd → research / graphic / monitor → triage.
 * Returns the enqueue action, or null when nothing matches.
 */
export function actionFromLabels(payload, project, { forComment = false } = {}) {
  const L = projectLabels(project);

  if (hasLabel(payload, L.execute)) return ACTIONS.EXECUTE;
  if (hasLabel(payload, L.test)) return ACTIONS.TEST;
  if (hasLabel(payload, L.trigger)) {
    return forComment ? ACTIONS.COMMENT : ACTIONS.SDD;
  }
  if (hasLabel(payload, L.research)) return ACTIONS.RESEARCH;
  if (hasLabel(payload, L.graphic)) return ACTIONS.GRAPHIC;
  if (hasLabel(payload, L.monitor)) return ACTIONS.MONITOR;
  if (hasLabel(payload, L.triage)) return forComment ? null : ACTIONS.TRIAGE;
  return null;
}

/** Label name → wake action (trigger maps to SDD, never comment_created / opened). */
function labeledAction(name, project) {
  const L = projectLabels(project);
  if (name === L.execute) return ACTIONS.EXECUTE;
  if (name === L.test) return ACTIONS.TEST;
  if (name === L.trigger) return ACTIONS.SDD;
  if (name === L.research) return ACTIONS.RESEARCH;
  if (name === L.graphic) return ACTIONS.GRAPHIC;
  if (name === L.monitor) return ACTIONS.MONITOR;
  if (name === L.triage) return ACTIONS.TRIAGE;
  return null;
}

/**
 * Control-label names in priority order for matching tokens in mention text.
 */
function controlLabelsInPriority(project) {
  const L = projectLabels(project);
  return [L.execute, L.test, L.trigger, L.research, L.graphic, L.monitor, L.triage].filter(Boolean);
}

/**
 * First configured control-label string that appears as a bare token in text.
 * Priority: execute → test → sdd → research → graphic → monitor → triage.
 */
export function controlLabelTokenInText(text, project) {
  const haystack = String(text || '');
  if (!haystack) return null;
  for (const name of controlLabelsInPriority(project)) {
    const re = new RegExp(`(?:^|[^A-Za-z0-9_-])${escapeRegex(name)}(?![A-Za-z0-9_-])`);
    if (re.test(haystack)) return name;
  }
  return null;
}

/**
 * Mention wakes: text token → issue control labels → mention_help.
 * Never silently defaults to SDD.
 */
export function resolveMentionAction({ text, payload, project }) {
  const token = controlLabelTokenInText(text, project);
  if (token) {
    const mapped = labeledAction(token, project);
    if (mapped) return mapped;
  }
  const fromLabels = actionFromLabels(payload, project, { forComment: false });
  if (fromLabels) return fromLabels;
  return ACTIONS.MENTION_HELP;
}

/** Configured control-label names for help copy (deduped, stable order). */
export function configuredControlLabels(project) {
  return [...new Set(controlLabelsInPriority(project))];
}

export function classify({ event, payload, project }) {
  if (!project) return ignore('unregistered repository');
  if (event === 'ping') return ignore('ping');
  if (!payload?.issue) return ignore(`unsupported event "${event}"`);

  const action = payload.action;
  const L = projectLabels(project);

  if (event === 'issues') {
    switch (action) {
      case 'labeled': {
        if (isAgentAuthor(payload.sender, project)) {
          return ignore('label was applied by the agent');
        }
        const name = payload.label?.name;
        if (!isTrustedActor(event, payload)) {
          return ignore('actor is not a write collaborator');
        }
        const mapped = labeledAction(name, project);
        if (mapped) return { kind: 'enqueue', action: mapped };
        return ignore(`label "${name}" is not a stage, execute, test or triage label`);
      }

      case 'assigned':
        if (!(project.agent_login && payload.assignee?.login === project.agent_login)) {
          return ignore('assignee is not the agent login');
        }
        if (!isTrustedActor(event, payload)) {
          return ignore('actor is not a write collaborator');
        }
        return { kind: 'enqueue', action: ACTIONS.SDD };

      case 'opened':
      case 'reopened': {
        if (!isTrustedActor(event, payload)) {
          return ignore('actor is not a write collaborator');
        }
        // Mentions use text token → issue labels → help (trigger label → SDD, not opened).
        if (issueBodyHasMention(payload, project)) {
          return {
            kind: 'enqueue',
            action: resolveMentionAction({
              text: payload.issue?.body || '',
              payload,
              project,
            }),
          };
        }
        if (hasLabel(payload, L.execute)) {
          return { kind: 'enqueue', action: ACTIONS.EXECUTE };
        }
        if (hasLabel(payload, L.test)) {
          return { kind: 'enqueue', action: ACTIONS.TEST };
        }
        if (hasLabel(payload, L.trigger)) {
          return { kind: 'enqueue', action: ACTIONS.OPENED };
        }
        if (hasLabel(payload, L.research)) {
          return { kind: 'enqueue', action: ACTIONS.RESEARCH };
        }
        if (hasLabel(payload, L.graphic)) {
          return { kind: 'enqueue', action: ACTIONS.GRAPHIC };
        }
        if (hasLabel(payload, L.monitor)) {
          return { kind: 'enqueue', action: ACTIONS.MONITOR };
        }
        if (hasLabel(payload, L.triage)) {
          return { kind: 'enqueue', action: ACTIONS.TRIAGE };
        }
        return ignore('issue does not carry a stage, execute, test or triage label and body has no mention');
      }

      case 'closed':
        return { kind: 'cancel', reason: 'issue closed' };

      case 'unlabeled':
        if (payload.label?.name === L.trigger) {
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
    if (!isTrustedActor(event, payload)) {
      return ignore('actor is not a write collaborator');
    }
    const body = payload.comment?.body || '';
    if (textHasMention(body, project)) {
      return {
        kind: 'enqueue',
        action: resolveMentionAction({ text: body, payload, project }),
      };
    }
    const fromLabels = actionFromLabels(payload, project, { forComment: true });
    if (fromLabels) return { kind: 'enqueue', action: fromLabels };
    // Triage is one-shot: later comments do not re-triage.
    return ignore('comment has no agent mention and the issue lacks a revisable stage or execute/test label');
  }

  return ignore(`unsupported event "${event}"`);
}
