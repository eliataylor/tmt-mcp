# Security audit

This is not yet a zero trust system. That is, it assumes own operating system is not yet compromised. It does take reasonable steps to authenticate and sanitize communication with connecting MCP servers and payloads. 

## Scope

Designed to protect against:

- Anyone on the internet who can hit the public tunnel URL.
- A browser on the operator's machine, including a page that tries to call loopback.
- A GitHub user who can cause a delivery for a registered repository. Write collaborators are allowed to enqueue work. Their issue and comment text is still untrusted input to the model.
- The process inside a runner container, which is where that text is trying to steer the agent, and where repository code and `npm` scripts actually execute.

Not designed to protect against:

- Someone who already runs code as the operator, or who can talk to the Docker socket.
- Someone who already has `GITHUB_TOKEN`, `NEON_API_KEY`, `AGENT_POLL_SECRET`, or a webhook secret from the host.
- A container escape, a malicious Docker image the operator built themselves, or a compromise of GitHub, Cloudflare, Neon, npm, or Cursor.

The intended deployment is `docker-compose.dev.yml`. The host-native `npm run dev` path is
called out separately below because it does not get the compose port bindings.

See [DEBUG.md](DEBUG.md) to review agent's reasoning, commands, tool calls, and web requests on any Issue.

## Boundaries

```
Internet
  |  HMAC-signed webhook, optional GitHub source-IP check
  v
cloudflared quick tunnel          (public hostname, new one each restart)
  |
  v
webhook listener :3000            (not published to the host; agent-net only)
  |
  v
SQLite queue
  ^
  |  Bearer AGENT_POLL_SECRET, loopback, Host / Origin / Sec-Fetch-Site checks
host orchestrator                 (your user, holds the long-lived credentials)
  |
  |-- git on the host             (hooks, fsmonitor, sshCommand forced off)
  |-- Neon API                    (NEON_API_KEY stays here)
  |-- tmt-cred-proxy              (only process that has GITHUB_TOKEN)
  |
  v
runner container                  (one task, isolated network, default-deny egress)
```

Three credentials are deliberately split:


| Secret                                                                  | Where it lives                           | What it authorizes                                    |
| ----------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| Webhook secret (`WEBHOOK_SECRET_*`, one per repository)                 | Queue container                          | Enqueue a task for that one repository                |
| `AGENT_POLL_SECRET`                                                     | Queue container and the orchestrator     | Lease, complete, fail, inspect, and replay deliveries |
| `GITHUB_TOKEN`, `CURSOR_API_KEY`, `NEON_API_KEY`, `POSTHOG_MCP_API_KEY` | Orchestrator host (env file or Keychain) | GitHub writes, the agent, Neon control plane, PostHog |


The runner receives `CURSOR_API_KEY`, a per-task proxy grant, optional PostHog settings, and
— when the project has a Neon block — a branch `DATABASE_URL` in `.env.local`. It does not
receive the GitHub token, the Neon API key, the poll secret, or the webhook secret.
`writeSecrets` refuses to write those three forbidden keys and throws if a caller tries.

## Controls



### Admitting work

`POST /api/agent/webhook` is the only route on the tunnel-facing app. The control routes are
a second process listener. `cloudflared tunnel --url http://webhook-server:3000` would publish
whatever that process serves, so combining them would put poll and ingest on the public
hostname.

Signature verification uses the raw request bytes and `X-Hub-Signature-256`. The repository
name in the body is only a hint for which secret to try; a delivery is queued only after the
HMAC matches. Comparison is constant-time. Every project names its own `webhook_secret_env`,
and an unset variable fails closed. There is no shared secret. A delivery for a repo that is
not in `config/projects.json` is acknowledged and dropped before the HMAC, because no secret
is on file to check; the body is not stored. `X-GitHub-Delivery` is the dedup key, so a GitHub
retry does not open a second task.

Who may enqueue is decided in `src/triggers.mjs` from fields GitHub signed:

- Comments and newly opened issues require `author_association` of `OWNER`, `MEMBER`, or
`COLLABORATOR`.
- Label and assign events are accepted when GitHub delivered them for someone who can edit the
issue. A sender association of `NONE` is still rejected. A missing association is accepted,
because GitHub only emits those events for users who can already edit.
- Comments and labels from `user.type === Bot`, or from `agent_login`, are ignored so a plan
comment or a triage label cannot start another run. That depends on the token posting as the
agent. A shared personal token posts as you; setting `agent_login` to your own login would
also drop your comments.

