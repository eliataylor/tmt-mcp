import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Per-issue state that has to outlive a single task.
 *
 * The cursor-agent chat id is the important one: a follow-up comment on issue #42 should resume
 * the same conversation rather than start cold, and that id is only knowable after the first run.
 *
 * A JSON file with an atomic rename is enough here. The orchestrator is a single process and the
 * write volume is a handful of keys per task, so SQLite would buy nothing — and the queue plan
 * already documents that host-side SQLite over the Docker bind mount is unreliable anyway.
 */

export function issueKey(projectSlug, issueNumber) {
  return `${projectSlug}#${issueNumber}`;
}

export function createStore(path) {
  let cache = null;

  function read() {
    if (cache) return cache;
    if (!existsSync(path)) {
      cache = { schema_version: 1, issues: {} };
      return cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      cache = {
        schema_version: parsed.schema_version || 1,
        issues: parsed.issues && typeof parsed.issues === 'object' ? parsed.issues : {},
      };
    } catch {
      // A corrupt state file must not wedge the daemon; resuming is an optimization, not a
      // correctness requirement, so start clean and keep going.
      cache = { schema_version: 1, issues: {} };
    }
    return cache;
  }

  function persist() {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  }

  return {
    path,

    get(projectSlug, issueNumber) {
      return read().issues[issueKey(projectSlug, issueNumber)] || null;
    },

    /** Shallow merge, so a stage can record just the field it learned. */
    merge(projectSlug, issueNumber, patch) {
      const state = read();
      const key = issueKey(projectSlug, issueNumber);
      const next = {
        ...(state.issues[key] || {}),
        ...patch,
        project_slug: projectSlug,
        issue_number: issueNumber,
        updated_at: new Date().toISOString(),
      };
      state.issues[key] = next;
      persist();
      return next;
    },

    delete(projectSlug, issueNumber) {
      const state = read();
      delete state.issues[issueKey(projectSlug, issueNumber)];
      persist();
    },

    all() {
      return { ...read().issues };
    },
  };
}
