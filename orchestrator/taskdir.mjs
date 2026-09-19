import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertEnvLocalIgnored } from './repo.mjs';

/**
 * Per-task scratch directory.
 *
 * Layout, which mirrors how it gets mounted into the runner:
 *   task.json    -> /task/task.json   (read-only)
 *   prompt.md    -> /task/prompt.md   (read-only)
 *   out/         -> /out              (read-write; result.json and run.log come back here)
 *   secrets.env  -> /run/secrets/env  (read-only, 0600)
 *
 * Secrets travel as a mounted file rather than as environment variables because `docker inspect`
 * reports everything passed with -e or --env-file in Config.Env, so anything that can reach the
 * Docker socket could read them. A mount shows only the path.
 */

/** Never allowed into a runner: org-scoped and able to delete entire Neon projects. */
const FORBIDDEN_SECRET_KEYS = ['NEON_API_KEY', 'AGENT_POLL_SECRET', 'GITHUB_WEBHOOK_SECRET'];

export function taskDirFor(tasksDir, slug, issueNumber, taskId) {
  return join(tasksDir, `${slug}-issue-${issueNumber}-${String(taskId).slice(0, 8)}`);
}

/** Shell-safe single-quoted value for a file sourced with `set -a; . file`. */
function envLine(key, value) {
  return `${key}='${String(value).replace(/'/g, `'\\''`)}'`;
}

export function createTaskDir({ tasksDir, slug, issueNumber, taskId }) {
  const dir = taskDirFor(tasksDir, slug, issueNumber, taskId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, 'out'), { recursive: true, mode: 0o700 });
  return {
    dir,
    outDir: join(dir, 'out'),
    taskJson: join(dir, 'task.json'),
    promptMd: join(dir, 'prompt.md'),
    secretsEnv: join(dir, 'secrets.env'),
    resultJson: join(dir, 'out', 'result.json'),
    runLog: join(dir, 'out', 'run.log'),
  };
}

export function writeManifest(paths, context) {
  writeFileSync(paths.taskJson, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 });
}

export function writePrompt(paths, prompt) {
  writeFileSync(paths.promptMd, `${prompt}\n`, { mode: 0o600 });
}

/**
 * Write the secrets file the entrypoint sources.
 *
 * The forbidden-key assertion is deliberately a hard error rather than a filter: if a caller ever
 * tries to hand a runner the Neon key or the queue's bearer token, that is a bug worth stopping on.
 */
export function writeSecrets(paths, secrets) {
  const keys = Object.keys(secrets);
  const leaked = keys.filter((k) => FORBIDDEN_SECRET_KEYS.includes(k));
  if (leaked.length) {
    throw new Error(
      `Refusing to pass ${leaked.join(', ')} into a runner container. The runner needs no queue ` +
        'or Neon control-plane access; it only needs the database URL that was already provisioned.'
    );
  }

  const body = keys
    .filter((k) => secrets[k] !== undefined && secrets[k] !== null && secrets[k] !== '')
    .map((k) => envLine(k, secrets[k]))
    .join('\n');

  writeFileSync(paths.secretsEnv, `${body}\n`, { mode: 0o600 });

  const mode = statSync(paths.secretsEnv).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`${paths.secretsEnv} has mode ${mode.toString(8)}, expected 600`);
  }
  return paths.secretsEnv;
}

/**
 * Overwrite then unlink, so the bytes are not left readable in a file another process could open
 * between the task finishing and cleanup running.
 */
export function shredSecrets(paths) {
  try {
    const size = statSync(paths.secretsEnv).size;
    writeFileSync(paths.secretsEnv, '\0'.repeat(Math.max(size, 1)), { mode: 0o600 });
  } catch {
    // Already gone; nothing to shred.
  }
  rmSync(paths.secretsEnv, { force: true });
}

/**
 * Write .env.local into the clone, but only after git confirms the repo ignores it.
 */
export async function writeEnvLocal({ clonePath, template = {}, values = {} }) {
  await assertEnvLocalIgnored(clonePath);

  const merged = { ...template, ...values };
  const body = Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${JSON.stringify(String(v))}`)
    .join('\n');

  const target = join(clonePath, '.env.local');
  writeFileSync(target, `${body}\n`, { mode: 0o600 });
  return target;
}

const MAX_RESULT_BYTES = 64 * 1024;
const MAX_LOG_TAIL_BYTES = 32 * 1024;
const MAX_ERROR_CHARS = 4000;

/** Strips C0/C1 control characters except tab and newline. */
export function sanitizeText(text, maxChars = MAX_ERROR_CHARS) {
  return String(text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .slice(0, maxChars);
}

/**
 * Read the runner's self-reported outcome.
 *
 * result.json and run.log are written inside the container, so they are untrusted input: the size
 * is capped, the shape is validated, and text is stripped of control characters before it can
 * reach the database and, from there, a GitHub comment.
 */
export function readResult(paths) {
  let raw;
  try {
    raw = readFileSync(paths.resultJson);
  } catch {
    return { present: false, exitCode: null, reason: null };
  }

  if (raw.length > MAX_RESULT_BYTES) {
    return {
      present: true,
      valid: false,
      exitCode: null,
      reason: `result.json is ${raw.length} bytes, over the ${MAX_RESULT_BYTES} limit`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { present: true, valid: false, exitCode: null, reason: 'result.json is not valid JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { present: true, valid: false, exitCode: null, reason: 'result.json is not an object' };
  }

  const exitCode = Number.isInteger(parsed.exit_code) ? parsed.exit_code : null;
  if (exitCode === null) {
    return {
      present: true,
      valid: false,
      exitCode: null,
      reason: 'result.json has no integer exit_code',
    };
  }

  // The chat id is minted inside the container, so it comes back through this same file. Keep it
  // to a conservative shape: it is used later as a command-line argument.
  const chatIdRaw = typeof parsed.chat_id === 'string' ? parsed.chat_id.trim() : '';
  const chatId = /^[\w-]{1,128}$/.test(chatIdRaw) ? chatIdRaw : null;

  return {
    present: true,
    valid: true,
    exitCode,
    chatId,
    reason: parsed.reason ? sanitizeText(parsed.reason, 500) : null,
    finishedAt: typeof parsed.finished_at === 'string' ? sanitizeText(parsed.finished_at, 64) : null,
  };
}

export function readLogTail(paths, maxBytes = MAX_LOG_TAIL_BYTES) {
  try {
    const raw = readFileSync(paths.runLog);
    const slice = raw.length > maxBytes ? raw.subarray(raw.length - maxBytes) : raw;
    return sanitizeText(slice.toString('utf8'), maxBytes);
  } catch {
    return '';
  }
}
