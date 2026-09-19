const API = 'https://console.neon.tech/api/v2';

export function branchNameFor(issueNumber) {
  return `agent-issue-${issueNumber}`;
}

/**
 * Build the create-branch request body.
 *
 * Two things here are easy to get wrong and both fail loudly only at runtime:
 *  - `parent_id` is a branch_id like `br-aged-salad-637688`, not a branch name. Passing a name
 *    such as 'staging' is a 400.
 *  - without `endpoints`, Neon creates the branch with no compute, so the response carries no
 *    `connection_uris` and the caller ends up writing "undefined" into .env.local.
 *
 * `init_source` defaults to 'parent-schema' rather than Neon's own 'parent-data' default, so an
 * agent branch does not come preloaded with a full copy of the parent's dataset.
 */
export function buildCreateBranchBody({ issueNumber, parentId, initSource = 'parent-schema' }) {
  if (!parentId || !/^br-/.test(parentId)) {
    throw new Error(`Neon parent_id must be a branch id like "br-...", got "${parentId}"`);
  }
  return {
    branch: { name: branchNameFor(issueNumber), parent_id: parentId },
    init_source: initSource,
    endpoints: [{ type: 'read_write' }],
  };
}

/**
 * Neon's pooled host is the direct host with `-pooler` appended to the endpoint id.
 * Returns the input unchanged when it is already pooled or unparseable.
 */
export function toPooledUri(uri) {
  if (!uri) return null;
  try {
    const url = new URL(uri);
    const [first, ...rest] = url.hostname.split('.');
    if (!first || first.endsWith('-pooler')) return uri;
    url.hostname = [`${first}-pooler`, ...rest].join('.');
    return url.toString();
  } catch {
    return uri;
  }
}

export function createNeonClient({ apiKey, fetchImpl = fetch, logger = console }) {
  if (!apiKey) throw new Error('NEON_API_KEY is required for projects with a neon config');

  async function api(method, path, body) {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
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
    if (!res.ok) {
      throw new Error(
        `Neon ${method} ${path} failed (${res.status}): ${parsed?.message || 'unknown error'}`
      );
    }
    return parsed;
  }

  async function listBranches(projectId) {
    const body = await api('GET', `/projects/${projectId}/branches`);
    return body.branches || [];
  }

  async function resolveParentId(projectId, parentBranchName) {
    const branches = await listBranches(projectId);
    const match = branches.find((b) => b.name === parentBranchName);
    if (!match) {
      const known = branches.map((b) => b.name).join(', ') || '(none)';
      throw new Error(
        `Neon project ${projectId} has no branch named "${parentBranchName}". Known: ${known}`
      );
    }
    return match.id;
  }

  async function connectionUriFor(projectId, branchId) {
    const body = await api('GET', `/projects/${projectId}/branches/${branchId}/endpoints`);
    const endpoint = (body.endpoints || []).find((e) => e.type === 'read_write');
    if (!endpoint) return null;
    // The create response carries connection_uris; for a reused branch we rebuild from the roles
    // and databases endpoints instead.
    const [{ name: role } = {}] = (await api(`GET`, `/projects/${projectId}/branches/${branchId}/roles`))
      .roles || [];
    const [{ name: database } = {}] = (
      await api('GET', `/projects/${projectId}/branches/${branchId}/databases`)
    ).databases || [];
    if (!role || !database) return null;

    const passwordBody = await api(
      'GET',
      `/projects/${projectId}/branches/${branchId}/roles/${encodeURIComponent(role)}/reveal_password`
    );
    const password = passwordBody?.password;
    if (!password) return null;
    return `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${endpoint.host}/${database}?sslmode=require`;
  }

  async function waitUntilReady(projectId, branchId, { attempts = 30, delayMs = 2000 } = {}) {
    for (let i = 0; i < attempts; i++) {
      const body = await api('GET', `/projects/${projectId}/branches/${branchId}`);
      if (body.branch?.current_state === 'ready') return body.branch;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error(`Neon branch ${branchId} did not become ready in time`);
  }

  return {
    listBranches,
    resolveParentId,

    /**
     * Idempotent: a follow-up task on the same issue reuses the branch so the agent keeps its
     * database rather than getting a fresh one mid-conversation.
     */
    async ensureBranch({ projectId, parentBranch, issueNumber, initSource }) {
      const name = branchNameFor(issueNumber);
      const existing = (await listBranches(projectId)).find((b) => b.name === name);

      if (existing) {
        logger.log(`[Neon] reusing branch ${name}`);
        await waitUntilReady(projectId, existing.id);
        const uri = await connectionUriFor(projectId, existing.id);
        return { branchId: existing.id, name, created: false, ...splitUris(uri) };
      }

      const parentId = await resolveParentId(projectId, parentBranch);
      const body = buildCreateBranchBody({ issueNumber, parentId, initSource });
      logger.log(`[Neon] creating branch ${name} from ${parentBranch} (${parentId})`);

      const created = await api('POST', `/projects/${projectId}/branches`, body);
      const branchId = created.branch?.id;
      const direct = created.connection_uris?.[0]?.connection_uri || null;

      await waitUntilReady(projectId, branchId);
      const uri = direct || (await connectionUriFor(projectId, branchId));

      return { branchId, name, created: true, ...splitUris(uri) };
    },

    async deleteBranch({ projectId, branchId }) {
      if (!branchId) return false;
      await api('DELETE', `/projects/${projectId}/branches/${branchId}`);
      logger.log(`[Neon] deleted branch ${branchId}`);
      return true;
    },
  };
}

function splitUris(directUri) {
  return {
    databaseUrl: toPooledUri(directUri),
    databaseUrlUnpooled: directUri,
  };
}
