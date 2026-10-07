# Agent Task Queue

Express + SQLite service that turns GitHub issue activity into tasks for a local coding agent. GitHub posts webhooks through a Cloudflare tunnel; the host orchestrator polls, leases a task, and reports the result.

| Piece | Where it runs | Job |
| --- | --- | --- |
| `webhook-server` | Docker | Verify the delivery, write `agent_tasks` |
| `cloudflared` | Docker | Publish the webhook listener only |
| orchestrator | host, as you | Lease, prepare the clone, start the runner, report status |
| agent runner | Docker, one per task | Triage, plan, or execute |

```
[ GitHub issue / comment ]
          |  webhook, HMAC-signed
[ cloudflared quick tunnel ]
          |
[ webhook-server (Docker) ] --- agent_tasks (SQLite, WAL)
          |  leased over localhost:3001
[ host orchestrator ] --> clone + Neon branch + Herdr pane
```

| Doc | Read it for |
| --- | --- |
| [SECURITY.md](SECURITY.md) | Threat model, HMAC and admission, control-plane headers, credential split, runner sandbox, egress, residual risks |
| [DEBUG.md](DEBUG.md) | A finished run: `worker.log`, reasoning, tool calls, shell commands, fetches |

## Quick start

```bash
cp .env.example .env                       # then fill in the secrets
openssl rand -hex 32                       # one per repository webhook secret, plus AGENT_POLL_SECRET
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

`npm run dev` binds both listeners on `BIND_ADDRESS` (default `0.0.0.0`). Compose does not. See [SECURITY.md](SECURITY.md#running-the-server-outside-compose).

## Tenant registry

`config/projects.json` is bind-mounted read-only and re-read on `SIGHUP`:

```bash
docker compose kill -s HUP webhook-server
```

```json
{
  "projects": [
    {
      "slug": "main-app",
      "repo": "my-org/primary-app",
      "default_branch": "main",
      "trigger_label": "agent:assigned",
      "mention": "@dev-agent",
      "plan_folder": ".agent/plans",
      "agent_login": "dev-agent",
      "webhook_secret_env": "WEBHOOK_SECRET_MAIN_APP"
    }
  ]
}
```

| Field | Default | Rule |
| --- | --- | --- |
| `plan_folder` | `.agent/plans` | Folder for `PLAN-<issue>.md`, relative to the target repo root. Must sit inside the repo and must not be gitignored — an ignored folder makes every plan commit empty, and the orchestrator refuses to scaffold there. |
| `webhook_secret_env` | — | Required. HMAC is checked against that variable only. There is no shared `GITHUB_WEBHOOK_SECRET`. An unset variable fails closed. |
| `execute_label` | `agent:execute` | Implement mode. |
| `triage_label` | `agent:triage` | Triage mode. |

| Delivery | Result |
| --- | --- |
| Comment, or `issues.opened` / `reopened` | Queued only when `author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR`. |
| `issues.labeled` / `issues.assigned` | Accepted: GitHub only delivers these for someone who can edit the issue. Sender association `NONE` is rejected. A missing association is accepted. |
| Repo not in the registry | `202`, logged, never queued. Not configurable. |
| No trigger matched | `200` `{ "ignored": true }`, so GitHub does not retry. |

### What becomes a task

| Event | Condition | Result |
| --- | --- | --- |
| `issues.labeled` | applied by the agent itself | ignored — triage applies labels, and they must not re-trigger it |
| `issues.labeled` | label matches `trigger_label` | queue `agent:assigned` (**plan** — plan file on the task branch, no code) |
| `issues.labeled` | label matches `execute_label` (default `agent:execute`) | queue `agent:execute` (**implement** on the task branch) |
| `issues.labeled` | label matches `triage_label` (default `agent:triage`) | queue `agent:triage` (**triage** — labels + cross-links, no code) |
| `issues.assigned` | assignee matches `agent_login` | queue `agent:assigned` (plan) |
| `issues.opened` / `reopened` | issue carries `execute_label` | queue `agent:execute` |
| `issues.opened` / `reopened` | issue carries `trigger_label` (and not execute) | queue `agent:opened` (plan) |
| `issues.opened` / `reopened` | issue carries `triage_label` only | queue `agent:triage` |
| `issues.opened` / `reopened` | body contains `mention` or `@agent_login` (no control labels) | queue `agent:assigned` (plan) or `agent:execute` if `execute_label` is on the issue |
| `issue_comment.created` | author is a `Bot`, or matches `agent_login` | ignored — the agent must not answer itself |
| `issue_comment.created` | body contains `mention` or `@agent_login` | queue `agent:assigned` (plan) or `agent:execute` if `execute_label` is on the issue |
| `issue_comment.created` | issue carries `execute_label` | queue `agent:execute` |
| `issue_comment.created` | issue carries `trigger_label` only | queue `comment_created` (plan) |
| `issues.closed` | — | cancel that issue's pending tasks |
| `issues.unlabeled` | label matches `trigger_label` | cancel that issue's pending tasks |

Removing `execute_label` or `triage_label` does not cancel queued work. Pending tasks cancel when the issue closes or loses `trigger_label`.

| Loop guard | Why it matters |
| --- | --- |
| Plan comments are posted while `trigger_label` is still on the issue | `Bot` and `agent_login` comments are ignored, which is what stops the agent answering itself. |
| `GITHUB_TOKEN` must be the agent's | A personal token posts as you. Setting `agent_login` to that login drops your comments too. Use a machine user or a GitHub App. |

**Typical flow:** add `agent:assigned` → the orchestrator opens `agent/issue-<n>` and a draft PR whose first commit is the plan scaffold → the agent writes the plan → the orchestrator commits it and links that revision on the issue → humans reply, each reply producing a new plan revision → a human adds `agent:execute` → the agent implements from the plan file.

### The three modes

| Mode | Queue action | Deliverable | Writes |
| --- | --- | --- | --- |
| **Triage** | `agent:triage` | Labels on the issue, plus one short comment sizing it | Labels + 1 comment |
| **Plan** | `agent:assigned`, `agent:opened`, `comment_created` | A revision of `<plan_folder>/PLAN-<n>.md`: understanding, open questions, implementation plan | 1 plan commit (by the orchestrator) + 1 short link comment |
| **Execute** | `agent:execute` | The change itself, on `agent/issue-<n>`, summarized on the PR | Commits, push, PR comment |

[`orchestrator/prompt.mjs`](orchestrator/prompt.mjs) renders each mode's ground rules and definition of done, with this project's label names substituted in, and only for the mode that is running. [`.cursor/rules/agent-instructions.md`](.cursor/rules/agent-instructions.md) is the part identical for every mode (MCP usage, context gathering, untrusted input) and is inlined into all of them.

### Plan mode

The plan lives on the pull request. The issue thread gets a short link; the revisions are ordinary commits.

| Step | Who | What |
| --- | --- | --- |
| Branch + draft PR | orchestrator | Shared with execute. The first commit adds `<plan_folder>/PLAN-<n>.md` from [`templates/plan.scaffold.md`](templates/plan.scaffold.md). A branch that predates plan files gets the scaffold on its next plan run. |
| Edit | agent | The plan file only. The agent does not commit, push, or paste the plan into a comment. |
| Commit | orchestrator | After a successful run: revert uncommitted edits outside the plan file (ignored files such as `.env.local` stay), stage only the plan file, commit `plan(#<n>): revision <N> (task <id>)`, push. One commit per plan run that changes the file. Commits the agent made itself stay, and the comment says so — dropping them would be a force-push. |
| Issue comment | orchestrator | Permalink of that commit (not the branch), a compare link to the previous revision, and the file's `<!-- summary: ... -->` line. An unchanged plan posts "plan unchanged" and does not commit. |
| Later execute | agent | The execute prompt names the plan file as the plan of record. |

Whether the plan file stays in the merge is the reviewer's call.

Plan commits still push, so a repo with preview deploys or CI builds every revision unless it skips that path:

- **Vercel** — an Ignored Build Step such as
  `git diff --quiet HEAD^ HEAD -- . ':(exclude).agent/plans'` (exit 0 skips the build).
- **GitHub Actions** — `paths-ignore: ['.agent/plans/**']` on `push` / `pull_request` triggers.

### Triage mode

Read the thread and the code, apply labels, post one comment. No branch, pull request, or database branch: a clone, a container, and two API writes. The clone stays on the default branch so it does not show another task's unmerged `agent/issue-<n>` work.

```
**Difficulty:** moderate · **Estimate:** 4-8h
**Labels:** bug, area:billing
**Needs:** <missing detail, and the template field it belongs in>
**Related:** #12, #34
**Note:** <one line — a label that should exist, or evidence this is already fixed>
```

| Rule | Behavior |
| --- | --- |
| Shape | Under 120 words. Every line but the first two is dropped when it does not apply. |
| Difficulty | `trivial`, `small`, `moderate`, `large`, or `unknown`. The estimate is implementation time for one engineer who knows the codebase, review and QA excluded. An issue too thin to locate in the code is `unknown`. |
| Labels | Only names the repo already has. Anything missing is proposed in the comment. |
| Related | Bare `#<number>` on one line, and only when a file, route, or flow is shared. GitHub records the back-reference. The agent does not comment on the other issue. |
| Too thin | `Needs:` asks for the details that block sizing, naming the `.github/ISSUE_TEMPLATE/` template and fields. A sizeable issue asks for nothing. |
| Too old | The header carries opened and updated dates with age in days. Past a week, `git log --since=<issue date>` over the paths the issue names. A close recommendation goes on `Note:`. The agent does not close the issue. |
| One-shot | A later comment does not re-triage. Add `agent:assigned` when the issue deserves a plan. |
| No push | `remote.origin.pushurl` is `read-only://triage-tasks-do-not-push` (no git transport). Fetch URL stays HTTPS so tooling can still name the repo. |
| No self-escalation | The prompt forbids `agent:*` labels, and `issues.labeled` from the agent is ignored. |

Push URL and ignored agent label events: [SECURITY.md](SECURITY.md#runner-sandbox), [SECURITY.md](SECURITY.md#admitting-work).

## Task context

Each task stores the raw delivery in `payload` and a normalized manifest in `context`. The manifest keeps the issue body, the triggering comment, and extracted references separate, and every reference records which of the two it came from:

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

| Fact | Detail |
| --- | --- |
| Thread | A webhook never includes the comment thread. An `issues` event carries the body; an `issue_comment` event carries that one comment. `fetch` is the count and the URL. The agent loads the thread with GitHub MCP (`get_issue`, `get_issue_comments`), per [agent-instructions.md](.cursor/rules/agent-instructions.md). |
| `references.files` | Feeds the codebase scan. Paths come from blob permalinks, backticked paths with a `:10-20` suffix, bare path-shaped tokens (including stack traces), and `path=` on a code fence. |

## API

Every `/api/agent/*` route except the webhook requires `Authorization: Bearer $AGENT_POLL_SECRET`.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/agent/webhook` | GitHub delivery. `X-Hub-Signature-256` over the raw body. Dedup key is `X-GitHub-Delivery`. |
| `POST` | `/api/agent/poll` | Lease the oldest eligible task. Body optional: `{ "project_slug": "main-app" }` or `{ "project_slugs": [...] }`, `{ "worker": "..." }`, `{ "lease_seconds": 1800 }`. Returns `{ "task": ... \| null }`. |
| `POST` | `/api/agent/tasks/:id/complete` | |
| `POST` | `/api/agent/tasks/:id/fail` | `{ "error": "..." }`. Re-queues with exponential backoff until `max_attempts`, then `failed`. |
| `POST` | `/api/agent/tasks/:id/heartbeat` | Extend the lease. |
| `GET` | `/api/agent/tasks` | `?status=&project_slug=&limit=` |
| `GET` | `/api/health` | SQLite version, journal mode, tenants, task counts. No bearer; the control-plane header checks still apply. |

### Two listeners

The tunnel proxies every path on the process it is pointed at. Poll and task routes are a second listener so they never share that hostname.

| Listener | Port | Reachable from | Routes |
| --- | --- | --- | --- |
| Webhook | 3000, **not published** | cloudflared over `agent-net` | `POST /api/agent/webhook` |
| Control | 3001, published to `127.0.0.1` only | the host orchestrator | `poll`, `tasks`, `complete`, `fail`, `heartbeat`, `health` |

Header checks (`Host`, `Origin`, `Sec-Fetch-Site`): [SECURITY.md](SECURITY.md#control-plane). GitHub `hooks` CIDR check: [SECURITY.md](SECURITY.md#admitting-work).

A unix socket would keep browsers from addressing the control plane. It does not cross Docker Desktop's VM boundary: a socket bound in the queue container on a bind mount shows up on the host as a socket inode over VirtioFS, but `node:http` `socketPath` and `curl --unix-socket` both fail with `ECONNREFUSED`. Same class of failure as the WAL `-shm` file under [Reading the queue](#reading-the-queue). The control plane is loopback TCP. `QUEUE_CONTROL_SOCKET` remains for a queue process running on the host.

| Lease | Behavior |
| --- | --- |
| Duration | `LEASE_SECONDS`. If the orchestrator dies, the reaper returns the task to `pending`, or `failed` once attempts are spent. |
| Per issue | One task in flight. A burst of comments cannot open two clones for the same issue. |

`github_issue_id` is GitHub's internal id. Branch and clone names use `github_issue_number` (also `context.issue.number`).

## Deployment

| Mode | When |
| --- | --- |
| Shared (default) | One instance, every repo in the registry. The queue holds per-repo webhook secrets and `AGENT_POLL_SECRET`. The PAT, Neon key, blob token, and ephemeral `DATABASE_URL` stay on the orchestrator and in each clone's `.env.local`. Concurrency is one runner container per issue. |
| Isolated | A real blast-radius or commingling split. `PROJECT_SLUG` rejects every other repo, including one listed in the same `projects.json`, and `/api/agent/poll` ignores a mismatched slug. |

```bash
cp .env .env.main-app     # set PROJECT_SLUG=main-app, CONTROL_HOST_PORT=3011, DATA_DIR=main-app
docker compose -p main-app --env-file .env.main-app \
  -f docker-compose.dev.yml -f docker-compose.project.yml up -d
```

Each isolated stack needs its own `CONTROL_HOST_PORT`, `DATA_DIR`, and tunnel hostname.

| Runner knob | Effect |
| --- | --- |
| Network | `tmt-agent-runners`, declared in compose and attached by the orchestrator's `docker run`. No route to the queue, cloudflared, or another runner. |
| `RUNNER_EGRESS_ALLOW_HOSTS` | Extra HTTPS names a setup command needs. A name that does not resolve aborts boot. The allowlist is resolved at orchestrator start; restart to pick up address changes. |
| Image | `npm run runner:build` after egress or entrypoint changes. The image carries `iptables`, `openssl`, and `cred-proxy.mjs`. |
| `AGENT_POLL_SECRET` | Never given to the runner. |

Default-deny egress, the credential proxy, and the mount allowlist: [SECURITY.md](SECURITY.md#egress), [SECURITY.md](SECURITY.md#github-credential-proxy), [SECURITY.md](SECURITY.md#runner-sandbox).

## Host orchestrator

`orchestrator/` runs on the host, as you. It needs the Docker CLI. A containerized orchestrator would need the Docker socket.

```bash
cp config/orchestrator.example.json config/orchestrator.json
# copy the .env.orchestrator block out of .env.example, fill in the secrets
npm run runner:build
npm run orchestrator
```

Boot checks the queue health endpoint, `docker info`, the runner image, `git --version`, and every project's `local_path`, and exits if one fails. Herdr is probed and optional unless `HERDR_REQUIRED=true`.

The loop is `setTimeout`, so a slow poll cannot overlap the next tick, and it polls only while under `MAX_CONCURRENT_TASKS`.

| Step | Plan and execute | Triage |
| --- | --- | --- |
| Clone | A `--mirror` cache per project, then `git clone --local` into `~/.tmt-agent/clones/<slug>-issue-<n>-<taskid>` (hardlinked). Each task has its own `.git` — a shared one lets `git gc` or `reset --hard` in one task corrupt its siblings, and a worktree would leave a `.git/worktrees` entry in the developer's checkout. Origin is a tokenless HTTPS URL; the runner's credential helper supplies the token. Host mirror fetch can use SSH via `clone_url` or `fetch_url` in `config/orchestrator.json`. | Same clone, read-only, left on the default branch |
| Branch | `agent/issue-<n>` from the default branch, or checked out and fast-forwarded when it already exists | skipped |
| PR | Plan-scaffold commit, push, draft PR (a normal PR when drafts are rejected), issue comment linking the PR and the plan file | skipped |
| Neon | Projects with a `neon` block get an ephemeral branch off `parent_branch` and a `DATABASE_URL` in `.env.local` | skipped |
| Run | The container, in a Herdr pane when Herdr is up | yes |
| Relay | `/out/result.json` selects `complete` or `fail`. A heartbeat every `HEARTBEAT_INTERVAL_SECONDS` extends the lease. Status `canceled` (issue closed, or `trigger_label` removed) stops the container. | yes |
| Plan revision | [Plan mode](#plan-mode) | skipped |
| Preview | Execute only. [Preview comments](#preview-comments) | skipped |

To inspect reasoning, commands, and web requests after a run, see [DEBUG.md](DEBUG.md).

### Preview comments

Vercel reports deployments through GitHub's Deployments API. Each status's `environment_url` is that deployment's host and changes every push. The comment rewrites a host of that shape into the stable branch alias, using the project and scope already in the hostname:

```
demo-4z8ywkqd0-match-bear.vercel.app
→ demo-git-agent-issue-42-match-bear.vercel.app
```

No Vercel API key and no project ids in `config/orchestrator.json`. A host that is not a Vercel deployment URL is commented as GitHub reported it.

| Rule | Behavior |
| --- | --- |
| Lookup | The pushed commit, not the branch. A resumed issue keeps older deployments. |
| `PREVIEW_GRACE_MS` | How long to wait for a deployment record. A repo with no hosting is dropped here. |
| `PREVIEW_TIMEOUT_MS` | How long to wait for a final state. A build still running is commented with its state; the branch URL will serve it when it lands. |
| Failure | Commented, with a link to the log. |
| Nothing found | No comment. |
| `PREVIEW_COMMENTS=false` | Turns the feature off. |
| Where | The issue. Vercel's bot already comments on the PR, and the issue is where the agent's other updates are. |
| Plan tasks | No preview comment. They push only the plan file, so the deployment would preview the base branch. |

Deployment Protection (Vercel Authentication, Password Protection, Trusted IPs) is a Vercel project setting. The comment still posts the URL.

```bash
npm run reconcile                # table of recent GitHub triggers vs queue; --enqueue <row#> to ingest
npm run orchestrator:dry-run     # print every command and payload for a fixture, run nothing
npm run gc                       # report orphaned containers, old clones, unused volumes
npm run gc -- --older-than 3d --volumes --apply    # nothing is deleted without --apply
```

`scripts/dry-run-task.mjs` prints the resolved branch plan, the `docker run` argv, the rendered prompt, and the Neon request body. It does not touch the network, Docker, or git.

### Secrets on the host

Long-lived credentials default to `.env.orchestrator` (gitignored; `chmod 600`). They stay out of the queue container's `env_file`, which should hold only webhook secrets and `AGENT_POLL_SECRET`.

```bash
# SECRETS_FROM_KEYCHAIN=true reads these instead of the env file
security add-generic-password -s tmt-agent -a GITHUB_TOKEN -w
security add-generic-password -s tmt-agent -a CURSOR_API_KEY -w
security add-generic-password -s tmt-agent -a NEON_API_KEY -w
security add-generic-password -s tmt-agent -a POSTHOG_MCP_API_KEY -w
```

Use a fine-grained PAT on the agent's repos: `contents:write`, `pull_requests:write`, `issues:write`, `metadata:read`. What each store actually protects, and the choices that widen it: [SECURITY.md](SECURITY.md#configuration-that-changes-the-posture).

Optional PostHog MCP: a [personal API key](https://posthog.com/docs/api/personal-api-keys) with the **MCP Server** preset, `POSTHOG_MCP_API_KEY` in `.env.orchestrator`, and a `posthog` block per project in `config/orchestrator.json` (`project_id`, optional `organization_id`, `read_only` defaulting to true). Rebuild the runner image after changing `docker/agent-entrypoint.sh`.

## Reading the queue

`.cursor/mcp.json` points the SQLite MCP server at `sqlite_data/`. Treat that as a debugging convenience. The container holds the file open in WAL mode across a Docker Desktop bind mount, and WAL coordinates readers through a `-shm` file that does not cross the macOS VM boundary reliably. Host-side reads can be stale or hit locking errors.

**Use `GET /api/agent/tasks` for anything that matters.** Tunnel probes are `GET /api/agent/access`.

## Environment

| Variable | Purpose |
| --- | --- |
| `WEBHOOK_SECRET_*` | HMAC secret for one repository, named by that project's `webhook_secret_env` |
| `AGENT_POLL_SECRET` | Bearer token for the orchestrator endpoints |
| `PROJECTS_CONFIG` | Registry path, default `/config/projects.json` |
| `PROJECT_SLUG` | Isolated mode only; pins the instance to one project |
| `DB_PATH`, `PORT` | SQLite file and webhook listen port |
| `CONTROL_PORT` | Control listener port inside the container, default `3001` |
| `CONTROL_HOST_PORT`, `DATA_DIR` | Compose-only: published loopback port and data subdirectory |
| `CONTROL_ALLOWED_HOSTS` | Accepted `Host` values on the control listener |
| `CONTROL_REQUIRE_LOOPBACK_PEER` | Also require a loopback peer IP; off by default because Docker Desktop rewrites it to the gateway |
| `LEASE_SECONDS`, `MAX_ATTEMPTS`, `RETRY_BACKOFF_SECONDS`, `REAPER_INTERVAL_SECONDS` | Queue behaviour |
| `TUNNEL_METRICS_URL` | cloudflared metrics endpoint used to log the webhook URL |
| `ADMIN_NOTIFY_URL`, `ADMIN_NOTIFY_TOKEN` | Optional. Text POST for tunnel probes and leak alerts (a private ntfy topic). Empty records hits and sends nothing. The same values belong in `.env.orchestrator`. The topic path is a secret; the message is metadata only. |

Orchestrator variables live in `.env.orchestrator`. The annotated block is at the bottom of [`.env.example`](.env.example).

## Development

```bash
npm test                                   # node --test, no network or Docker needed
npm run replay                             # full loop against a running server
node scripts/replay-delivery.mjs --fixture issue_comment.created.json --event issue_comment
node scripts/replay-delivery.mjs --leave-pending   # queue a task for the real orchestrator
```

`scripts/replay-delivery.mjs` signs a fixture, delivers it, checks that the redelivery is deduplicated, then polls, heartbeats, and completes. No GitHub and no tunnel.

```
src/            server.mjs db.mjs auth.mjs projects.mjs triggers.mjs
                context.mjs references.mjs queue.mjs tunnel.mjs
                net-guards.mjs github-meta.mjs access-log.mjs notify.mjs
orchestrator/   index.mjs config.mjs queue-client.mjs exec.mjs repo.mjs
                github.mjs neon.mjs taskdir.mjs prompt.mjs runner.mjs
                herdr.mjs state.mjs leak-alert.mjs
db/schema.sql            applied idempotently at boot
config/                  tenant registry (projects.json is gitignored)
docker/                  server image, agent-runner image, agent entrypoint
scripts/                 replay-delivery, dry-run-task, gc-agent-artifacts
tests/  fixtures/        node --test suite and GitHub payload fixtures
```

| State | Where |
| --- | --- |
| Chat id and Neon branch id per issue | `~/.tmt-agent/state.json`, written by atomic rename. Losing it costs a fresh chat and a new database branch. |
| SQLite | 3.45+ for `jsonb()`. `src/db.mjs` asserts this at boot. |
