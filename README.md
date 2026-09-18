# Agent Task Queue

A small Express + SQLite service that turns GitHub issue activity into a queue of tasks
for a local coding agent. GitHub posts webhooks through a Cloudflare tunnel; the host
orchestrator polls for work, leases a task, and reports back when it is done.

This is the queue half of [PLAN.md](PLAN.md). The orchestrator (worktrees, Neon branches,
Herdr panes) is the consumer and lives outside this repo.

```
[ GitHub issue / comment ]
          |  webhook, HMAC-signed
[ cloudflared quick tunnel ]
          |
[ webhook-server (Docker) ] --- agent_tasks (SQLite, WAL)
          |  leased over localhost:3000
[ host orchestrator ] --> git worktree + Neon branch + Herdr pane
```

## Quick start

```bash
cp .env.example .env                       # then fill in the secrets
openssl rand -hex 32                       # one for GITHUB_WEBHOOK_SECRET, one for AGENT_POLL_SECRET
cp config/projects.example.json config/projects.json
docker compose -f docker-compose.dev.yml up -d --build
docker compose -f docker-compose.dev.yml logs -f webhook-server
```

The server prints the public URL once the tunnel is up:

```
[Server] Webhook URL: https://<random>.trycloudflare.com/api/agent/webhook
```

Add that to each repo under **Settings -> Webhooks**, with content type
`application/json`, the matching secret, and the **Issues** and **Issue comments** events.

> A quick tunnel mints a new hostname every time it restarts, so you have to re-paste that
> URL after each restart. Switch to a named tunnel if that becomes annoying.

Running without Docker:

```bash
npm install
npm test
DB_PATH=./sqlite_data/shared/agent_queue.db PROJECTS_CONFIG=./config/projects.json npm run dev
```

## Tenant registry

`config/projects.json` maps repositories to projects. It is bind-mounted read-only and
re-read on `SIGHUP` (`docker compose kill -s HUP webhook-server`).

```json
{
  "projects": [
    {
      "slug": "main-app",
      "repo": "my-org/primary-app",
      "default_branch": "main",
      "trigger_label": "agent:assigned",
      "mention": "@dev-agent",
      "agent_login": "dev-agent",
      "webhook_secret_env": "WEBHOOK_SECRET_MAIN_APP"
    }
  ]
}
```

`webhook_secret_env` is optional; without it the project uses `GITHUB_WEBHOOK_SECRET`. With
it, that repo's deliveries are verified against its own secret, so one tenant's webhook
secret cannot be used to post as another. A declared-but-unset variable fails closed rather
than quietly falling back to the global secret.

A signed delivery from a repo that is not listed is acknowledged with 202 and logged, never
queued. Set `ALLOW_UNKNOWN_REPOS=true` to accept them under a slug derived from the repo
name instead.

### What becomes a task

| Event | Condition | Result |
| --- | --- | --- |
| `issues.labeled` | label matches `trigger_label` | queue `agent:assigned` |
| `issues.assigned` | assignee matches `agent_login` | queue `agent:assigned` |
| `issues.opened` / `reopened` | issue already carries `trigger_label` | queue `agent:opened` |
| `issue_comment.created` | body contains `mention`, or the issue carries `trigger_label` | queue `comment_created` |
| `issues.closed` | — | cancel that issue's pending tasks |
| `issues.unlabeled` | label matches `trigger_label` | cancel that issue's pending tasks |

Everything else gets a 200 with `{ "ignored": true }` so GitHub does not keep retrying.

## Task context

Each task stores the raw delivery in `payload` and a normalized manifest in `context`. The
manifest keeps the issue body, the triggering comment, and extracted references separate,
and every reference records which of the two it came from:

```jsonc
{
  "schema_version": 1,
  "trigger":   { "event": "issue_comment", "action": "comment_created", "comment_id": 992 },
  "project":   { "slug": "main-app", "default_branch": "main" },
  "repo":      { "full_name": "my-org/primary-app", "clone_url": "...", "default_branch": "main" },
  "issue":     { "number": 42, "title": "...", "labels": [...],
                 "body": { "raw": "...", "task_list": [{ "checked": false, "text": "..." }] } },
  "trigger_comment": { "id": 992, "author": "...", "body": { "raw": "..." } },
  "references": {
    "files": [{ "path": "src/lib/foo.ts", "line_start": 10, "line_end": 20,
                "ref": "main", "permalink": "...", "via": "permalink",
                "source": "issue_body", "source_id": null }],
    "issues": [...], "pull_requests": [...], "commits": [...], "urls": [...], "code_blocks": [...]
  },
  "fetch": {
    "comments_url": "https://api.github.com/repos/my-org/primary-app/issues/42/comments",
    "comment_count": 7,
    "comments_included": 1,
    "note": "Only the triggering comment is embedded. Fetch comments_url for the full thread."
  }
}
```

**A webhook payload never contains the comment thread** — an `issues` event carries only the
body, and an `issue_comment` event carries only the one comment. So `fetch` states how many
comments exist and where to get them, which is exactly what step 1 of
[.cursor/rules/agent-instructions.md](.cursor/rules/agent-instructions.md) tells the agent to
do with `get_issue_comments`. The `references.files` array feeds step 2's codebase scan;
paths are picked up from blob permalinks, backticked paths with `:10-20` suffixes, bare
path-shaped tokens (including inside pasted stack traces), and `path=` on a code fence.

