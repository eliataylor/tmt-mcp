const API = 'https://api.github.com';

/**
 * GitHub REST access over plain fetch.
 *
 * No `gh` dependency: it is not installed on this host, and shelling out to it would mean handing
 * the token to another process for no benefit.
 */
export function createGithubClient({ token, fetchImpl = fetch, logger = console }) {
  if (!token) throw new Error('GITHUB_TOKEN is required');

  async function api(method, path, body) {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'tmt-agent-orchestrator',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { message: text.slice(0, 500) };
    }
    return { ok: res.ok, status: res.status, body: parsed };
  }

  function must(res, what) {
    if (!res.ok) {
      throw new Error(`${what} failed (${res.status}): ${res.body?.message || 'unknown error'}`);
    }
    return res.body;
  }

  return {
    async findOpenPullRequest({ owner, repo, branch }) {
      const res = await api(
        'GET',
        `/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`
      );
      const list = must(res, 'Listing pull requests');
      return Array.isArray(list) && list.length ? list[0] : null;
    },

    /**
     * Draft pull requests are a paid feature on private repositories. Rather than requiring the
     * caller to know the plan, fall back to a normal PR when GitHub rejects the draft flag.
     */
    async createPullRequest({ owner, repo, title, head, base, body, draft = true }) {
      const res = await api('POST', `/repos/${owner}/${repo}/pulls`, {
        title,
        head,
        base,
        body,
        draft,
      });

      if (res.ok) return { pr: res.body, draft };

      const message = res.body?.message || '';
      const errors = JSON.stringify(res.body?.errors || []);
      if (draft && res.status === 422 && /draft/i.test(`${message} ${errors}`)) {
        logger.warn('[GitHub] draft PRs unavailable on this repo/plan; opening a normal PR');
        const retry = await api('POST', `/repos/${owner}/${repo}/pulls`, {
          title,
          head,
          base,
          body,
          draft: false,
        });
        return { pr: must(retry, 'Creating pull request'), draft: false };
      }

      return { pr: must(res, 'Creating pull request'), draft };
    },

    async ensurePullRequest({ owner, repo, branch, base, title, body }) {
      const existing = await this.findOpenPullRequest({ owner, repo, branch });
      if (existing) {
        logger.log(`[GitHub] reusing existing PR #${existing.number}`);
        return { pr: existing, created: false };
      }
      const { pr, draft } = await this.createPullRequest({
        owner,
        repo,
        title,
        head: branch,
        base,
        body,
      });
      logger.log(`[GitHub] opened ${draft ? 'draft ' : ''}PR #${pr.number}`);
      return { pr, created: true, draft };
    },

    async commentOnIssue({ owner, repo, issueNumber, body }) {
      const res = await api('POST', `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
        body,
      });
      return must(res, 'Commenting on issue');
    },

    async getRepo({ owner, repo }) {
      return must(await api('GET', `/repos/${owner}/${repo}`), 'Reading repository');
    },
  };
}
