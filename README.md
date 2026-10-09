# Agent Task Queue

Express + SQLite service that turns GitHub issue activity into tasks for a local coding agent. GitHub posts webhooks through a Cloudflare tunnel; the host orchestrator polls, leases a task, and reports the result.


| Piece            | Where it runs        | Job                                                       |
| ---------------- | -------------------- | --------------------------------------------------------- |
| `webhook-server` | Docker               | Verify the delivery, write `agent_tasks`                  |
| `cloudflared`    | Docker               | Publish the webhook listener only                         |
| orchestrator     | host, as you         | Lease, prepare the clone, start the runner, report status |
| agent runner     | Docker, one per task | Triage, plan, or execute                                  |


```
[ GitHub issue / comment ]
          |  webhook, HMAC-signed
[ cloudflared quick tunnel ]
          |
[ webhook-server (Docker) ] --- agent_tasks (SQLite, WAL)
          |  leased over localhost:3001
[ host orchestrator ] --> clone + Neon branch + Herdr pane
```


| Doc                        | Read it for                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [SECURITY.md](SECURITY.md) | Threat model, HMAC and admission, control-plane headers, credential split, runner sandbox, egress, residual risks |
| [DEBUG.md](DEBUG.md)       | A finished run: `worker.log`, reasoning, tool calls, shell commands, fetches                                      |




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
      "trigger_label": "agent:sdd",
      "mention": "@dev-agent",
      "plan_folder": ".agent/plans",
      "agent_login": "dev-agent",
      "webhook_secret_env": "WEBHOOK_SECRET_MAIN_APP"
    }
  ]
}
```


| Field                                                | Default                                              | Rule                                                                                                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plan_folder`                                        | `.agent/plans`                                       | Root for per-issue stage files at `{plan_folder}/{n}/PLAN.md` (and RESEARCH, UX, TEST, MONITOR). Must be tracked — gitignored folders make revision commits empty. |
| `webhook_secret_env`                                 | —                                                    | Required. HMAC is checked against that variable only. There is no shared `GITHUB_WEBHOOK_SECRET`. An unset variable fails closed.                                  |
| `trigger_label`                                      | `agent:sdd`                                          | System Design / PLAN.md. Also the cancel label when removed.                                                                                                       |
| `execute_label`                                      | `agent:execute`                                      | Implement from PLAN.md; write TEST.md Instructions.                                                                                                                |
| `test_label`                                         | `agent:test`                                         | Re-run tests; write TEST.md Results.                                                                                                                               |
| `triage_label`                                       | `agent:triage`                                       | Triage mode.                                                                                                                                                       |
| `research_label` / `graphic_label` / `monitor_label` | `agent:research` / `agent:graphic` / `agent:monitor` | Optional stage files.                                                                                                                                              |



| Delivery                                 | Result                                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Comment, or `issues.opened` / `reopened` | Queued only when `author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR`.                                                                     |
| `issues.labeled` / `issues.assigned`     | Accepted: GitHub only delivers these for someone who can edit the issue. Sender association `NONE` is rejected. A missing association is accepted. |
| Repo not in the registry                 | `202`, logged, never queued. Not configurable.                                                                                                     |
| No trigger matched                       | `200` `{ "ignored": true }`, so GitHub does not retry.                                                                                             |




### What becomes a task

Priority when several labels are present: **execute → test → sdd → research / graphic / monitor → triage**.


| Event                        | Condition                                      | Result                                                                                                                           |
| ---------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `issues.labeled`             | applied by the agent itself                    | ignored — triage applies labels, and they must not re-trigger it                                                                 |
| `issues.labeled`             | stage / execute / test / triage label          | queue that mode (`agent:sdd`, `agent:research`, `agent:graphic`, `agent:monitor`, `agent:execute`, `agent:test`, `agent:triage`) |
| `issues.assigned`            | assignee matches `agent_login`                 | queue `agent:sdd`                                                                                                                |
| `issues.opened` / `reopened` | carries a control label, no agent mention      | queue that mode (`agent:opened` when only `trigger_label` / sdd)                                                                 |
| `issues.opened` / `reopened` | body mentions agent                            | Action from text token → issue control labels → sticky `mention_help` (never a silent SDD default)                               |
| `issue_comment.created`      | author is a `Bot`, or matches `agent_login`    | ignored — the agent must not answer itself                                                                                       |
| `issue_comment.created`      | mentions agent                                 | same preference: text token (e.g. `@agent agent:research …`) → issue labels → sticky `mention_help`                              |
| `issue_comment.created`      | no mention; revisable stage/execute/test label | queue that mode (`comment_created` when only sdd)                                                                                |
| `issues.closed`              | —                                              | cancel that issue's pending tasks                                                                                                |
| `issues.unlabeled`           | label matches `trigger_label`                  | cancel that issue's pending tasks                                                                                                |