## API

All `/api/agent/*` endpoints except the webhook require `Authorization: Bearer $AGENT_POLL_SECRET`.

- `POST /api/agent/webhook` — GitHub delivery endpoint. Verifies `X-Hub-Signature-256`
  against the raw request bytes and deduplicates on `X-GitHub-Delivery`.
- `POST /api/agent/poll` — lease the oldest eligible task. Optional body:
  `{ "project_slug": "main-app" }` or `{ "project_slugs": [...] }`, `{ "worker": "..." }`,
  `{ "lease_seconds": 1800 }`. Returns `{ "task": ... | null }`. A body is not required.
- `POST /api/agent/tasks/:id/complete`
- `POST /api/agent/tasks/:id/fail` — `{ "error": "..." }`. Re-queues with exponential
  backoff until `max_attempts`, then marks the task failed.
- `POST /api/agent/tasks/:id/heartbeat` — extend the lease on a long-running task.
- `GET /api/agent/tasks?status=&project_slug=&limit=` — inspection.
- `GET /api/health` — SQLite version, journal mode, mode, tenants, task counts. Unauthenticated.

A claimed task is leased for `LEASE_SECONDS`. If the orchestrator dies, the reaper returns
the task to `pending` (or `failed` once attempts are spent) rather than leaving it stuck in
`processing`. Only one task per issue is ever in flight, so a burst of comments cannot make
the orchestrator open two worktrees for the same issue.

### Note for the orchestrator

`github_issue_id` is GitHub's internal ID; the `#42` you want for branch and worktree names
is `github_issue_number` (also at `context.issue.number`). `PLAN.md`'s draft orchestrator
uses `github_issue_id` for both — use `github_issue_number` there instead.

## Deployment topology

One shared instance serves every repo in the registry, and that is the default. Running one
stack per project is supported but rarely necessary: the queue container holds only
`GITHUB_WEBHOOK_SECRET` and `AGENT_POLL_SECRET`, while the credentials actually worth
isolating (the PAT, the Neon key, the blob token, the ephemeral `DATABASE_URL`) live in the
orchestrator and in each worktree's `.env.local`. Cross-project concurrency already happens
at the agent-runner layer, which spawns a container per issue.

Isolated mode exists for genuine blast-radius or commingling requirements:

```bash
cp .env .env.main-app     # set PROJECT_SLUG=main-app, HOST_PORT=3001, DATA_DIR=main-app
docker compose -p main-app --env-file .env.main-app \
  -f docker-compose.dev.yml -f docker-compose.project.yml up -d
```

`PROJECT_SLUG` pins the instance to one project and rejects every other repo, even one
present in the same `projects.json`, and makes `/api/agent/poll` ignore a mismatched slug
from the caller. Each stack needs its own `HOST_PORT` and `DATA_DIR`, and brings up its own
tunnel with its own hostname.

## Reading the queue directly

`.cursor/mcp.json` configures the SQLite MCP server against `sqlite_data/`, but treat it as
a debugging convenience only. The container holds that file open in WAL mode across a Docker
Desktop bind mount, and WAL coordinates readers through a shared-memory `-shm` file that does
not cross the macOS VM boundary reliably. Host-side reads can be stale or hit locking errors.

**Use `GET /api/agent/tasks` for anything that matters.**

## Environment

| Variable | Purpose |
| --- | --- |
| `GITHUB_WEBHOOK_SECRET` | Fallback HMAC secret for projects without their own |
| `WEBHOOK_SECRET_*` | Per-project secret, named by `webhook_secret_env` |
| `AGENT_POLL_SECRET` | Bearer token for the orchestrator endpoints |
| `PROJECTS_CONFIG` | Registry path, default `/config/projects.json` |
| `PROJECT_SLUG` | Isolated mode only; pins the instance to one project |
| `DB_PATH`, `PORT` | SQLite file and listen port |
| `HOST_PORT`, `DATA_DIR` | Compose-only: published loopback port and data subdirectory |
| `ALLOW_UNKNOWN_REPOS` | Accept repos absent from the registry, default `false` |
| `LEASE_SECONDS`, `MAX_ATTEMPTS`, `RETRY_BACKOFF_SECONDS`, `REAPER_INTERVAL_SECONDS` | Queue behaviour |
| `TUNNEL_METRICS_URL` | cloudflared metrics endpoint used to log the webhook URL |

## Development

```bash
npm test                                   # node --test, no network or Docker needed
npm run replay                             # full loop against a running server
node scripts/replay-delivery.mjs --fixture issue_comment.created.json --event issue_comment
node scripts/replay-delivery.mjs --leave-pending   # queue a task for the real orchestrator
```

`scripts/replay-delivery.mjs` signs a fixture, delivers it, verifies the redelivery is
deduplicated, then polls, heartbeats, and completes — no GitHub and no tunnel involved.

Layout:

```
src/     server.mjs db.mjs auth.mjs projects.mjs triggers.mjs
         context.mjs references.mjs queue.mjs tunnel.mjs
db/schema.sql            applied idempotently at boot
config/                  tenant registry (projects.json is gitignored)
docker/                  server image and the agent-runner image
tests/  fixtures/        node --test suite and GitHub payload fixtures
```

Requires SQLite 3.45+ for `jsonb()`; `src/db.mjs` asserts this at boot rather than failing
later with `no such function: jsonb`.
