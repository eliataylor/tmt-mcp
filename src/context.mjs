import { extractReferences, extractTaskList } from './references.mjs';

export const SCHEMA_VERSION = 1;

const COMMENTS_NOTE =
  'Only the triggering comment is embedded. Fetch comments_url for the full thread.';

function userLogin(user) {
  return user?.login ?? null;
}

function normalizeLabels(labels) {
  return (labels || []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
}

/**
 * Build the versioned context manifest stored alongside the raw delivery.
 *
 * The webhook payload carries the issue body and, for issue_comment events, exactly one
 * comment — never the thread. So the manifest is fully structured for what is present and
 * explicit about what is not: `fetch` tells the consumer how many comments exist and where
 * to get them, which is what step 1 of the agent protocol acts on.
 */
export function buildContext({ event, action, payload, project, deliveryId = null, deliveredAt = null }) {
  const issue = payload?.issue ?? {};
  const repo = payload?.repository ?? {};
  const comment = event === 'issue_comment' ? payload?.comment ?? null : null;

  const sources = [{ text: issue.body || '', source: 'issue_body', source_id: null }];
  if (comment) {
    sources.push({ text: comment.body || '', source: 'trigger_comment', source_id: comment.id ?? null });
  }

  const [owner, name] = (repo.full_name || '/').split('/');

  return {
    schema_version: SCHEMA_VERSION,

    trigger: {
      event,
      action,
      github_action: payload?.action ?? null,
      actor: userLogin(payload?.sender),
      comment_id: comment?.id ?? null,
      delivery_id: deliveryId,
      delivered_at: deliveredAt ?? new Date().toISOString(),
    },

    project: {
      slug: project.slug,
      default_branch: project.default_branch,
      trigger_label: project.trigger_label,
      mention: project.mention,
    },

    repo: {
      owner: repo.owner?.login ?? owner ?? null,
      name: repo.name ?? name ?? null,
      full_name: repo.full_name ?? null,
      clone_url: repo.clone_url ?? null,
      ssh_url: repo.ssh_url ?? null,
      // The repo's own default branch wins; the project setting is the fallback.
      default_branch: repo.default_branch ?? project.default_branch,
      private: repo.private ?? null,
    },

    issue: {
      id: issue.id ?? null,
      number: issue.number ?? null,
      title: issue.title ?? null,
      state: issue.state ?? null,
      author: userLogin(issue.user),
      labels: normalizeLabels(issue.labels),
      assignees: (issue.assignees || []).map(userLogin).filter(Boolean),
      url: issue.html_url ?? null,
      api_url: issue.url ?? null,
      created_at: issue.created_at ?? null,
      updated_at: issue.updated_at ?? null,
      // GitHub delivers PR comments as issue_comment events; the consumer needs to know.
      is_pull_request: Boolean(issue.pull_request),
      body: {
        raw: issue.body ?? '',
        task_list: extractTaskList(issue.body ?? ''),
      },
    },

    trigger_comment: comment
      ? {
          id: comment.id ?? null,
          author: userLogin(comment.user),
          created_at: comment.created_at ?? null,
          updated_at: comment.updated_at ?? null,
          url: comment.html_url ?? null,
          body: { raw: comment.body ?? '' },
        }
      : null,

    references: extractReferences(sources),

    fetch: {
      issue_url: issue.url ?? null,
      comments_url: issue.comments_url ?? null,
      comment_count: issue.comments ?? 0,
      comments_included: comment ? 1 : 0,
      note: COMMENTS_NOTE,
    },
  };
}