**Mentions:** include a control-label string in the commenting (or issue) body, or put that label on the issue. Preference is **text token → issue labels → help**. The orchestrator upserts a sticky `<!-- tmt:mention-help -->` card when neither signal is present; it does not start the agent runner.

Removing `execute_label` / `test_label` / stage labels other than `trigger_label` does not cancel queued work. Pending tasks cancel when the issue closes or loses `trigger_label`.


| Loop guard                                               | Why it matters                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Sticky cards stay on the issue while stage labels remain | `Bot` and `agent_login` comments are ignored, which is what stops the agent answering itself.                                   |
| `GITHUB_TOKEN` must be the agent's                       | A personal token posts as you. Setting `agent_login` to that login drops your comments too. Use a machine user or a GitHub App. |


**Typical flow:** `agent:triage` (optional) → optional `agent:research` / `agent:graphic` → `agent:sdd` writes `.agent/plans/{n}/PLAN.md` → sticky card on the issue → human adds `agent:execute` → product code + TEST Instructions → preview → `agent:test` re-runs checks → optional `agent:monitor` after ship.

### Modes


| Mode              | Label            | Deliverable                                      | Writes                                                  |
| ----------------- | ---------------- | ------------------------------------------------ | ------------------------------------------------------- |
| **Triage**        | `agent:triage`   | Estimate + related issues/files                  | 1 short comment (no `.agent/plans`)                     |
| **Research**      | `agent:research` | `.agent/plans/{n}/RESEARCH.md`                   | 1 file commit + sticky card                             |
| **Wireframes**    | `agent:graphic`  | `.agent/plans/{n}/UX.md` + `wireframes/*.drawio` | UX.md + draw.io files + sticky card                     |
| **System design** | `agent:sdd`      | `.agent/plans/{n}/PLAN.md` (execute SoT)         | 1 file commit + sticky card                             |
| **Execute**       | `agent:execute`  | Product code + TEST.md Instructions              | Agent commits product; orchestrator publishes TEST card |
| **Test**          | `agent:test`     | TEST.md Results                                  | 1 file commit + sticky card                             |
| **Monitor**       | `agent:monitor`  | `.agent/plans/{n}/MONITOR.md`                    | 1 file commit + sticky card                             |


Mode ground rules live under `[orchestrator/prompts/](orchestrator/prompts/)`; `[orchestrator/prompt.mjs](orchestrator/prompt.mjs)` assembles the shared framing. `[.cursor/rules/agent-instructions.md](.cursor/rules/agent-instructions.md)` is inlined into every mode.

### Dual surface (file + sticky card)

Stage markdown (and graphic-mode `wireframes/*.drawio`) on the branch is the source of truth. Every non-triage prompt includes an orchestrator-built **Stage folder** inventory of present/missing siblings so research, wireframes, SDD, and execute can read each other. After each revision the orchestrator **upserts** one sticky issue comment per kind (`<!-- tmt:card:PLAN -->`, etc.): visible summary + Needs from you, full file in a collapsed `<details>` block. Zero extra model tokens — the card is built from the file. Next runs should read the file, not the card.

### Stage / System Design mode


| Step              | Who          | What                                                                                                                                      |
| ----------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Branch + draft PR | orchestrator | First commit scaffolds the waking stage file under `.agent/plans/{n}/`.                                                                   |
| Edit              | agent        | That stage's allowlist only (usually one markdown file; graphic also writes `wireframes/*.drawio`). No commit/push; no sticky-card edits. |
| Commit            | orchestrator | Revert other uncommitted edits; commit allowlisted paths; push.                                                                           |
| Issue card        | orchestrator | Upsert sticky comment (summary, asks, collapsed body, permalink).                                                                         |
| Later execute     | agent        | PLAN.md is the plan of record; consult UX/wireframes when present; also write TEST.md Instructions.                                       |


