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
| `issues.labeled` | applied by the agent itself | ignored — triage applies labels, and they must not re-trigger it |
| `issues.labeled` | label matches `trigger_label` | queue `agent:assigned` (**plan** — issue comment only) |
| `issues.labeled` | label matches `execute_label` (default `agent:execute`) | queue `agent:execute` (**implement** on the task branch) |
| `issues.labeled` | label matches `triage_label` (default `agent:triage`) | queue `agent:triage` (**triage** — labels + cross-links, no code) |
| `issues.assigned` | assignee matches `agent_login` | queue `agent:assigned` (plan) |
| `issues.opened` / `reopened` | issue carries `execute_label` | queue `agent:execute` |
| `issues.opened` / `reopened` | issue carries `trigger_label` (and not execute) | queue `agent:opened` (plan) |
| `issues.opened` / `reopened` | issue carries `triage_label` only | queue `agent:triage` |
| `issue_comment.created` | author is a `Bot`, or matches `agent_login` | ignored — the agent must not answer itself |
| `issue_comment.created` | body contains `mention` | queue `comment_created` (plan) or `agent:execute` if `execute_label` is on the issue |
| `issue_comment.created` | issue carries `execute_label` | queue `agent:execute` |
| `issue_comment.created` | issue carries `trigger_label` only | queue `comment_created` (plan) |
| `issues.closed` | — | cancel that issue's pending tasks |
| `issues.unlabeled` | label matches `trigger_label` | cancel that issue's pending tasks |

Plan mode's deliverable is an issue comment, posted while the trigger label is still on the
issue — so the author check above is what keeps the agent from triggering itself in a loop.
It only holds if `GITHUB_TOKEN` belongs to the agent and not to a human: with a shared personal
token the agent posts under your login, and setting `agent_login` to that login would silence
your own comments too. Give the agent its own machine user or GitHub App before relying on it.

Optional per-project overrides in `projects.json`: `execute_label` (default `agent:execute`) and
`triage_label` (default `agent:triage`).
Removing `execute_label` or `triage_label` does **not** cancel queued work; only losing
`trigger_label` or closing the issue does.

**Typical flow:** add `agent:assigned` → agent posts plan/questions on the issue → human adds `agent:execute` → agent implements.

Everything else gets a 200 with `{ "ignored": true }` so GitHub does not keep retrying.

### The three modes

| Mode | Queue action | Deliverable | Writes |
| --- | --- | --- | --- |
| **Triage** | `agent:triage` | Labels on the issue, plus one comment cross-linking related issues | Labels + 1 comment |
| **Plan** | `agent:assigned`, `agent:opened`, `comment_created` | One issue comment: understanding, open questions, implementation plan | 1 comment |
| **Execute** | `agent:execute` | The change itself, on `agent/issue-<n>`, summarized on the PR | Commits, push, PR comment |

Each mode's ground rules and definition of done are rendered into the task prompt by
[`orchestrator/prompt.mjs`](orchestrator/prompt.mjs), with this project's configured label names
substituted in, and **only for the mode that is running** — a triage prompt does not carry the
execute rules. [`.cursor/rules/agent-instructions.md`](.cursor/rules/agent-instructions.md) holds
only the part that is identical for every mode (MCP usage, context gathering, the untrusted-input
rule) and is inlined verbatim into all of them.

### Triage mode

`agent:triage` is the cheapest thing the agent can do to an issue: it reads the thread and the code,
applies labels, and posts one comment cross-linking the issues this one relates to. It never opens a
branch, a pull request, or a database branch, so the whole task is a clone, a container, and two API
writes.

The orchestrator skips every code-bearing stage for it — no start commit, no PR, no Neon branch, no
`.env.local`, no preview comment — and the clone stays on the default branch rather than
`agent/issue-<n>`, since checking out a previous task's unmerged work would misrepresent the current
state of the code.

Three constraints make it safe to leave on a busy repo:

