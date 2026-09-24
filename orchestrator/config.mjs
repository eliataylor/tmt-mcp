import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { loadRegistry } from '../src/projects.mjs';

/**
 * Host-side orchestrator configuration.
 *
 * Deliberately separate from the queue container's env_file: the queue holds only the webhook and
 * poll secrets, while every credential worth isolating (the PAT, the Cursor key, the Neon key)
 * lives here on the host and is handed to a runner one task at a time.
 */

const SECRET_NAMES = [
  'AGENT_POLL_SECRET',
  'GITHUB_TOKEN',
  'CURSOR_API_KEY',
  'NEON_API_KEY',
  'POSTHOG_MCP_API_KEY',
];

/** Minimal dotenv reader. Existing environment always wins, so a shell export overrides the file. */
function loadEnvFile(path) {
  if (!existsSync(path)) return 0;
  let loaded = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    loaded += 1;
  }
  return loaded;
}

/**
 * Reads a secret from the macOS Keychain. Keychain ACLs prompt per binary, which is a real
 * improvement over a plaintext dotfile that any process running as you can read, since neither
 * ~/Developer nor ~/.tmt-agent is a TCC-protected directory.
 */
function readKeychainSecret(name, service) {
  try {
    return execFileSync('security', ['find-generic-password', '-w', '-s', service, '-a', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function num(name, fallback) {
  const raw = process.env[name];
  const parsed = Number(raw);
  return raw === undefined || raw === '' || Number.isNaN(parsed) ? fallback : parsed;
}

function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }
}

export function defaultHttpsCloneUrl(repo) {
  return `https://github.com/${repo}.git`;
}

export function isSshGitUrl(url) {
  return typeof url === 'string' && (url.startsWith('git@') || url.startsWith('ssh://'));
}

/**
 * Host mirror fetch vs runner push URLs.
 *
 * The mirror is updated on the host (ssh-agent works). The task clone's origin must stay HTTPS so
 * the runner can push with GITHUB_TOKEN — containers never mount ~/.ssh.
 */
export function resolveGitUrls(registryEntry, orchestratorEntry = {}) {
  const defaultHttps = defaultHttpsCloneUrl(registryEntry.repo);
  const fetchUrl =
    orchestratorEntry.fetch_url || orchestratorEntry.clone_url || defaultHttps;
  const pushUrl =
    orchestratorEntry.push_url || (isSshGitUrl(fetchUrl) ? defaultHttps : fetchUrl);
  return { fetch_url: fetchUrl, push_url: pushUrl };
}

/**
 * Merge a project's orchestrator settings over its registry entry. The registry is the source of
 * truth for identity (slug, repo, default branch); this file adds host-side concerns the queue
 * has no business knowing about.
 */
function mergeProject(registryEntry, orchestratorEntry = {}, defaults = {}) {
  const agent = { ...(defaults.agent || {}), ...(orchestratorEntry.agent || {}) };
  const { fetch_url, push_url } = resolveGitUrls(registryEntry, orchestratorEntry);
  return {
    ...registryEntry,
    local_path: orchestratorEntry.local_path || null,
    neon: orchestratorEntry.neon || null,
    posthog: orchestratorEntry.posthog || null,
    env_template: { ...(defaults.env_template || {}), ...(orchestratorEntry.env_template || {}) },
    agent: {
      model: agent.model || null,
      setup_cmd: agent.setup_cmd || null,
      timeout_ms: agent.timeout_ms || null,
    },
    fetch_url,
    push_url,
    /** @deprecated alias for fetch_url */
    clone_url: fetch_url,
  };
}

export function loadConfig({ envFile = '.env.orchestrator', cwd = process.cwd() } = {}) {
  loadEnvFile(resolve(cwd, envFile));

  const keychainService = process.env.KEYCHAIN_SERVICE || 'tmt-agent';
  const useKeychain = envFlag('SECRETS_FROM_KEYCHAIN', false);

  const secrets = {};
  for (const name of SECRET_NAMES) {
    secrets[name] =
      process.env[name] || (useKeychain ? readKeychainSecret(name, keychainService) : null) || null;
  }

  const registry = loadRegistry({
    configPath: process.env.PROJECTS_CONFIG || resolve(cwd, 'config/projects.json'),
    projectSlug: process.env.PROJECT_SLUG || null,
  });

  const orchestratorFile =
    readJsonIfPresent(
      process.env.ORCHESTRATOR_CONFIG || resolve(cwd, 'config/orchestrator.json')
    ) || {};
  const perProject = orchestratorFile.projects || {};
  const defaults = orchestratorFile.defaults || {};

  const projects = new Map(
    registry
      .list()
      .map((entry) => [entry.slug, mergeProject(entry, perProject[entry.slug], defaults)])
  );

  const workdir = resolve(process.env.AGENT_WORKDIR || `${homedir()}/.tmt-agent`);
  const controlPort = num('QUEUE_CONTROL_PORT', 3001);

  return {
    secrets,
    registry,
    projects,
    project: (slug) => projects.get(slug) || null,
    slugs: () => [...projects.keys()],

    queue: {
      host: process.env.QUEUE_CONTROL_HOST || '127.0.0.1',
      port: controlPort,
      // Kept for the case where the queue runs directly on the host. The Docker Desktop spike
      // showed a socket bound inside a container is not connectable across the bind mount.
      socketPath: process.env.QUEUE_CONTROL_SOCKET || null,
      timeoutMs: num('QUEUE_TIMEOUT_MS', 15000),
    },

    paths: {
      workdir,
      mirrors: `${workdir}/mirrors`,
      clones: `${workdir}/clones`,
      tasks: `${workdir}/tasks`,
      state: `${workdir}/state.json`,
    },

    poll: {
      intervalMs: num('POLL_INTERVAL_MS', 10000),
      jitterMs: num('POLL_JITTER_MS', 2000),
      maxConcurrent: num('MAX_CONCURRENT_TASKS', 2),
      worker: process.env.WORKER_NAME || `orchestrator@${process.pid}`,
    },

    task: {
      timeoutMs: num('TASK_TIMEOUT_MS', 45 * 60 * 1000),
      heartbeatSeconds: num('HEARTBEAT_INTERVAL_SECONDS', 60),
      keepArtifacts: process.env.KEEP_ARTIFACTS || 'on-failure',
    },

    // Waiting for a preview build holds the task lease, so both waits are deliberately short:
    // graceMs only has to outlast the gap between a push and the deployment record appearing.
    preview: {
      enabled: envFlag('PREVIEW_COMMENTS', true),
      graceMs: num('PREVIEW_GRACE_MS', 45000),
      timeoutMs: num('PREVIEW_TIMEOUT_MS', 180000),
      intervalMs: num('PREVIEW_POLL_INTERVAL_MS', 5000),
    },

    runner: {
      image: process.env.RUNNER_IMAGE || 'tmt-agent-runner',
      network: process.env.RUNNER_NETWORK || 'tmt-agent-runners',
      memory: process.env.RUNNER_MEMORY || '4g',
      cpus: process.env.RUNNER_CPUS || '2',
      pidsLimit: num('RUNNER_PIDS_LIMIT', 512),
      noExecTmp: envFlag('RUNNER_NOEXEC_TMP', false),
      // Named node_modules volumes on Docker Desktop often end up root-owned; tmpfs avoids that.
      modulesTmpfs:
        process.env.RUNNER_MODULES_TMPFS === undefined
          ? process.platform === 'darwin'
          : envFlag('RUNNER_MODULES_TMPFS', false),
    },

    herdr: {
      required: envFlag('HERDR_REQUIRED', false),
      bin: process.env.HERDR_BIN || 'herdr',
    },

    dryRun: envFlag('DRY_RUN', false),
  };
}

export { SECRET_NAMES };
