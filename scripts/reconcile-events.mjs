#!/usr/bin/env node
/**
 * List recent GitHub issue activity that would trigger the agent, compare to the queue,
 * and optionally enqueue missed work via the control-plane ingest endpoint.
 *
 *   npm run reconcile
 *   node scripts/reconcile-events.mjs --since 48h --project main-app
 *   node scripts/reconcile-events.mjs --enqueue 3
 *   node scripts/reconcile-events.mjs --comments   # include comment previews in output
 *
 * Requires GITHUB_TOKEN and AGENT_POLL_SECRET (.env.orchestrator). Lists tasks via the control
 * listener (default 127.0.0.1:3001). --enqueue prefers POST /api/agent/ingest; if the running
 * webhook-server image is older than that route, falls back to the host-mounted SQLite queue file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { loadConfig } from '../orchestrator/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { handleDelivery } from '../src/delivery.mjs';
import { createLogger, loadConfig as loadServerConfig } from '../src/server.mjs';
import { classify } from '../src/triggers.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const API = 'https://api.github.com';

const { values } = parseArgs({
  options: {
    since: { type: 'string', default: '72h' },
    project: { type: 'string', default: '' },
    limit: { type: 'string', default: '80' },
    enqueue: { type: 'string', default: '' },
    json: { type: 'boolean', default: false },
    comments: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

const MISSED_TASK_LABEL = 'no task since event — enqueue';

if (values.help) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
  process.exit(0);
}

function parseSince(text) {
  const match = /^(\d+)([hd])$/.exec(String(text || ''));
  if (!match) throw new Error(`--since expects a value like 48h or 7d, got "${text}"`);
  const [, amount, unit] = match;
  return Number(amount) * (unit === 'h' ? 3600 : 86400) * 1000;
}

function fail(message) {
  console.error(`reconcile: ${message}`);
  process.exit(1);
}

function parseSqliteTime(text) {
  if (!text) return null;
  const normalized = String(text).includes('T') ? text : `${text.replace(' ', 'T')}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatWhen(date) {
  if (!date) return '—';
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

const COMMENT_PREVIEW_MAX_LINES = 20;
const COMMENT_PREVIEW_MAX_CHARS = 600;
const COMMENT_PREVIEW_MAX_LINE_CHARS = 100;

function commentPreviewText(text) {
  if (!text) return '';
  const allLines = String(text).split(/\r?\n/);
  const lines = allLines.slice(0, COMMENT_PREVIEW_MAX_LINES).map((line) =>
    line.length > COMMENT_PREVIEW_MAX_LINE_CHARS
      ? `${line.slice(0, COMMENT_PREVIEW_MAX_LINE_CHARS - 1)}…`
      : line
  );
  let out = lines.join('\n');
  const overLines = allLines.length > COMMENT_PREVIEW_MAX_LINES;
  if (out.length > COMMENT_PREVIEW_MAX_CHARS) {
    out = `${out.slice(0, COMMENT_PREVIEW_MAX_CHARS - 1)}…`;
  } else if (overLines) {
    out = `${out}\n…`;
  }
  return out;
}

function commentTableCell(preview) {
  if (!preview) return '—';
  const first = preview.split('\n')[0] || '';
  const oneLine = first.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '—';
  const more = preview.includes('\n') || preview.endsWith('…');
  const suffix = more ? ' …' : '';
  return (oneLine.length > 36 ? `${oneLine.slice(0, 35)}…` : oneLine) + suffix;
}

function controlBase(config) {
  const { host, port, socketPath } = config.queue;
  if (socketPath) return `http://${host}:${port}`;
  return `http://${host}:${port}`;
}

async function github(token, path) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'tmt-agent-reconcile',
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text.slice(0, 200) };
  }
  if (!res.ok) {
    throw new Error(`GitHub ${path} (${res.status}): ${body?.message || text}`);
  }
  return body;
}

async function listIssuesUpdatedSince(token, owner, repo, sinceIso) {
  const params = new URLSearchParams({
    state: 'open',
    since: sinceIso,
    sort: 'updated',
    direction: 'desc',
    per_page: '100',
  });
  const list = await github(token, `/repos/${owner}/${repo}/issues?${params}`);
  return (Array.isArray(list) ? list : []).filter((item) => !item.pull_request);
}

async function listIssueEvents(token, owner, repo, issueNumber) {
  const list = await github(
    token,
    `/repos/${owner}/${repo}/issues/${issueNumber}/events?per_page=100`
  );
  return Array.isArray(list) ? list : [];
}

async function listIssueCommentsSince(token, owner, repo, issueNumber, sinceIso) {
  const params = new URLSearchParams({ since: sinceIso, per_page: '100' });
  const list = await github(
    token,
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments?${params}`
  );
  return Array.isArray(list) ? list : [];
}

async function getRepository(token, owner, repo) {
  return github(token, `/repos/${owner}/${repo}`);
}

function issueToWebhookIssue(issue) {
  return {
    id: issue.id,
    node_id: issue.node_id,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.url,
    html_url: issue.html_url,
    comments_url: issue.comments_url,
    comments: issue.comments,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    user: issue.user,
    labels: issue.labels,
    assignees: issue.assignees,
    body: issue.body,
  };
}

function buildLabeledPayload({ issue, repository, label, sender }) {
  return {
    action: 'labeled',
    issue: issueToWebhookIssue(issue),
    label,
    repository,
    sender,
  };
}

function buildCommentPayload({ issue, repository, comment, sender }) {
  return {
    action: 'created',
    issue: issueToWebhookIssue(issue),
    comment,
    repository,
    sender,
  };
}

function latestTasksByIssue(tasks) {
  const map = new Map();
  for (const task of tasks) {
    const key = `${task.project_slug}:${task.github_issue_number}`;
    const prev = map.get(key);
    if (!prev || String(task.created_at) > String(prev.created_at)) {
      map.set(key, task);
    }
  }
  return map;
}

function tasksAfterEvent(tasks, projectSlug, issueNumber, eventAt) {
  return tasks.filter((t) => {
    if (t.project_slug !== projectSlug || t.github_issue_number !== issueNumber) return false;
    const created = parseSqliteTime(t.created_at);
    return created && eventAt && created >= eventAt;
  });
}

function suggestAction({ verdict, eventAt, tasksAfter }) {
  if (verdict.kind === 'ignore') return { code: 'skip', label: verdict.reason };
  if (verdict.kind === 'cancel') return { code: 'skip', label: `cancel: ${verdict.reason}` };

  const active = tasksAfter.find((t) => t.status === 'pending' || t.status === 'processing');
  if (active) {
    return { code: 'ok', label: `queued (${active.status})` };
  }
  const completed = tasksAfter.find((t) => t.status === 'completed');
  if (completed) {
    return { code: 'ok', label: 'task completed after event' };
  }
  const failed = tasksAfter.find((t) => t.status === 'failed');
  if (failed) {
    return { code: 'enqueue', label: 'failed — re-enqueue?' };
  }
  if (tasksAfter.length === 0) {
    return { code: 'enqueue', label: MISSED_TASK_LABEL };
  }
  return { code: 'review', label: 'review queue history' };
}

function formatNextStep(row) {
  if (row._suggestionCode === 'enqueue' && row._suggestionLabel === MISSED_TASK_LABEL) {
    return `npm run reconcile -- --enqueue ${row.id}`;
  }
  return row._suggestionLabel;
}

function printTable(rows, { showComments = false } = {}) {
  const cols = [
    ['#', 3],
    ['When', 20],
    ['Project', 12],
    ['Issue', 7],
    ['Event', 22],
    ['Queue action', 18],
    ['Latest task', 16],
    ...(showComments ? [['Comment', 38]] : []),
    ['Next step', 40],
  ];

  const header = cols.map(([name, w]) => name.padEnd(w)).join('  ');
  console.log(header);
  console.log(cols.map(([, w]) => '─'.repeat(w)).join('  '));

  for (const row of rows) {
    const parts = [
      String(row.id).padEnd(3),
      row.when.padEnd(20),
      row.project.slice(0, 12).padEnd(12),
      `#${row.issue}`.padEnd(7),
      row.event.slice(0, 22).padEnd(22),
      row.action.slice(0, 18).padEnd(18),
      row.taskStatus.slice(0, 16).padEnd(16),
    ];
    if (showComments) {
      parts.push(commentTableCell(row.commentPreview).slice(0, 38).padEnd(38));
    }
    parts.push(formatNextStep(row).slice(0, 40).padEnd(40));
    console.log(parts.join('  '));
  }

  if (showComments) {
    const withComments = rows.filter((r) => r.commentPreview);
    if (withComments.length) {
      console.log('');
      console.log(
        `Comment previews (≤${COMMENT_PREVIEW_MAX_LINES} lines, ${COMMENT_PREVIEW_MAX_CHARS} chars):`
      );
      for (const row of withComments) {
        console.log('');
        console.log(`#${row.id}  ${row.project}  issue #${row.issue}  ${row.when}`);
        console.log(row.commentPreview);
      }
    }
  }

  console.log('');
  console.log('Enqueue any row:  npm run reconcile -- --enqueue <#>');
  console.log('GitHub UI:        Settings → Webhooks → Recent Deliveries → Redeliver');
}

async function fetchQueueTasks(config, token) {
  const base = controlBase(config);
  const limit = 500;
  const res = await fetch(`${base}/api/agent/tasks?limit=${limit}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    fail(`queue ${base}/api/agent/tasks (${res.status}): ${text}`);
  }
  const body = await res.json();
  return body.tasks || [];
}

function resolveQueueDbPath() {
  const dataDir = process.env.DATA_DIR || 'shared';
  const defaultPath = resolve(REPO_ROOT, `sqlite_data/${dataDir}/agent_queue.db`);
  const raw = process.env.QUEUE_DB_PATH || process.env.DB_PATH;
  if (!raw || raw.startsWith('/app/')) return defaultPath;
  return resolve(REPO_ROOT, raw);
}

function ingestViaQueueDb(registry, { event, payload, deliveryId }) {
  const dbPath = resolveQueueDbPath();
  if (!existsSync(dbPath)) return null;
  const db = openDatabase(dbPath);
  try {
    const serverConfig = loadServerConfig(process.env);
    const log = createLogger('Reconcile');
    return handleDelivery({
      db,
      registry,
      config: serverConfig,
      log,
      event,
      payload,
      deliveryId,
      deliveredAt: new Date().toISOString(),
    });
  } finally {
    db.close();
  }
}

async function ingestDelivery(config, pollSecret, { event, payload, deliveryId }) {
  const base = controlBase(config);
  const res = await fetch(`${base}/api/agent/ingest`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${pollSecret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ event, payload, delivery_id: deliveryId }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function ingestDeliveryWithFallback(config, pollSecret, ingest) {
  const http = await ingestDelivery(config, pollSecret, ingest);
  const missingIngest =
    http.status === 404 && String(http.body?.error || '').includes('/api/agent/ingest');
  if (!missingIngest) return http;

  const local = ingestViaQueueDb(config.registry, ingest);
  if (!local) {
    fail(
      'POST /api/agent/ingest is not on the control plane — rebuild the queue container:\n' +
        '  docker compose -f docker-compose.dev.yml build webhook-server\n' +
        '  docker compose -f docker-compose.dev.yml up -d webhook-server\n' +
        `(or set QUEUE_DB_PATH to the mounted queue file; looked for ${resolveQueueDbPath()})`
    );
  }
  console.warn('reconcile: control plane missing /api/agent/ingest — wrote via local SQLite');
  return { status: local.status, body: local.body };
}

const config = loadConfig();
const token = config.secrets.GITHUB_TOKEN;
const pollSecret = config.secrets.AGENT_POLL_SECRET;
if (!token) fail('GITHUB_TOKEN is not set (.env.orchestrator)');
if (!pollSecret) fail('AGENT_POLL_SECRET is not set (.env.orchestrator)');

const sinceMs = parseSince(values.since);
const sinceDate = new Date(Date.now() - sinceMs);
const sinceIso = sinceDate.toISOString();

const projects = config.registry.list().filter((p) => !values.project || p.slug === values.project);
if (!projects.length) {
  fail(values.project ? `no project "${values.project}" in registry` : 'no projects in registry');
}

const queueTasks = await fetchQueueTasks(config, pollSecret);
const latestByIssue = latestTasksByIssue(queueTasks);

const candidates = [];

for (const project of projects) {
  const [owner, repo] = project.repo.split('/');
  const repository = await getRepository(token, owner, repo);
  const issues = await listIssuesUpdatedSince(token, owner, repo, sinceIso);

  for (const issue of issues) {
    const events = await listIssueEvents(token, owner, repo, issue.number);
    for (const ev of events) {
      const at = parseSqliteTime(ev.created_at);
      if (!at || at < sinceDate) continue;

      let eventName = null;
      let payload = null;

      if (ev.event === 'labeled' && ev.label) {
        eventName = 'issues';
        payload = buildLabeledPayload({
          issue,
          repository,
          label: ev.label,
          sender: ev.actor,
        });
      } else if (ev.event === 'assigned' && ev.assignee) {
        eventName = 'issues';
        payload = {
          action: 'assigned',
          issue: issueToWebhookIssue(issue),
          assignee: ev.assignee,
          repository,
          sender: ev.actor,
        };
      } else {
        continue;
      }

      const verdict = classify({ event: eventName, payload, project });
      const tasksAfter = tasksAfterEvent(queueTasks, project.slug, issue.number, at);
      const latest = latestByIssue.get(`${project.slug}:${issue.number}`);
      const suggestion = suggestAction({ verdict, eventAt: at, tasksAfter });

      candidates.push({
        at,
        project,
        issue: issue.number,
        event: `${eventName}.${payload.action}${ev.label ? ` (${ev.label.name})` : ''}`,
        verdict,
        suggestion,
        ingest: { event: eventName, payload },
        latest,
        htmlUrl: issue.html_url,
      });
    }

    const comments = await listIssueCommentsSince(token, owner, repo, issue.number, sinceIso);
    for (const comment of comments) {
      const at = parseSqliteTime(comment.created_at);
      if (!at || at < sinceDate) continue;

      const payload = buildCommentPayload({
        issue,
        repository,
        comment,
        sender: comment.user,
      });
      const verdict = classify({ event: 'issue_comment', payload, project });
      const tasksAfter = tasksAfterEvent(queueTasks, project.slug, issue.number, at);
      const latest = latestByIssue.get(`${project.slug}:${issue.number}`);
      const suggestion = suggestAction({ verdict, eventAt: at, tasksAfter });

      candidates.push({
        at,
        project,
        issue: issue.number,
        event: `issue_comment.created`,
        verdict,
        suggestion,
        ingest: { event: 'issue_comment', payload },
        latest,
        htmlUrl: issue.html_url,
        commentPreview: values.comments ? commentPreviewText(comment.body) : null,
      });
    }
  }
}

candidates.sort((a, b) => b.at - a.at);
const max = Math.min(Number(values.limit) || 80, 500);
const rows = candidates.slice(0, max).map((c, index) => {
  const queueAction =
    c.verdict.kind === 'enqueue' ? c.verdict.action : c.verdict.kind === 'cancel' ? 'cancel' : '—';
  const taskStatus = c.latest ? `${c.latest.status} (${c.latest.action})` : '—';
  return {
    id: index + 1,
    when: formatWhen(c.at),
    project: c.project.slug,
    issue: c.issue,
    event: c.event,
    action: queueAction,
    taskStatus,
    next: formatNextStep({
      id: index + 1,
      _suggestionCode: c.suggestion.code,
      _suggestionLabel: c.suggestion.label,
    }),
    ...(values.comments && c.commentPreview ? { commentPreview: c.commentPreview } : {}),
    _ingest: c.ingest,
    _verdict: c.verdict,
    _suggestionCode: c.suggestion.code,
    _suggestionLabel: c.suggestion.label,
    url: c.htmlUrl,
  };
});

if (values.json) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

if (!rows.length) {
  console.log(`No trigger-shaped GitHub activity in the last ${values.since} for ${projects.map((p) => p.slug).join(', ')}.`);
  process.exit(0);
}

printTable(rows, { showComments: values.comments });

const enqueueRow = values.enqueue ? Number(values.enqueue) : null;
if (enqueueRow) {
  const row = rows.find((r) => r.id === enqueueRow);
  if (!row) fail(`no row #${enqueueRow}`);
  if (row._suggestionCode === 'skip') {
    fail(`row #${enqueueRow} would be ignored by triggers: ${row._suggestionLabel}`);
  }
  const deliveryId = `reconcile-${Date.now()}-${row.project}-${row.issue}`;
  const { status, body } = await ingestDeliveryWithFallback(config, pollSecret, {
    ...row._ingest,
    deliveryId,
  });
  if (status === 201) {
    console.log(`Enqueued task ${body.task_id} (${body.action}) for ${body.project_slug}`);
  } else if (body.duplicate) {
    console.log(`Duplicate delivery; existing task ${body.task_id}`);
  } else if (body.ignored) {
    fail(`ingest ignored: ${body.reason}`);
  } else {
    fail(`ingest failed (${status}): ${JSON.stringify(body)}`);
  }
}