The tunnel hostname is not a secret. Quick-tunnel names are scanned. The HMAC is what keeps a
scanner from writing to the queue.

Source IP is a second check, not a substitute. In the default `enforce` mode the webhook app
rejects deliveries whose `CF-Connecting-IP` (the tunnel is the one that sets it) is outside
GitHub's published `hooks` ranges. Until those ranges have loaded, the check is skipped and the
HMAC stands alone until the list has loaded. The check cannot be set to warn or off.

### Control plane

Compose publishes container port 3001 as `127.0.0.1` only. Port 3000 is not published; the
tunnel reaches it on `agent-net`.

Loopback is not enough on its own, because a browser can be aimed at `127.0.0.1` and DNS
rebinding can make that look same-origin. `src/net-guards.mjs` also requires:

- `Host` is in `CONTROL_ALLOWED_HOSTS` (default `127.0.0.1:<port>` and `localhost:<port>`).
- No `Origin` header.
- No `Sec-Fetch-Site` header. Browsers send it and page script cannot strip it.

Poll, complete, fail, heartbeat, task reads, and `POST /api/agent/ingest` then require
`Authorization: Bearer`. The bearer check hashes both sides before `timingSafeEqual`, and it
returns 503 when `AGENT_POLL_SECRET` is unset. Ingest is the recovery path: it re-runs
classification without a GitHub signature, so the bearer is the whole gate.

`GET /api/health` sits behind the header checks and not behind the bearer. It reports the
SQLite version, journal mode, project slugs, and task counts. On the compose deployment that
is a local process on the machine. It is not on the tunnel.

### Host git

The worktree is bind-mounted into the container, so the agent can rewrite `.git/config` and
`.git/hooks`. Host git commands force an empty `core.hooksPath`, clear `core.fsmonitor`, and
clear `core.sshCommand` on any clone the agent can see. `GIT_CONFIG_NOSYSTEM` is set. The
GitHub token is supplied by a credential helper that reads `GITHUB_TOKEN` from the host
process; the remote URL does not contain it. Before the container starts, `.git/config` and
`.git/hooks` are copied aside and restored afterwards, and the restore deletes a symlink at
the destination before copying so a planted link is not followed.

Every host subprocess is `execFile` with an argv array. The one shell is `herdr pane run`,
which only tails an orchestrator-chosen log path. Issue titles that reach a Herdr label are
reduced to a short visible character set first.

### Runner sandbox

`docker run` is built in `orchestrator/runner.mjs` and covered by tests that lock the mount
list. The container gets:

- `--cap-drop ALL`, plus `SETUID` and `SETGID` only so the entrypoint can drop to uid 1001,
with `no-new-privileges`.
- A read-only root, a size-capped `/tmp`, and pid, memory, swap, cpu, and nofile limits.
- An explicit mount list: the task worktree, a read-only `/task`, writable `/out`, the secrets
file, the proxy CA, and the per-issue home and npm cache. No Docker socket, no Herdr socket,
no `~/.ssh`, no `~/.gitconfig`, no `~/.cursor`, no `~/.aws`, no mirror, no developer checkout.
- `host.docker.internal`, `gateway.docker.internal`, and `tmt-gateway` mapped to `127.0.0.1`.

Secrets go in as a mode `0600` file mounted at `/run/secrets/env`, not as `-e` or `--env-file`,
because `docker inspect` and the container config both echo environment variables. The file is
overwritten and unlinked when the task ends.

`.env.local` is written only after `git check-ignore` confirms the repository ignores it.
Plan mode reverts uncommitted edits outside the plan file and commits that file from the host.
Triage never creates `agent/issue-<n>`; its `remote.origin.pushurl` is
`read-only://triage-tasks-do-not-push`, a scheme git will not transport.

### GitHub credential proxy

`tmt-cred-proxy` is the only container that mounts `GITHUB_TOKEN`. Runners authenticate to it
with a 256-bit grant minted for one `owner/repo`. The proxy terminates TLS for the GitHub
hostnames with a local CA (the runner is given that CA) and attaches the token only when the
request stays inside the grant:

- `api.github.com` paths must sit under `/repos/<owner>/<repo>`. `GET /` and `GET /user` are
allowed so the MCP server can start. Search is allowed only when every `repo:` qualifier is
that repository. `/graphql` is denied.
- `github.com` and `codeload.github.com` must start at `/<owner>/<repo>`.
- Release and asset hosts must contain that `/<owner>/<repo>` segment as a path boundary.
- A public `GET` or `HEAD` to those hosts is forwarded with no `Authorization`, so an install
can download a public release. Other people's private data is not reachable that way.
- The client's own `Authorization` header is stripped on the way through.

The grant is registered on an admin port bound to `127.0.0.1` on the host and revoked when the
task finishes. The proxy port is not published to the host; only the runner network can open it.

MCP toolsets are narrower still, and they apply to the MCP server rather than to every HTTP
client in the container. Triage gets `issues`. Plan gets read-only `repos`, `issues`, and
`pull_requests`. Execute gets those three without read-only, and still does not get the
`actions` toolset. See the residual note below: a shell in the container is not the MCP server.

### Egress

Runners attach to `tmt-agent-runners` (`172.28.0.0/16`), not to `agent-net`. They have no route
to the queue or the tunnel.

At boot the orchestrator installs `TMT-AGENT-EGRESS` and `TMT-AGENT-INPUT` in the Docker VM.
From that bridge, new connections are rejected except:

- TCP 443 from the proxy's address to GitHub's published ranges.
- TCP to the proxy and its admin port on the proxy's address.
- UDP/TCP 53 to the nameservers listed in the VM's `resolv.conf`, which is how Docker's stub
resolver reaches the engine. The rest of RFC1918, link-local, and loopback is rejected.
- TCP 443 to the resolved addresses of the npm registry, the Cursor API hosts, and — only when
a PostHog key is configured — PostHog.

IPv6 from the bridge is rejected. Packets addressed to the VM itself are rejected. The
allowlist is resolved at orchestrator start; a restart picks up address changes.
`RUNNER_EGRESS_ALLOW_HOSTS` appends extra names and fails the boot if one of them does not
resolve.

### Prompt and publication

The task prompt tells the model that issue bodies, comments, file contents, and tool results
are data, and it quotes the issue and the triggering comment inside marked fences. A canary is
planted in the prompt. Before the orchestrator commits a plan file or posts a plan or preview
comment, `assertNoLeak` refuses the publish if the canary or a configured secret string is
present. The same check runs on issue and pull-request comments the runner posts through the
credential proxy. A branch database URL contributes its host, username, and password as separate
needles, plus the percent-encoded userinfo when that differs. Runner `result.json` and `run.log`
are size-capped and stripped of control characters before they can be stored or shown.

Neon branches are created from the configured parent with `init_source` defaulting to
`parent-schema`, so a task branch is not a copy of the parent's rows unless that default is
changed. The API key that creates them stays on the host. PostHog sessions default to
read-only and to the project id in that project's orchestrator config.

## Residual risks

These are reachable without first compromising the operator's account, the Docker socket, or
a long-lived secret on the host.

### The model can still follow hostile task text

Fencing and the canary reduce the chance that a model echoes its prompt into a plan comment.
They do not stop a model that treats an issue body, a later comment, or a file in the checkout
as instructions. Write access on the repository is enough to put that text in front of a run:
a collaborator can enqueue, and execute mode's job is to edit
the tree and push.

What that run can reveal is whatever the container can already read: `CURSOR_API_KEY`, the
proxy grant, the PostHog key if configured, and the branch database URL. The leak check covers
text the orchestrator itself commits or posts, and issue or pull-request comments the runner
posts through the proxy. It does not cover commits the agent pushes, or other GitHub writes
such as an issue body or a file committed through the API. Those land in the repository,
which is one of the destinations egress already allows.

Other open destinations from the same container are the rest of the HTTPS allowlist (npm,
Cursor, and PostHog when enabled) and DNS. Port 53 is limited to the engine resolver, and that
resolver recurses, so a lookup is a way out for a process that is already running in the
container. Closing that would break name resolution for the allowlist.