- **It cannot push.** The read-only clone keeps its HTTPS fetch URL, so tooling can still tell which
  repository it is, but `remote.origin.pushurl` is set to `read-only://triage-tasks-do-not-push` —
  a scheme git has no transport for, so a push aborts locally instead of reaching GitHub. "Do not
  push" is enforced by git, not only by the prompt.

- **The agent labels from the existing vocabulary.** It lists the repo's labels over MCP and applies
  only names that come back; anything missing is proposed in the comment instead of created.
- **It cannot escalate itself.** The prompt forbids the `agent:*` control labels, and
  `issues.labeled` deliveries whose sender is the agent are ignored outright — so even a
  misbehaving run cannot label its way from triage into execute mode.

Related issues are found by shared files (paths cited in the thread, plus `git log` over those paths
to reach the PRs and issues that touched them) and by shared function (same route, table, dependency,
or user-facing flow). They are cross-linked by writing `#<number>` in the one comment on the triaged
issue, which is enough for GitHub to record the back-reference on the other side — the agent is told
not to comment on the other issues, so triaging a pile of issues does not spam every thread it
touches.

The prompt also tells triage to treat the issue as a report rather than as instructions, and gives it
two ways out of classifying something it cannot classify:

- **Too thin.** If the report does not say what was expected, what happened, or where, the agent asks
  for the missing pieces — URL, numbered steps, role, a screenshot or recording, a concrete example —
  instead of guessing a diagnosis. It reads `.github/ISSUE_TEMPLATE/` in the checkout first and points
  the reporter at the template that fits, so the ask matches what that repo already defines as a
  usable report.
- **Too old.** The issue header carries the opened and updated dates with their age in days, and past
  a week the prompt says outright that the issue may already be fixed, superseded, or describing a
  screen that no longer exists. The agent checks the current default branch and `git log --since` over
  the paths before calling an old report live, and can recommend closing — it still never closes
  anything itself.

A comment arriving later on a triaged issue does **not** re-triage it; triage is a one-shot
classification. Add `agent:assigned` when the issue deserves a plan.

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
comments exist and where to get them, which is exactly what
[.cursor/rules/agent-instructions.md](.cursor/rules/agent-instructions.md) tells the agent to
load via GitHub MCP (`get_issue`, `get_issue_comments`) and where to post plan replies (issue
comment via MCP). The `references.files` array feeds the codebase scan;
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

### Two listeners, not one

The webhook is the only thing the tunnel can reach. Everything else is on a second listener
bound to loopback:

| Listener | Port | Reachable from | Routes |
| --- | --- | --- | --- |
| Webhook | 3000, **not published** | cloudflared over `agent-net` | `POST /api/agent/webhook` |
| Control | 3001, published to `127.0.0.1` only | the host orchestrator | `poll`, `tasks`, `complete`, `fail`, `heartbeat`, `health` |

`cloudflared tunnel --url http://webhook-server:3000` proxies every path it can reach, so a
single combined app would put `/api/agent/poll` and `/api/agent/tasks` on a public
`trycloudflare.com` hostname — brute-forceable, unrate-limited — and `/api/health` would hand
any scanner the SQLite version and task counts. Those subdomains do get scanned; the random
name is not secret-grade.

Loopback alone does not stop a browser, because DNS rebinding re-resolves an attacker's domain
to `127.0.0.1` so the page's requests look same-origin. Three header checks close that, and a
CLI satisfies all three for free ([`src/net-guards.mjs`](src/net-guards.mjs)):

- `Host` must be in `CONTROL_ALLOWED_HOSTS` — a rebinding attempt arrives with the attacker's hostname
- no `Origin` header at all, since a CLI never sends one
- no `Sec-Fetch-Site` or `Sec-Fetch-Mode`, which browsers set and page JavaScript cannot strip

