#!/usr/bin/env node
/**
 * Drive the full loop against a running server with no GitHub and no tunnel involved:
 * sign a fixture, deliver it, claim it, heartbeat it, then complete it.
 *
 *   npm run replay
 *   node scripts/replay-delivery.mjs --fixture issue_comment.created.json --event issue_comment
 *   node scripts/replay-delivery.mjs --base http://localhost:3000 --leave-pending
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { signBody } from '../src/auth.mjs';

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: process.env.QUEUE_BASE_URL || 'http://127.0.0.1:3000' },
    fixture: { type: 'string', default: 'issues.labeled.json' },
    event: { type: 'string', default: 'issues' },
    delivery: { type: 'string' },
    secret: { type: 'string', default: process.env.GITHUB_WEBHOOK_SECRET || '' },
    'poll-secret': { type: 'string', default: process.env.AGENT_POLL_SECRET || '' },
    'leave-pending': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
  process.exit(0);
}

const base = values.base.replace(/\/$/, '');
const deliveryId = values.delivery || `replay-${Date.now()}`;
const pollSecret = values['poll-secret'];

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

if (!values.secret) fail('No webhook secret. Pass --secret or set GITHUB_WEBHOOK_SECRET.');
if (!pollSecret) fail('No poll secret. Pass --poll-secret or set AGENT_POLL_SECRET.');

const authHeaders = { authorization: `Bearer ${pollSecret}`, 'content-type': 'application/json' };
const step = (label, detail) => console.log(`OK    ${label}${detail ? ` — ${detail}` : ''}`);

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// 1. Health -----------------------------------------------------------------
const health = await fetch(`${base}/api/health`).catch(() => null);
if (!health?.ok) fail(`${base}/api/health is unreachable. Is the server running?`);
const healthBody = await readJson(health);
step('health', `sqlite ${healthBody.sqlite_version}, ${healthBody.mode} mode, projects: ${healthBody.projects.join(', ') || 'none'}`);

// 2. Signed delivery --------------------------------------------------------
const body = readFileSync(new URL(`../fixtures/${values.fixture}`, import.meta.url));
const delivered = await fetch(`${base}/api/agent/webhook`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-github-event': values.event,
    'x-github-delivery': deliveryId,
    'x-hub-signature-256': signBody(body, values.secret),
  },
  body,
});
const deliveredBody = await readJson(delivered);
if (delivered.status !== 201) {
  fail(`webhook returned ${delivered.status}: ${JSON.stringify(deliveredBody)}`);
}
step('webhook', `queued ${deliveredBody.task_id} for ${deliveredBody.project_slug} (${deliveredBody.action})`);

// 3. Redelivery must dedupe -------------------------------------------------
const repeat = await fetch(`${base}/api/agent/webhook`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-github-event': values.event,
    'x-github-delivery': deliveryId,
    'x-hub-signature-256': signBody(body, values.secret),
  },
  body,
});
const repeatBody = await readJson(repeat);
if (!repeatBody.duplicate) fail(`redelivery of ${deliveryId} was not deduplicated`);
step('redelivery', 'deduplicated, no second task');

if (values['leave-pending']) {
  step('done', `task ${deliveredBody.task_id} left pending for the orchestrator`);
  process.exit(0);
}

// 4. Claim ------------------------------------------------------------------
const polled = await fetch(`${base}/api/agent/poll`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ worker: 'replay-script' }),
});
const { task } = await readJson(polled);
if (!task) fail('poll returned no task');
const ctx = task.context;
step(
  'poll',
  `${task.id} attempt ${task.attempts}, lease until ${task.lease_expires_at}`
);
console.log(
  `      context: issue #${ctx.issue.number} "${ctx.issue.title}" | ` +
    `${ctx.references.files.length} file ref(s) | ` +
    `${ctx.fetch.comments_included}/${ctx.fetch.comment_count} comment(s) embedded`
);
for (const file of ctx.references.files) {
  const lines = file.line_start ? `:${file.line_start}${file.line_end !== file.line_start ? `-${file.line_end}` : ''}` : '';
  console.log(`        - [${file.source}] ${file.path}${lines} (${file.via})`);
}

// 5. Heartbeat --------------------------------------------------------------
const beat = await fetch(`${base}/api/agent/tasks/${task.id}/heartbeat`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ lease_seconds: 120 }),
});
const beatBody = await readJson(beat);
if (!beatBody.ok) fail(`heartbeat failed: ${JSON.stringify(beatBody)}`);
step('heartbeat', `lease extended to ${beatBody.lease_expires_at}`);

// 6. Complete ---------------------------------------------------------------
const completed = await fetch(`${base}/api/agent/tasks/${task.id}/complete`, {
  method: 'POST',
  headers: authHeaders,
});
const completedBody = await readJson(completed);
if (completedBody.task?.status !== 'completed') {
  fail(`complete failed: ${JSON.stringify(completedBody)}`);
}
step('complete', `task ${task.id} is ${completedBody.task.status}`);

// 7. Completing twice must not silently succeed -----------------------------
const again = await fetch(`${base}/api/agent/tasks/${task.id}/complete`, { method: 'POST', headers: authHeaders });
if (again.status !== 409) fail(`expected 409 on a second complete, got ${again.status}`);
step('idempotency', 'a second complete is rejected with 409');

console.log('\nAll steps passed.');