### The proxy scopes a repo, and the token's GitHub permissions are the ceiling

Inside the container, git and any HTTP client using the proxy grant can ask for any API the
token can perform under that one repository. The MCP toolset list does not apply to those
clients. GraphQL is denied, and paths outside the repo do not receive the token, but a path
under `/repos/<owner>/<repo>` does, including APIs the execute toolset does not expose.

Triage is the exception for git pushes: the dead push URL fails in git before a request is
made. Plan mode has no such push URL. Its "do not push" rule is in the prompt, and the host
reverts uncommitted edits outside the plan file after the container exits. A push the agent
already made is left in place and reported, because removing it would be a force-push.

The practical limit is the token. A fine-grained PAT or a GitHub App restricted to the agent
repos, with contents, pull requests, issues, and metadata, keeps a runaway task inside those
repos. A classic token with `repo`, `workflow`, or org admin is a larger blast radius, and the
proxy will use whatever that token allows on the granted repo.

A granted client can also open a raw `CONNECT` to a host that is not in the TLS-intercept set.
The proxy then tunnels bytes without attaching the token. Egress filtering still applies to
the proxy container, so that tunnel cannot reach the LAN, the queue, or the Mac. It does mean
path checks apply to intercepted HTTP, not to every TCP connection the grant can open.

### The source-IP check is skippable

While `api.github.com/meta` has not loaded, a delivery that presents a valid HMAC is queued
from any address. Once the ranges have loaded, addresses outside them are rejected. Each
repository has its own `webhook_secret_env`, so one GitHub webhook setting cannot mint tasks
for every tenant.

### Running the server outside Compose

`main()` binds both listeners to `BIND_ADDRESS`, which defaults to `0.0.0.0`. Compose hides
that: port 3000 is unpublished and port 3001 is published on `127.0.0.1`. A host `npm run dev`
does not. The peer-address check defaults off, because inside Docker the published port's peer
is the bridge gateway rather than `127.0.0.1`.

On a host-bound process, a client on the LAN can send `Host: 127.0.0.1:3001` and satisfy the
header checks. Task routes still need the poll secret. `/api/health` does not. Set
`BIND_ADDRESS=127.0.0.1` for a host process, or `CONTROL_REQUIRE_LOOPBACK_PEER=true` when the
peer address really is loopback.

### Public webhook cost

The tunnel accepts a body up to 10 MB and checks the signature after the body is buffered.
There is no application rate limit. A client without the secret can spend CPU on the machine
and cannot write a row. This is a local availability concern for a single-user box, not a way
into the queue.

## Configuration that changes the posture


| Choice                              | Effect                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Broad `GITHUB_TOKEN` scopes         | The proxy will exercise them on the granted repo. Prefer a fine-grained PAT or an App.                                                                                                      |
| `SECRETS_FROM_KEYCHAIN` unset       | Secrets live in `.env.orchestrator`. That file should be mode `0600`. Anything running as you can read it; `~/Developer` is not a TCC-protected directory. Keychain ACLs prompt per binary. |
| `posthog.read_only: false`          | The runner's PostHog session may create and update, not only query.                                                                                                                         |
| Neon `init_source` of `parent-data` | The task branch receives a copy of the parent database, not only its schema.                                                                                                                |
| `RUNNER_EGRESS_ALLOW_HOSTS`         | Extra HTTPS destinations for every runner. A name that does not resolve aborts boot.                                                                                                        |




## What is already in good shape

- The public process serves the webhook and nothing else.
- Queue writes require a GitHub signature, except the bearer-gated ingest route.
- Unknown repos are dropped. Each repository has its own webhook secret. Only write collaborators can enqueue. Source IPs outside GitHub's hooks ranges are rejected once those ranges have loaded.
- The runner network cannot route to the queue, and the filter rejects the gateway, private
ranges, and the VM.
- The GitHub token is not in the runner, not in remote URLs, and not in `docker inspect`.
- The Neon API key and the poll secret are refused at the secrets file.
- Host git does not run hooks from a worktree the agent can edit.
- Triage cannot push, and it cannot label itself into execute: its own label events are ignored.
- Plan publication, preview comments, and issue or pull-request comments posted through the
proxy are refused when they contain a tracked secret, a database URL part, or the canary.

