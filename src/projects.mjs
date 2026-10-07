import { readFileSync } from 'node:fs';

export const DEFAULTS = {
  default_branch: 'main',
  trigger_label: 'agent:assigned',
  execute_label: 'agent:execute',
  triage_label: 'agent:triage',
  mention: '@dev-agent',
  plan_folder: '.agent/plans',
};

/**
 * Plan files are committed into the target repository, so the folder has to stay inside it. The
 * orchestrator writes to `<clone>/<plan_folder>` on the host, which makes an escaping path a write
 * outside the clone rather than a cosmetic problem.
 */
export function normalizePlanFolder(value, where = 'plan_folder') {
  if (value === undefined || value === null || value === '') return DEFAULTS.plan_folder;
  if (typeof value !== 'string') throw new Error(`${where} must be a string`);
  const trimmed = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!trimmed || trimmed === '.') {
    throw new Error(`${where} must name a folder inside the repository, got "${value}"`);
  }
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) {
    throw new Error(`${where} must be relative to the repository root, got "${value}"`);
  }
  const segments = trimmed.split('/').filter((s) => s && s !== '.');
  if (segments.includes('..')) {
    throw new Error(`${where} must not contain "..", got "${value}"`);
  }
  if (segments[0] === '.git') throw new Error(`${where} must not be inside .git, got "${value}"`);
  return segments.join('/');
}

/**
 * Unknown repositories are never admitted. The env var used to opt into that, and a public
 * repo must not grow the switch back: a truthy value refuses to boot instead of being ignored.
 */
export function assertKnownReposOnly(env = process.env) {
  const raw = env.ALLOW_UNKNOWN_REPOS;
  if (raw === undefined || raw === '') return;
  const normalized = String(raw).toLowerCase();
  if (normalized === 'false' || normalized === '0') return;
  throw new Error(
    `ALLOW_UNKNOWN_REPOS=${raw} is not supported. Repositories absent from the registry are always dropped.`
  );
}

function normalizeWebhookSecretEnv(value, where) {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(value)) {
    throw new Error(
      `${where} "webhook_secret_env" is required and must name an environment variable, e.g. WEBHOOK_SECRET_MAIN_APP`
    );
  }
  if (value === 'GITHUB_WEBHOOK_SECRET') {
    throw new Error(
      `${where} "webhook_secret_env" must be a per-repository variable, not GITHUB_WEBHOOK_SECRET`
    );
  }
  return value;
}

function normalizeProject(raw, index) {
  const where = `projects[${index}]`;
  if (!raw || typeof raw !== 'object') throw new Error(`${where} must be an object`);
  if (!raw.slug) throw new Error(`${where} is missing "slug"`);
  if (!raw.repo) throw new Error(`${where} (${raw.slug}) is missing "repo"`);
  if (!raw.repo.includes('/')) {
    throw new Error(`${where} (${raw.slug}) "repo" must be "owner/name", got "${raw.repo}"`);
  }
  if (raw.trusted_logins !== undefined) {
    throw new Error(
      `${where} (${raw.slug}) "trusted_logins" is not supported. Only GitHub write collaborators can enqueue.`
    );
  }

  return {
    slug: raw.slug,
    repo: raw.repo,
    // GitHub treats owner/name case-insensitively; lookups go through this.
    repo_key: raw.repo.toLowerCase(),
    default_branch: raw.default_branch || DEFAULTS.default_branch,
    trigger_label: raw.trigger_label || DEFAULTS.trigger_label,
    execute_label: raw.execute_label || DEFAULTS.execute_label,
    triage_label: raw.triage_label || DEFAULTS.triage_label,
    mention: raw.mention || DEFAULTS.mention,
    plan_folder: normalizePlanFolder(raw.plan_folder, `${where} (${raw.slug}) "plan_folder"`),
    agent_login: raw.agent_login || null,
    webhook_secret_env: normalizeWebhookSecretEnv(raw.webhook_secret_env, `${where} (${raw.slug})`),
  };
}

function parseRegistry(json) {
  const list = Array.isArray(json) ? json : json?.projects;
  if (!Array.isArray(list)) {
    throw new Error('projects config must be an array or an object with a "projects" array');
  }

  const projects = list.map(normalizeProject);

  const seenSlugs = new Set();
  const seenRepos = new Set();
  const seenSecrets = new Set();
  for (const p of projects) {
    if (seenSlugs.has(p.slug)) throw new Error(`duplicate project slug "${p.slug}"`);
    if (seenRepos.has(p.repo_key)) throw new Error(`duplicate repo "${p.repo}"`);
    if (seenSecrets.has(p.webhook_secret_env)) {
      throw new Error(
        `duplicate webhook_secret_env "${p.webhook_secret_env}". Each repository needs its own secret.`
      );
    }
    seenSlugs.add(p.slug);
    seenRepos.add(p.repo_key);
    seenSecrets.add(p.webhook_secret_env);
  }

  return projects;
}

/**
 * The multi-tenant registry.
 *
 * Shared mode: every project in the config file is served.
 * Isolated mode: PROJECT_SLUG narrows this instance to a single project, and webhooks
 * from any other repo are rejected even if they are present in the same config file.
 */
export function loadRegistry({
  configPath = process.env.PROJECTS_CONFIG || './config/projects.json',
  projectSlug = process.env.PROJECT_SLUG || null,
  env = process.env,
} = {}) {
  assertKnownReposOnly(env);

  let projects = [];

  function read() {
    let text;
    try {
      text = readFileSync(configPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(
          `projects config not found at ${configPath}. ` +
            'Copy config/projects.example.json to config/projects.json and set each project\'s webhook_secret_env.'
        );
      }
      throw err;
    }

    let parsed = parseRegistry(JSON.parse(text));

    if (projectSlug) {
      const match = parsed.find((p) => p.slug === projectSlug);
      if (!match) {
        const known = parsed.map((p) => p.slug).join(', ') || '(none)';
        throw new Error(`PROJECT_SLUG="${projectSlug}" is not in ${configPath}. Known slugs: ${known}`);
      }
      parsed = [match];
    }

    return parsed;
  }

  function reload() {
    projects = read();
    return { ok: true, count: projects.length };
  }

  reload();

  return {
    configPath,
    scopedSlug: projectSlug,
    reload,
    list: () => projects.slice(),
    slugs: () => projects.map((p) => p.slug),
    bySlug: (slug) => projects.find((p) => p.slug === slug) || null,

    /**
     * Resolve a repository full_name to its project.
     * Returns null when the repo is not registered. The caller drops that delivery.
     */
    byRepo(fullName) {
      if (!fullName) return null;
      const key = String(fullName).toLowerCase();
      return projects.find((p) => p.repo_key === key) || null;
    },
  };
}