Stage commits still push, so skip preview/CI on `.agent/plans/**` when useful:

- **Vercel** — Ignored Build Step such as
`git diff --quiet HEAD^ HEAD -- . ':(exclude).agent/plans'` (exit 0 skips the build).
- **GitHub Actions** — `paths-ignore: ['.agent/plans/**']` on `push` / `pull_request` triggers.



### Triage mode

Read the thread and the code, post one short comment with a rough estimate and any obvious related issues or files. No branch, pull request, or database branch: a clone, a container, and an API write. The clone stays on the default branch so it does not show another task's unmerged `agent/issue-<n>` work.

```
**Estimate:** 4-8h
**Related:** #12, #34
**Files:** `src/foo.ts`, `src/bar/baz.ts`
```


| Rule               | Behavior                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape              | Short comment. Drop any line that does not apply.                                                                                               |
| Estimate           | Rough implementation time for one engineer who knows the codebase (`2-4h`, `1-2d`, or `unknown`).                                               |
| Related            | Bare `#<number>` when a file, route, or flow is shared. GitHub records the back-reference. The agent does not comment on the other issue.       |
| Files              | Paths in the checkout that clearly belong to this work.                                                                                         |
| One-shot           | A later comment does not re-triage. Add `agent:sdd` (or another stage label) when the issue deserves design work.                               |
| No push            | `remote.origin.pushurl` is `read-only://triage-tasks-do-not-push` (no git transport). Fetch URL stays HTTPS so tooling can still name the repo. |
| No self-escalation | Control labels stay off-limits, and `issues.labeled` from the agent is ignored.                                                                 |


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


| Fact               | Detail                                                                                                                                                                                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thread             | A webhook never includes the comment thread. An `issues` event carries the body; an `issue_comment` event carries that one comment. `fetch` is the count and the URL. The agent loads the thread with GitHub MCP (`get_issue`, `get_issue_comments`), per [agent-instructions.md](.cursor/rules/agent-instructions.md). |
| `references.files` | Feeds the codebase scan. Paths come from blob permalinks, backticked paths with a `:10-20` suffix, bare path-shaped tokens (including stack traces), and `path=` on a code fence.                                                                                                                                       |




## API

Every `/api/agent/*` route except the webhook requires `Authorization: Bearer $AGENT_POLL_SECRET`.


