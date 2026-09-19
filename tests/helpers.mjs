import { readFileSync } from 'node:fs';

export const FIXTURES = new URL('../fixtures/', import.meta.url);

export function fixtureBuffer(name) {
  return readFileSync(new URL(name, FIXTURES));
}

export function fixture(name) {
  return JSON.parse(fixtureBuffer(name).toString('utf8'));
}

export const PROJECT = {
  slug: 'main-app',
  repo: 'my-org/primary-app',
  repo_key: 'my-org/primary-app',
  default_branch: 'main',
  trigger_label: 'agent:assigned',
  execute_label: 'agent:execute',
  triage_label: 'agent:triage',
  mention: '@dev-agent',
  agent_login: 'dev-agent',
  webhook_secret_env: null,
};

/** Force a task's lease into the past so the reaper picks it up without waiting. */
export function expireLease(db, id) {
  db.prepare("UPDATE agent_tasks SET lease_expires_at = datetime('now','-1 hours') WHERE id = ?").run(id);
}
