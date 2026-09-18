# Agent Context Gathering Protocol

When an issue task starts:
1. **Pull Full Issue Context:** Do NOT rely only on the triggering comment. Call GitHub MCP `get_issue` and `get_issue_comments` to ingest the entire thread history.
2. **Scan Codebase References:** Search the repository for any filenames, error stack traces, or functions mentioned in the issue thread.
3. **Check Branch Diffs:** If working on an existing PR branch, run `git diff main` inside your local worktree to inspect what changes have already been made.
4. **Formulate Updated Strategy:** Post a comment update summarizing your understanding of the user feedback before applying new code edits.