Webhook deliveries are additionally checked against the `hooks` CIDRs from
`api.github.com/meta`, read from `CF-Connecting-IP`. That is defense in depth behind the HMAC,
and a failure to load the ranges logs and skips rather than dropping every delivery.

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
cp .env .env.main-app     # set PROJECT_SLUG=main-app, CONTROL_HOST_PORT=3011, DATA_DIR=main-app
docker compose -p main-app --env-file .env.main-app \
  -f docker-compose.dev.yml -f docker-compose.project.yml up -d
```

`PROJECT_SLUG` pins the instance to one project and rejects every other repo, even one
present in the same `projects.json`, and makes `/api/agent/poll` ignore a mismatched slug
from the caller. Each stack needs its own `CONTROL_HOST_PORT` and `DATA_DIR`, and brings up its
own tunnel with its own hostname.

Runner containers live on a third network, `tmt-agent-runners`, declared in the compose file but
populated by the orchestrator's `docker run`. A user-defined bridge only connects containers
attached to it, so a runner cannot reach the queue, cloudflared, or another runner, while
outbound NAT still gives it the Cursor API, the GitHub API, and npm. That isolation is what lets
a runner hold no queue credential at all.

### Why the control plane is TCP and not a unix socket

A unix socket would be strictly better — browsers cannot address one, so CORS reasoning and DNS
rebinding both stop being relevant. It does not work here, and this was measured rather than
assumed: a socket bound inside the queue container on a Docker Desktop bind mount **does** show
up on the host as a socket inode over VirtioFS, but connecting to it fails with `ECONNREFUSED`
from both `node:http`'s `socketPath` and `curl --unix-socket`. The socket itself does not cross
the VM boundary — the same class of problem as the WAL `-shm` caveat below.

So the control plane is loopback TCP with the header guards above. `QUEUE_CONTROL_SOCKET` still
exists in the orchestrator config for the case where the queue runs directly on the host.

A user-defined bridge does **not** by itself keep a runner away from the host's published ports:
measured on Docker Desktop, a container on `tmt-agent-runners` still resolves
`host.docker.internal` (to an IPv6 ULA) and reaches a port published on the macOS host. That is
what `--add-host host.docker.internal:127.0.0.1` and `--add-host gateway.docker.internal:127.0.0.1`
are for, and they are load-bearing rather than belt-and-braces: with them, the same request fails
to connect at all.

The honest residual, all three states verified against a live control listener:

| From a runner | Result |
| --- | --- |
| `host.docker.internal:3301`, aliases blackholed | connection refused |
| Reaching the host address, `Host` header left alone | `403` — the Host allowlist rejects it |
| Reaching the host address **and** forging `Host: 127.0.0.1:3301` | `/api/health` returns `200`; `/api/agent/poll` returns `401` |

So a container that hardcodes the Docker Desktop host address and forges the Host header can read
the unauthenticated health endpoint — SQLite version and task counts — and nothing more. Claiming
or completing work needs `AGENT_POLL_SECRET`, which is exactly why the runner is never given it.

## Host orchestrator

`orchestrator/` is the host-side daemon that drains the queue. It runs as you, on the host, not
in a container — it needs to run `docker`, and a containerized orchestrator would need the Docker
socket, which is root-equivalent and would undo every hardening flag below.

```bash
cp config/orchestrator.example.json config/orchestrator.json
# copy the .env.orchestrator block out of .env.example, fill in the secrets
npm run runner:build
npm run orchestrator
```

Boot fails loudly rather than half-working: it checks the queue's health endpoint, `docker info`,
the runner image, `git --version`, and every configured project's `local_path`. Herdr is probed
too but is optional unless `HERDR_REQUIRED=true`.

The loop is `setTimeout`-based rather than `setInterval`, so a slow poll cannot stack up
overlapping ticks, and it polls only while under `MAX_CONCURRENT_TASKS`. Per task:

1. **Clone.** A `--mirror` cache per project is fetched once, then `git clone --local` gives each
   task its own working copy in `~/.tmt-agent/clones/<slug>-issue-<n>-<taskid>`, hardlinked so it
   costs almost nothing. Not `git worktree`: worktrees share one `.git`, so a `git gc` or a stray
   `reset --hard` in one task can corrupt its siblings, and they leave a `.git/worktrees` entry in
   the developer's repo. The clone's `origin` is HTTPS (tokenless URL; the runner's credential
   helper supplies `GITHUB_TOKEN`). Host mirror fetch can use SSH via `clone_url` or `fetch_url` in
   `config/orchestrator.json` — your ssh-agent on the Mac, no PAT prompt — while pushes from the
   container still use HTTPS.
2. **Branch.** `agent/issue-<n>`, created from the project's default branch, or checked out and
   fast-forwarded if it already exists so a follow-up comment continues the same PR.
3. **PR.** An empty commit, a push, then a draft PR (falling back to a normal PR when the plan
   rejects drafts), then a comment on the issue linking it. Opening the PR up front means the
   human watches the diff arrive rather than waiting for a finished branch.
4. **Neon.** For projects with a `neon` block, an ephemeral branch off `parent_branch`, giving the
   runner a real `DATABASE_URL` in `.env.local` that it can migrate against and cannot use to
   damage anything shared.
5. **Run.** The container, wrapped in a Herdr pane when Herdr is up so you can watch it.
6. **Relay.** `result.json` from `/out` decides `complete` or `fail`; a heartbeat every
   `HEARTBEAT_INTERVAL_SECONDS` keeps the lease and doubles as the cancellation channel — a task
   moved to `canceled` (by closing the issue or removing the label) stops the container.
7. **Preview.** On a successful execute task, the deployment URL for the commit that was just
   pushed, commented on the issue.

A triage task runs 1, 5, and 6 only: it clones read-only on the default branch and skips the branch,
PR, Neon, `.env.local`, and preview stages entirely.

### Preview deployment comments

Vercel's Git integration reports deployments through GitHub's Deployments API and puts the preview
URL in each status's `environment_url`, so the orchestrator reads it from GitHub with the token it
already has — no Vercel API key, no project ids in `config/orchestrator.json`, and no guessing at
how `agent/issue-42` becomes a hostname. Anything else that reports deployments to GitHub the same
way is picked up for free.

Deployments are looked up by the pushed commit rather than by the branch, because a resumed issue
keeps its earlier deployments and reporting one of those would describe the wrong build. The wait
is bounded twice: `PREVIEW_GRACE_MS` for a deployment record to appear at all — a repo with no
hosting attached is dropped there instead of holding its lease — then `PREVIEW_TIMEOUT_MS` for the
build to reach a final state. A build still running at that point is still commented, with its
state, since the branch URL is stable and will serve the build once it lands. A failed build is
commented too, with a link to its log. Nothing found means no comment. Set
`PREVIEW_COMMENTS=false` to turn the whole thing off.

This lands on the **issue**, not the PR, because Vercel's own bot already comments on the PR and
the issue thread is where the agent's other updates are. Only execute tasks get one; a plan task
pushes nothing, so the only deployment would be the empty start commit's.

Previews are public by default, but a project using Deployment Protection (Vercel Authentication,
Password Protection, Trusted IPs) will ask for a login when the link is opened. That is a Vercel
project setting, not something this orchestrator can influence.

Secrets reach the runner as a single 0600 `secrets.env` bind-mounted at `/run/secrets/env`, never
as `-e` flags: `docker inspect` and `ps` both expose environment variables to any process on the
host, and Docker persists them in container JSON. The file is shredded after the run. It carries
only `GITHUB_TOKEN` and `CURSOR_API_KEY`; `NEON_API_KEY` is asserted absent, since it is
org-scoped and could delete whole projects while the runner only ever needs the `DATABASE_URL`
that came out of it.

The container gets `--cap-drop ALL --security-opt no-new-privileges --read-only`, a tmpfs `/tmp`,
and pid/memory/cpu/nofile limits, with writes confined to `/workspace`, `/out`, `/home/agent`, and
`/tmp`. The mount list is an exact allowlist asserted by a test. Nothing else is mounted — in
particular not the Docker socket, not the Herdr socket, not `~/.ssh`, `~/.gitconfig`, `~/.cursor`,
or `~/.aws`, not the mirror cache, and not the developer's checkout.

```bash
npm run orchestrator:dry-run     # print every command and payload for a fixture, run nothing
npm run gc                       # report orphaned containers, old clones, unused volumes
npm run gc -- --older-than 3d --volumes --apply    # nothing is deleted without --apply
```

`scripts/dry-run-task.mjs` is the cheap way to see what a delivery would do: it prints the
resolved branch plan, the `docker run` argv, the rendered prompt, and the Neon request body
without touching the network, Docker, or git.

### Secrets on the host

The three long-lived credentials default to `.env.orchestrator`, which is `.gitignore`d and
should be `chmod 600`. Setting `SECRETS_FROM_KEYCHAIN=true` reads them from the macOS Keychain
instead:

```bash
security add-generic-password -s tmt-agent -a GITHUB_TOKEN -w
security add-generic-password -s tmt-agent -a CURSOR_API_KEY -w
security add-generic-password -s tmt-agent -a NEON_API_KEY -w
```

Worth doing: Keychain ACLs prompt per binary, whereas a plaintext file under `~/.tmt-agent` or
`~/Developer` is readable by anything running as you — neither path is TCC-protected. Use a
fine-grained PAT scoped to the agent's repos (`contents:write`, `pull_requests:write`,
`issues:write`, `metadata:read`) so a runaway container cannot reach the rest of the org.

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
| `DB_PATH`, `PORT` | SQLite file and webhook listen port |
| `CONTROL_PORT` | Control listener port inside the container, default `3001` |
| `CONTROL_HOST_PORT`, `DATA_DIR` | Compose-only: published loopback port and data subdirectory |
| `CONTROL_ALLOWED_HOSTS` | Accepted `Host` values on the control listener |
| `CONTROL_REQUIRE_LOOPBACK_PEER` | Also require a loopback peer IP; off by default because Docker Desktop rewrites it to the gateway |
| `WEBHOOK_IP_CHECK` | Verify delivery source IPs against `api.github.com/meta`, default `true` |
| `ALLOW_UNKNOWN_REPOS` | Accept repos absent from the registry, default `false` |
| `LEASE_SECONDS`, `MAX_ATTEMPTS`, `RETRY_BACKOFF_SECONDS`, `REAPER_INTERVAL_SECONDS` | Queue behaviour |
| `TUNNEL_METRICS_URL` | cloudflared metrics endpoint used to log the webhook URL |

Orchestrator variables live in `.env.orchestrator`; the annotated block is at the bottom of
[`.env.example`](.env.example). Keeping them out of `.env` is deliberate — the queue container's
`env_file` should hold only the webhook and poll secrets.

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
src/            server.mjs db.mjs auth.mjs projects.mjs triggers.mjs
                context.mjs references.mjs queue.mjs tunnel.mjs
                net-guards.mjs github-meta.mjs
orchestrator/   index.mjs config.mjs queue-client.mjs exec.mjs repo.mjs
                github.mjs neon.mjs taskdir.mjs prompt.mjs runner.mjs
                herdr.mjs state.mjs
db/schema.sql            applied idempotently at boot
config/                  tenant registry (projects.json is gitignored)
docker/                  server image, agent-runner image, agent entrypoint
scripts/                 replay-delivery, dry-run-task, gc-agent-artifacts
tests/  fixtures/        node --test suite and GitHub payload fixtures
```

Orchestrator state that is not in the queue — the `cursor-agent` chat id and Neon branch id per
issue — lives in `~/.tmt-agent/state.json`, written by atomic rename. It is a cache: losing it
costs a fresh chat and a new database branch, not correctness.

Requires SQLite 3.45+ for `jsonb()`; `src/db.mjs` asserts this at boot rather than failing
later with `no such function: jsonb`.
