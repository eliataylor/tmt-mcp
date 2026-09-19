# Agent issue workflow

Tasks arrive in one of two modes. The queue action and issue labels tell you which applies:

| Mode | Queue action | Issue signal |
| --- | --- | --- |
| **Plan** | `agent:assigned`, `agent:opened`, or `comment_created` | `agent:assigned` (or project `trigger_label`) is on the issue and **`agent:execute` is not** |
| **Execute** | `agent:execute` | Label **`agent:execute`** (or project `execute_label`) was just added, or a qualifying comment arrived while that label is already on the issue |

Humans add `agent:execute` only after they are satisfied with the plan (or want to skip straight to implementation).

## GitHub MCP (required for context and issue replies)

The runner enables the GitHub MCP server. Use it instead of guessing from the embedded webhook snippet.

1. **`get_issue`** — refresh title, body, state, and labels.
2. **`get_issue_comments`** — read the full thread. The task manifest embeds at most one comment; never treat that as the whole discussion.
3. **Post an issue comment** — use the server’s issue-comment tool (e.g. `add_issue_comment` / `create_issue_comment`, depending on server version). Plan-mode deliverable is always a **GitHub issue comment**, not a local file or PR description alone.

Do not use MCP or git to add/remove labels unless a human explicitly asked you to in the thread.

## Shared context gathering (both modes)

When a task starts:

1. **Pull full issue context** — `get_issue` and `get_issue_comments` as above.
2. **Scan codebase references** — search `/workspace` for filenames, stack traces, and symbols mentioned in the issue thread.
3. **Check branch diffs** — if a PR branch already exists, inspect `git diff` against the base branch so you do not redo or contradict prior work.
4. **Reconcile with the trigger** — the latest human comment or label change is authoritative; earlier agent plans may be outdated.

## Plan mode (`agent:assigned` / `agent:opened` / `comment_created`)

**Do not change product code.** No edits under `/workspace`, no commits, no pushes, no new PRs, no dependency installs beyond what is needed to read the tree.

Post **one** structured issue comment that includes:

- **Understanding** — what you think the issue is asking for, in plain language.
- **Open questions** — numbered list of anything that blocks a confident implementation (behavior, scope, design choice, env access). If nothing blocks you, say so explicitly.
- **Implementation plan** — ordered steps, files or areas you expect to touch, risks, and how you would verify (tests, manual checks).

If the thread already contains an approved plan and the new trigger is only a clarifying comment, reply with an updated plan or answers—not code.

**Definition of done (plan):** the issue comment is posted and the working tree is unchanged.

## Execute mode (`agent:execute`)

Follow the plan agreed in the thread (including your earlier issue comment unless humans corrected it).

Before the first edit in this run, post a **short** issue comment if something material changed since the plan (new blocker, revised approach). Otherwise proceed.

Then implement on the task branch: logical commits, push to `origin`, open or update the PR as described in the task prompt.

**Definition of done (execute):** the issue is addressed (or you posted a precise blocker comment), work is pushed on the task branch, and checks/lint pass or you explained why they cannot.
