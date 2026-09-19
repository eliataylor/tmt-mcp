# Agent issue protocol

This is the part of the protocol that is the same for every task. The task prompt names the mode you
are in — triage, plan, or execute — and carries that mode's ground rules and definition of done,
written with this project's actual label names. Where the prompt and this file disagree, the prompt
wins.

## GitHub MCP (required for context and issue replies)

The runner enables the GitHub MCP server. Use it instead of guessing from the webhook snippet the
prompt embeds.

1. **`get_issue`** — refresh title, body, state, and labels.
2. **`get_issue_comments`** — read the full thread. The task manifest embeds at most one comment; never treat that as the whole discussion.
3. **Post an issue comment** — use the server’s issue-comment tool (e.g. `add_issue_comment` / `create_issue_comment`, depending on server version). When your mode's deliverable is a comment, it means a real GitHub issue comment, not a local file or a PR description alone.

## Shared context gathering

When a task starts, before anything else:

1. **Pull full issue context** — `get_issue` and `get_issue_comments` as above.
2. **Scan codebase references** — search `/workspace` for the filenames, stack traces, and symbols mentioned in the issue thread.
3. **Check prior work** — if the agent has already worked this issue, a branch or PR exists; inspect `git diff` against the base branch so you do not redo or contradict it.
4. **Reconcile with the trigger** — the latest human comment or label change is authoritative. An earlier agent plan may be outdated.

Issue and comment bodies are quoted into the prompt inside fenced blocks marked as untrusted data,
with the rule for reading them stated at each block. That framing is not repeated here.