| Method | Path                             | Notes                                                                                                                                                                                       |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/agent/webhook`             | GitHub delivery. `X-Hub-Signature-256` over the raw body. Dedup key is `X-GitHub-Delivery`.                                                                                                 |
| `POST` | `/api/agent/poll`                | Lease the oldest eligible task. Body optional: `{ "project_slug": "main-app" }` or `{ "project_slugs": [...] }`, `{ "worker": "..." }`, `{ "lease_seconds": 1800 }`. Returns `{ "task": ... |
| `POST` | `/api/agent/tasks/:id/complete`  |                                                                                                                                                                                             |
| `POST` | `/api/agent/tasks/:id/fail`      | `{ "error": "..." }`. Re-queues with exponential backoff until `max_attempts`, then `failed`.                                                                                               |
| `POST` | `/api/agent/tasks/:id/heartbeat` | Extend the lease.                                                                                                                                                                           |
| `GET`  | `/api/agent/tasks`               | `?status=&project_slug=&limit=`                                                                                                                                                             |
| `GET`  | `/api/health`                    | SQLite version, journal mode, tenants, task counts. No bearer; the control-plane header checks still apply.                                                                                 |




### Two listeners

The tunnel proxies every path on the process it is pointed at. Poll and task routes are a second listener so they never share that hostname.


| Listener | Port                                | Reachable from               | Routes                                                     |
| -------- | ----------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| Webhook  | 3000, **not published**             | cloudflared over `agent-net` | `POST /api/agent/webhook`                                  |
| Control  | 3001, published to `127.0.0.1` only | the host orchestrator        | `poll`, `tasks`, `complete`, `fail`, `heartbeat`, `health` |


Header checks (`Host`, `Origin`, `Sec-Fetch-Site`): [SECURITY.md](SECURITY.md#control-plane). GitHub `hooks` CIDR check: [SECURITY.md](SECURITY.md#admitting-work).

A unix socket would keep browsers from addressing the control plane. It does not cross Docker Desktop's VM boundary: a socket bound in the queue container on a bind mount shows up on the host as a socket inode over VirtioFS, but `node:http` `socketPath` and `curl --unix-socket` both fail with `ECONNREFUSED`. Same class of failure as the WAL `-shm` file under [Reading the queue](#reading-the-queue). The control plane is loopback TCP. `QUEUE_CONTROL_SOCKET` remains for a queue process running on the host.


| Lease     | Behavior                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| Duration  | `LEASE_SECONDS`. If the orchestrator dies, the reaper returns the task to `pending`, or `failed` once attempts are spent. |
| Per issue | One task in flight. A burst of comments cannot open two clones for the same issue.                                        |


`github_issue_id` is GitHub's internal id. Branch and clone names use `github_issue_number` (also `context.issue.number`).

## Deployment


| Mode             | When                                                                                                                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared (default) | One instance, every repo in the registry. The queue holds per-repo webhook secrets and `AGENT_POLL_SECRET`. The PAT, Neon key, blob token, and ephemeral `DATABASE_URL` stay on the orchestrator and in each clone's `.env.local`. Concurrency is one runner container per issue. |
| Isolated         | A real blast-radius or commingling split. `PROJECT_SLUG` rejects every other repo, including one listed in the same `projects.json`, and `/api/agent/poll` ignores a mismatched slug.                                                                                             |


```bash
cp .env .env.main-app     # set PROJECT_SLUG=main-app, CONTROL_HOST_PORT=3011, DATA_DIR=main-app
docker compose -p main-app --env-file .env.main-app \
  -f docker-compose.dev.yml -f docker-compose.project.yml up -d
```

Each isolated stack needs its own `CONTROL_HOST_PORT`, `DATA_DIR`, and tunnel hostname.


| Runner knob                 | Effect                                                                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network                     | `tmt-agent-runners`, declared in compose and attached by the orchestrator's `docker run`. No route to the queue, cloudflared, or another runner.                        |
| `RUNNER_EGRESS_ALLOW_HOSTS` | Extra HTTPS names a setup command needs. A name that does not resolve aborts boot. The allowlist is resolved at orchestrator start; restart to pick up address changes. |
| Image                       | `npm run runner:build` after egress or entrypoint changes. The image carries `iptables`, `openssl`, and `cred-proxy.mjs`.                                               |
| `AGENT_POLL_SECRET`         | Never given to the runner.                                                                                                                                              |


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


| Step          | Plan and execute                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Triage                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Clone         | A `--mirror` cache per project, then `git clone --local` into `~/.tmt-agent/clones/<slug>-issue-<n>-<taskid>` (hardlinked). Each task has its own `.git` — a shared one lets `git gc` or `reset --hard` in one task corrupt its siblings, and a worktree would leave a `.git/worktrees` entry in the developer's checkout. Origin is a tokenless HTTPS URL; the runner's credential helper supplies the token. Host mirror fetch can use SSH via `clone_url` or `fetch_url` in `config/orchestrator.json`. | Same clone, read-only, left on the default branch |
| Branch        | `agent/issue-<n>` from the default branch, or checked out and fast-forwarded when it already exists                                                                                                                                                                                                                                                                                                                                                                                                        | skipped                                           |
| PR            | Plan-scaffold commit, push, draft PR (a normal PR when drafts are rejected), issue comment linking the PR and the plan file                                                                                                                                                                                                                                                                                                                                                                                | skipped                                           |
| Neon          | Projects with a `neon` block get an ephemeral branch off `parent_branch` and a `DATABASE_URL` in `.env.local`                                                                                                                                                                                                                                                                                                                                                                                              | skipped                                           |
| Run           | The container, in a Herdr pane when Herdr is up                                                                                                                                                                                                                                                                                                                                                                                                                                                            | yes                                               |
| Relay         | `/out/result.json` selects `complete` or `fail`. A heartbeat every `HEARTBEAT_INTERVAL_SECONDS` extends the lease. Status `canceled` (issue closed, or `trigger_label` removed) stops the container.                                                                                                                                                                                                                                                                                                       | yes                                               |
| Plan revision | [Plan mode](#plan-mode)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | skipped                                           |
| Preview       | Execute only. [Preview comments](#preview-comments)                                                                                                                                                                                                                                                                                                                                                                                                                                                        | skipped                                           |


To inspect reasoning, commands, and web requests after a run, see [DEBUG.md](DEBUG.md).

### Preview comments

Vercel reports deployments through GitHub's Deployments API. Each status's `environment_url` is that deployment's host and changes every push. The comment rewrites a host of that shape into the stable branch alias, using the project and scope already in the hostname:

```
demo-4z8ywkqd0-match-bear.vercel.app
→ demo-git-agent-issue-42-match-bear.vercel.app
```

No Vercel API key and no project ids in `config/orchestrator.json`. A host that is not a Vercel deployment URL is commented as GitHub reported it.


| Rule                     | Behavior                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Lookup                   | The pushed commit, not the branch. A resumed issue keeps older deployments.                                                        |
| `PREVIEW_GRACE_MS`       | How long to wait for a deployment record. A repo with no hosting is dropped here.                                                  |
| `PREVIEW_TIMEOUT_MS`     | How long to wait for a final state. A build still running is commented with its state; the branch URL will serve it when it lands. |
| Failure                  | Commented, with a link to the log.                                                                                                 |
| Nothing found            | No comment.                                                                                                                        |
| `PREVIEW_COMMENTS=false` | Turns the feature off.                                                                                                             |
| Where                    | The issue. Vercel's bot already comments on the PR, and the issue is where the agent's other updates are.                          |
| Plan tasks               | No preview comment. They push only the plan file, so the deployment would preview the base branch.                                 |


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

**Use** `GET /api/agent/tasks` **for anything that matters.** Tunnel probes are `GET /api/agent/access`.

## Environment


| Variable                                                                            | Purpose                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEBHOOK_SECRET_*`                                                                  | HMAC secret for one repository, named by that project's `webhook_secret_env`                                                                                                                                                 |
| `AGENT_POLL_SECRET`                                                                 | Bearer token for the orchestrator endpoints                                                                                                                                                                                  |
| `PROJECTS_CONFIG`                                                                   | Registry path, default `/config/projects.json`                                                                                                                                                                               |
| `PROJECT_SLUG`                                                                      | Isolated mode only; pins the instance to one project                                                                                                                                                                         |
| `DB_PATH`, `PORT`                                                                   | SQLite file and webhook listen port                                                                                                                                                                                          |
| `CONTROL_PORT`                                                                      | Control listener port inside the container, default `3001`                                                                                                                                                                   |
| `CONTROL_HOST_PORT`, `DATA_DIR`                                                     | Compose-only: published loopback port and data subdirectory                                                                                                                                                                  |
| `CONTROL_ALLOWED_HOSTS`                                                             | Accepted `Host` values on the control listener                                                                                                                                                                               |
| `CONTROL_REQUIRE_LOOPBACK_PEER`                                                     | Also require a loopback peer IP; off by default because Docker Desktop rewrites it to the gateway                                                                                                                            |
| `LEASE_SECONDS`, `MAX_ATTEMPTS`, `RETRY_BACKOFF_SECONDS`, `REAPER_INTERVAL_SECONDS` | Queue behaviour                                                                                                                                                                                                              |
| `TUNNEL_METRICS_URL`                                                                | cloudflared metrics endpoint used to log the webhook URL                                                                                                                                                                     |
| `ADMIN_NOTIFY_URL`, `ADMIN_NOTIFY_TOKEN`                                            | Optional. Text POST for tunnel probes and leak alerts (a private ntfy topic). Empty records hits and sends nothing. The same values belong in `.env.orchestrator`. The topic path is a secret; the message is metadata only. |


Orchestrator variables live in `.env.orchestrator`. The annotated block is at the bottom of `[.env.example](.env.example)`.

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


| State                                | Where                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Chat id and Neon branch id per issue | `~/.tmt-agent/state.json`, written by atomic rename. Losing it costs a fresh chat and a new database branch. |
| SQLite                               | 3.45+ for `jsonb()`. `src/db.mjs` asserts this at boot.                                                      |


