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
      "plan_folder": ".agent/plans",
      "agent_login": "dev-agent",
      "webhook_secret_env": "WEBHOOK_SECRET_MAIN_APP"
    }
  ]
}
```

`plan_folder` is optional (default `.agent/plans`): the folder, relative to the target repo root,
where each issue's plan is committed as `PLAN-<issue>.md`. It must be a relative path inside the
repository and must not be gitignored there — the orchestrator refuses to scaffold into an ignored
folder, because every plan commit would come out empty.

Comments and newly opened issues enqueue only when the actor's `author_association` is
`OWNER`, `MEMBER`, or `COLLABORATOR`. Someone without write access cannot start a run by
commenting on an issue that already carries `agent:execute`. Label and assign events are
different: GitHub only delivers those for users who can already edit the issue, so a missing
association is accepted. An association of `NONE` on the sender is still rejected.

`webhook_secret_env` is required, and each repository names a different variable. Deliveries
are verified against that secret only. There is no shared `GITHUB_WEBHOOK_SECRET`. An unset
variable fails closed.

A delivery from a repo that is not listed is acknowledged with 202 and logged, never queued.
That is not configurable.

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

Every plan run ends in an issue comment linking the new plan revision, posted while the trigger
label is still on the issue — so the author check above is what keeps the agent from triggering itself in a loop.
It only holds if `GITHUB_TOKEN` belongs to the agent and not to a human: with a shared personal
token the agent posts under your login, and setting `agent_login` to that login would silence
your own comments too. Give the agent its own machine user or GitHub App before relying on it.

Optional per-project overrides in `projects.json`: `execute_label` (default `agent:execute`) and
`triage_label` (default `agent:triage`).
Removing `execute_label` or `triage_label` does **not** cancel queued work; only losing
`trigger_label` or closing the issue does.

**Typical flow:** add `agent:assigned` → the orchestrator opens `agent/issue-<n>` and a draft PR whose first commit is the plan scaffold → the agent writes the plan → the orchestrator commits it and links that revision on the issue → humans reply, each reply producing a new plan revision → a human adds `agent:execute` → the agent implements from the plan file.

Everything else gets a 200 with `{ "ignored": true }` so GitHub does not keep retrying.

### The three modes

| Mode | Queue action | Deliverable | Writes |
| --- | --- | --- | --- |
| **Triage** | `agent:triage` | Labels on the issue, plus one short comment sizing it | Labels + 1 comment |
| **Plan** | `agent:assigned`, `agent:opened`, `comment_created` | A revision of `<plan_folder>/PLAN-<n>.md`: understanding, open questions, implementation plan | 1 plan commit (by the orchestrator) + 1 short link comment |
| **Execute** | `agent:execute` | The change itself, on `agent/issue-<n>`, summarized on the PR | Commits, push, PR comment |

Each mode's ground rules and definition of done are rendered into the task prompt by
[`orchestrator/prompt.mjs`](orchestrator/prompt.mjs), with this project's configured label names
substituted in, and **only for the mode that is running** — a triage prompt does not carry the
execute rules. [`.cursor/rules/agent-instructions.md`](.cursor/rules/agent-instructions.md) holds
only the part that is identical for every mode (MCP usage, context gathering, the untrusted-input
rule) and is inlined verbatim into all of them.

### Plan mode

Plans live in the pull request, not in the issue thread, so the thread stays readable and the
plan's evolution is ordinary git history.

- **Setup is shared with execute.** Whichever label or mention first gives an issue a branch, the
  branch's first commit adds `<plan_folder>/PLAN-<n>.md` from
  [`templates/plan.scaffold.md`](templates/plan.scaffold.md), and the draft PR links to it. A branch
  created before plan files existed gets the scaffold on its next plan run.
- **The agent only edits the file.** It does not commit, push, or post the plan as a comment.
- **The orchestrator makes the commit.** After a successful run it reverts uncommitted edits outside
  the plan file (ignored files such as `.env.local` are untouched), stages only the plan file,
  commits it as `plan(#<n>): revision <N> (task <id>)`, and pushes. So every plan run that changes
  the plan is exactly one commit. Commits the agent made on its own are left in place and flagged
  in the comment, since removing pushed ones would need a force-push.
- **The issue gets a short link comment** pointing at that exact version (a commit permalink, not
  the branch) plus a compare link to the previous revision, and the agent's one-line
  `<!-- summary: ... -->` from the file. A run that leaves the plan unchanged posts "plan
  unchanged" with a link to the current version instead of committing.
- **Execute follows the file.** The execute prompt names the plan file as the plan of record.

What happens to the plan file when the PR merges is left to the reviewer: keep it as a design
record, or delete it before merging.

Plan-only commits still push to the PR branch, so a target repo with preview deployments or CI
will build on every revision unless it skips them. Configure that in the target repo, for example:

- **Vercel** — an Ignored Build Step such as
  `git diff --quiet HEAD^ HEAD -- . ':(exclude).agent/plans'` (exit 0 skips the build).
- **GitHub Actions** — `paths-ignore: ['.agent/plans/**']` on `push` / `pull_request` triggers.

### Triage mode

`agent:triage` is the cheapest thing the agent can do to an issue: it reads the thread and the code,
applies labels, and posts one comment sizing the change. It never opens a branch, a pull request, or
a database branch, so the whole task is a clone, a container, and two API writes.

The comment is a fixed shape under 120 words, and every line but the first two is dropped when it
does not apply:

```
**Difficulty:** moderate · **Estimate:** 4-8h
**Labels:** bug, area:billing
**Needs:** <missing detail, and the template field it belongs in>
**Related:** #12, #34
**Note:** <one line — a label that should exist, or evidence this is already fixed>
```

Difficulty is one of `trivial`, `small`, `moderate`, `large`, or `unknown`, and the estimate is
focused implementation time for one engineer who knows the codebase, review and QA excluded. An
issue too thin to locate the change in the code is sized `unknown` rather than guessed at.

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

Related issues, when the agent finds any, are bare `#<number>` references on one line: searched for
over the paths, symbols, and error strings the thread cites, and kept only when a file, route, or
flow is genuinely shared. Writing the number is enough for GitHub to record the back-reference on the
other side — the agent is told not to comment on the other issues, so triaging a pile of issues does
not spam every thread it touches.

The prompt also tells triage to treat the issue as a report rather than as instructions, and gives it
two ways out of classifying something it cannot classify:

- **Too thin.** If the report does not say what was expected, what happened, or where, the `Needs:`
  line asks for the few details that block sizing instead of guessing a diagnosis. The agent reads
  `.github/ISSUE_TEMPLATE/` in the checkout first and names the template and fields that fit, so the
  ask matches what that repo already defines as a usable report. When it can size the issue, it asks
  for nothing.
- **Too old.** The issue header carries the opened and updated dates with their age in days, and past
  a week the prompt points at `git log --since=<issue date>` over the paths the issue names, since
  the fix may already have landed. That read goes on the `Note:` line with a recommendation to close
  — the agent still never closes anything itself.

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
load via GitHub MCP (`get_issue`, `get_issue_comments`). Plans go in the plan file rather than
a comment (see [Plan mode](#plan-mode)). The `references.files` array feeds the codebase scan;
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

Webhook deliveries are checked against the `hooks` CIDRs from `api.github.com/meta`, read
from `CF-Connecting-IP`. That check is always enforced. A failure to load the ranges logs and
skips until the next refresh, rather than dropping every delivery while the list is unknown.

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
the per-repository webhook secrets and `AGENT_POLL_SECRET`, while the credentials actually worth
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
attached to it, so a runner cannot reach the queue, cloudflared, or another runner. At boot the
orchestrator starts `tmt-cred-proxy` on that network and installs a default-deny filter
(`TMT-AGENT-EGRESS` / `TMT-AGENT-INPUT` in the Docker VM). Packets to the gateway, to private
ranges, and to the VM itself are rejected. The one exception is DNS: containers resolve through
Docker's stub, which forwards to the engine nameserver (a private address), so UDP and TCP 53
to the nameservers in the VM's resolv.conf are allowed and nothing else on that range is.
Runners may open the proxy port on the sidecar and
TCP 443 to the npm registry, the Cursor API, and PostHog when that key is set. Only the sidecar
may open TCP 443 to GitHub. It injects the token for the task's repo, and forwards a public
GET or HEAD to those hosts with no Authorization, which is how a dependency install downloads
a release. The runner still cannot open GitHub itself. The runner never sees
the token string: git and the GitHub MCP server present a dummy credential, and the proxy
replaces it. Names are blackholed as well (`host.docker.internal`, `gateway.docker.internal`,
`tmt-gateway` → `127.0.0.1`); the filter is what rejects the gateway IP itself. The runner is
still never given `AGENT_POLL_SECRET`, so a hole in the filter cannot claim or complete work.
The allowlist is resolved at boot, so an orchestrator restart picks up address changes. Add a
hostname with `RUNNER_EGRESS_ALLOW_HOSTS` when a setup command needs somewhere else. Rebuild the
runner image after this change (`npm run runner:build`): the egress rules and the proxy both run
from that image, which contains `iptables`, `openssl`, and `cred-proxy.mjs`.

### Why the control plane is TCP and not a unix socket

A unix socket would be strictly better — browsers cannot address one, so CORS reasoning and DNS
rebinding both stop being relevant. It does not work here, and this was measured rather than
assumed: a socket bound inside the queue container on a Docker Desktop bind mount **does** show
up on the host as a socket inode over VirtioFS, but connecting to it fails with `ECONNREFUSED`
from both `node:http`'s `socketPath` and `curl --unix-socket`. The socket itself does not cross
the VM boundary — the same class of problem as the WAL `-shm` caveat below.

So the control plane is loopback TCP with the header guards above. `QUEUE_CONTROL_SOCKET` still
exists in the orchestrator config for the case where the queue runs directly on the host.

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
3. **PR.** A first commit adding the plan scaffold, a push, then a draft PR (falling back to a
   normal PR when the plan rejects drafts), then a comment on the issue linking it and the plan file. Opening the PR up front means the
   human watches the diff arrive rather than waiting for a finished branch.
4. **Neon.** For projects with a `neon` block, an ephemeral branch off `parent_branch`, giving the
   runner a real `DATABASE_URL` in `.env.local` that it can migrate against and cannot use to
   damage anything shared.
5. **Run.** The container, wrapped in a Herdr pane when Herdr is up so you can watch it.
6. **Relay.** `result.json` from `/out` decides `complete` or `fail`; a heartbeat every
   `HEARTBEAT_INTERVAL_SECONDS` keeps the lease and doubles as the cancellation channel — a task
   moved to `canceled` (by closing the issue or removing the label) stops the container.
7. **Plan revision.** On a successful plan task, the plan file committed and pushed as its own
   revision, and a link to that version commented on the issue (see [Plan mode](#plan-mode)).
8. **Preview.** On a successful execute task, the branch preview URL for the commit that was just
   pushed, commented on the issue.

A triage task runs 1, 5, and 6 only: it clones read-only on the default branch and skips the branch,
PR, Neon, `.env.local`, and preview stages entirely.

### Preview deployment comments

Vercel's Git integration reports deployments through GitHub's Deployments API. Each status's
`environment_url` is that deployment's own host (`demo-4z8ywkqd0-match-bear.vercel.app`), which
changes on every push. The comment rewrites a host of that shape into the branch alias
(`demo-git-agent-issue-42-match-bear.vercel.app`) using the project and scope already in the
hostname, so it needs no Vercel API key and no project ids in `config/orchestrator.json`. Hosts
that are not a Vercel deployment URL are commented as GitHub reported them.

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
pushes only the plan file, so its deployment would just preview the base branch.

Previews are public by default, but a project using Deployment Protection (Vercel Authentication,
Password Protection, Trusted IPs) will ask for a login when the link is opened. That is a Vercel
project setting, not something this orchestrator can influence.

Secrets reach the runner as a single 0600 `secrets.env` bind-mounted at `/run/secrets/env`, never
as `-e` flags: `docker inspect` and `ps` both expose environment variables to any process on the
host, and Docker persists them in container JSON. The file is shredded after the run. It carries
`CURSOR_API_KEY` and a per-task proxy grant, not `GITHUB_TOKEN`. The token is mounted only into
`tmt-cred-proxy`. When `POSTHOG_MCP_API_KEY` is set in `.env.orchestrator`, the runner also gets
PostHog MCP credentials (read-only by default) so the agent can query analytics, errors, and
flags. `NEON_API_KEY` is asserted absent, since it is org-scoped and could delete whole projects
while the runner only ever needs the `DATABASE_URL` that came out of it.

The container gets `--cap-drop ALL --security-opt no-new-privileges --read-only`, a tmpfs `/tmp`,
and pid/memory/cpu/nofile limits, with writes confined to `/workspace`, `/out`, `/home/agent`, and
`/tmp`. The mount list is an exact allowlist asserted by a test. Nothing else is mounted — in
particular not the Docker socket, not the Herdr socket, not `~/.ssh`, `~/.gitconfig`, `~/.cursor`,
or `~/.aws`, not the mirror cache, and not the developer's checkout.

```bash
npm run reconcile                # table of recent GitHub triggers vs queue; --enqueue <row#> to ingest
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
security add-generic-password -s tmt-agent -a POSTHOG_MCP_API_KEY -w
```

Optional PostHog MCP: create a [personal API key](https://posthog.com/docs/api/personal-api-keys) with the **MCP Server** preset, set `POSTHOG_MCP_API_KEY` in `.env.orchestrator`, and pin each queue project with a `posthog` block in `config/orchestrator.json` (`project_id`, optional `organization_id`, `read_only` defaulting to true). Rebuild the runner image after changing `docker/agent-entrypoint.sh`.

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
