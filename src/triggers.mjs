/**
 * Decide whether a delivery becomes an agent task, and under which action.
 *
 * Returns one of:
 *   { kind: 'enqueue', action }  - queue a task
 *   { kind: 'cancel', reason }   - drop this issue's pending tasks
 *   { kind: 'ignore', reason }   - acknowledge with 200 so GitHub does not retry
 *
 * Wake tokens (defaults) — must appear backticked in the issue/comment body, e.g. `agent:sdd`:
 *   agent:triage — labels + sizing comment; no branch
 *   agent:research / agent:wireframe / agent:sdd / agent:monitor — stage markdown under .agent/plans/{n}/
 *   agent:execute — implement from PLAN.md; write TEST.md Instructions
 *   agent:test — run TEST.md Instructions; write Results
 *
 * Gates: agent_login already assigned on the issue, plus a backticked token in that event's text.
 * Label/assign webhooks do not wake. Cancel only on issue closed.
 */

export const ACTIONS = {
  SDD: 'agent:sdd',
  /** @deprecated Use ACTIONS.SDD. Kept as an alias for older imports. */
  ASSIGNED: 'agent:sdd',
  /** @deprecated No longer enqueued; kept for in-flight task mapping. */
  OPENED: 'agent:opened',
  EXECUTE: 'agent:execute',
  TRIAGE: 'agent:triage',
  RESEARCH: 'agent:research',
  WIREFRAME: 'agent:wireframe',
  /** @deprecated Use ACTIONS.WIREFRAME. Kept for in-flight task mapping. */
  GRAPHIC: 'agent:graphic',
  MONITOR: 'agent:monitor',
  TEST: 'agent:test',
  /** @deprecated No longer enqueued; kept for in-flight task mapping. */
  COMMENT: 'comment_created',
  /** Sticky usage reply when wake cannot start a run (missing assignee and/or token). */
  MENTION_HELP: 'mention_help',
};

function projectLabels(project) {
  return {
    trigger: project.trigger_label || 'agent:sdd',
    execute: project.execute_label || 'agent:execute',
    triage: project.triage_label || 'agent:triage',
    research: project.research_label || 'agent:research',
    wireframe: project.wireframe_label || 'agent:wireframe',
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
 * Comments and newly opened issues can come from anyone who can see the repo.
 * Label/assign events are ignored for wake; association checks remain for opened/comment.
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

  return false;
}

/**
 * The agent's own comments must never re-trigger it.
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

/** True when project.agent_login is already on the issue's assignee list. */
export function issueHasAgentAssignee(payload, project) {
  const login = project?.agent_login;
  if (!login) return false;
  const want = String(login).toLowerCase();
  const assignees = payload?.issue?.assignees || [];
  return assignees.some((a) => {
    const name = typeof a === 'string' ? a : a?.login;
    return name && String(name).toLowerCase() === want;
  });
}

/**
 * Control-token names in SDLC Status order (earliest stage first).
 * When several backticked tokens appear, prefer the earliest stage to avoid jumping ahead.
 */
function controlLabelsInStatusOrder(project) {
  const L = projectLabels(project);
  return [L.triage, L.research, L.wireframe, L.trigger, L.execute, L.test, L.monitor].filter(Boolean);
}

/** Token name → wake action (trigger maps to SDD). */
function actionForControlToken(name, project) {
  const L = projectLabels(project);
  if (name === L.execute) return ACTIONS.EXECUTE;
  if (name === L.test) return ACTIONS.TEST;
  if (name === L.trigger) return ACTIONS.SDD;
  if (name === L.research) return ACTIONS.RESEARCH;
  if (name === L.wireframe) return ACTIONS.WIREFRAME;
  if (name === L.monitor) return ACTIONS.MONITOR;
  if (name === L.triage) return ACTIONS.TRIAGE;
  return null;
}

/**
 * First configured control token that appears wrapped in backticks, e.g. `agent:sdd`.
 * Status order: triage → research → wireframe → sdd → execute → test → monitor.
 */
export function controlLabelTokenInText(text, project) {
  const haystack = String(text || '');
  if (!haystack) return null;
  for (const name of controlLabelsInStatusOrder(project)) {
    if (haystack.includes('`' + name + '`')) return name;
  }
  return null;
}

/**
 * Resolve a wake from body/comment text.
 * Returns a run action, MENTION_HELP (sticky only), or null (ignore).
 * Caller must still enforce assignee for run actions; this maps token → action and help cases.
 */
export function resolveTextAction({ text, project }) {
  const token = controlLabelTokenInText(text, project);
  if (token) {
    const mapped = actionForControlToken(token, project);
    if (mapped) return mapped;
  }
  if (textHasMention(text, project)) return ACTIONS.MENTION_HELP;
  return null;
}

/** Configured control-token names for help copy (deduped, Status order). */
export function configuredControlLabels(project) {
  return [...new Set(controlLabelsInStatusOrder(project))];
}

/**
 * Shared path for opened + comment: trusted actor assumed by caller.
 * Token + assignee → enqueue run; token without assignee → mention_help sticky;
 * mention without token → mention_help; else ignore.
 */
function enqueueFromText({ text, payload, project, emptyReason }) {
  const resolved = resolveTextAction({ text, project });
  if (!resolved) return ignore(emptyReason);

  if (resolved === ACTIONS.MENTION_HELP) {
    return { kind: 'enqueue', action: ACTIONS.MENTION_HELP };
  }

  if (!issueHasAgentAssignee(payload, project)) {
    // Sticky help: assign the agent, then include a backticked token.
    return { kind: 'enqueue', action: ACTIONS.MENTION_HELP };
  }

  return { kind: 'enqueue', action: resolved };
}

export function classify({ event, payload, project }) {
  if (!project) return ignore('unregistered repository');
  if (event === 'ping') return ignore('ping');
  if (!payload?.issue) return ignore(`unsupported event "${event}"`);

  const action = payload.action;

  if (event === 'issues') {
    switch (action) {
      case 'labeled':
        return ignore('label events do not wake the agent');

      case 'unlabeled':
        return ignore('unlabel events do not wake or cancel');

      case 'assigned':
        return ignore('assignment does not wake the agent; comment with a backticked control token');

      case 'reopened':
        return ignore('reopened does not wake; comment with a backticked control token');

      case 'opened': {
        if (!isTrustedActor(event, payload)) {
          return ignore('actor is not a write collaborator');
        }
        return enqueueFromText({
          text: payload.issue?.body || '',
          payload,
          project,
          emptyReason: 'issue body has no backticked control token and no agent mention',
        });
      }

      case 'closed':
        return { kind: 'cancel', reason: 'issue closed' };

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
    return enqueueFromText({
      text: payload.comment?.body || '',
      payload,
      project,
      emptyReason: 'comment has no backticked control token and no agent mention',
    });
  }

  return ignore(`unsupported event "${event}"`);
}
