import { readFileSync } from 'node:fs';

export const DEFAULTS = {
  default_branch: 'main',
  trigger_label: 'agent:assigned',
  execute_label: 'agent:execute',
  mention: '@dev-agent',
};

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function slugifyRepo(fullName) {
  return fullName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function normalizeProject(raw, index) {
  const where = `projects[${index}]`;
  if (!raw || typeof raw !== 'object') throw new Error(`${where} must be an object`);
  if (!raw.slug) throw new Error(`${where} is missing "slug"`);
  if (!raw.repo) throw new Error(`${where} (${raw.slug}) is missing "repo"`);
  if (!raw.repo.includes('/')) {
    throw new Error(`${where} (${raw.slug}) "repo" must be "owner/name", got "${raw.repo}"`);
  }

  return {
    slug: raw.slug,
    repo: raw.repo,
    // GitHub treats owner/name case-insensitively; lookups go through this.
    repo_key: raw.repo.toLowerCase(),
    default_branch: raw.default_branch || DEFAULTS.default_branch,
    trigger_label: raw.trigger_label || DEFAULTS.trigger_label,
    execute_label: raw.execute_label || DEFAULTS.execute_label,
    mention: raw.mention || DEFAULTS.mention,
    agent_login: raw.agent_login || null,
    webhook_secret_env: raw.webhook_secret_env || null,
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
  for (const p of projects) {
    if (seenSlugs.has(p.slug)) throw new Error(`duplicate project slug "${p.slug}"`);
    if (seenRepos.has(p.repo_key)) throw new Error(`duplicate repo "${p.repo}"`);
    seenSlugs.add(p.slug);
    seenRepos.add(p.repo_key);
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
  allowUnknownRepos = envFlag('ALLOW_UNKNOWN_REPOS', false),
} = {}) {
  let projects = [];
  let loadError = null;

  function read() {
    let text;
    try {
      text = readFileSync(configPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(
          `projects config not found at ${configPath}. ` +
            'Copy config/projects.example.json to config/projects.json, or set ALLOW_UNKNOWN_REPOS=true to run without a registry.'
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
    try {
      projects = read();
      loadError = null;
    } catch (err) {
      // With ALLOW_UNKNOWN_REPOS the registry is optional, so a missing or broken file
      // degrades to an empty registry instead of refusing to boot.
      if (allowUnknownRepos) {
        projects = [];
        loadError = err;
        return { ok: false, error: err };
      }
      throw err;
    }
    return { ok: true, count: projects.length };
  }

  reload();

  return {
    configPath,
    scopedSlug: projectSlug,
    allowUnknownRepos,
    reload,
    get loadError() {
      return loadError;
    },
    list: () => projects.slice(),
    slugs: () => projects.map((p) => p.slug),
    bySlug: (slug) => projects.find((p) => p.slug === slug) || null,

    /**
     * Resolve a repository full_name to its project.
     * Returns null when the repo is not registered and unknown repos are not allowed —
     * the caller turns that into a rejected delivery rather than a "default-project" row.
     */
    byRepo(fullName) {
      if (!fullName) return null;
      const key = String(fullName).toLowerCase();
      const match = projects.find((p) => p.repo_key === key);
      if (match) return match;
      if (!allowUnknownRepos) return null;
      // PROJECT_SLUG pins this instance to one project; never synthesize past it.
      if (projectSlug) return null;
      return {
        ...DEFAULTS,
        slug: slugifyRepo(fullName),
        repo: fullName,
        repo_key: key,
        agent_login: null,
        webhook_secret_env: null,
        synthesized: true,
      };
    },
  };
}
