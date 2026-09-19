import http from 'node:http';

/**
 * The orchestrator's only channel to the queue.
 *
 * Uses node:http rather than fetch so `socketPath` stays available without undici's non-standard
 * `dispatcher` option. It also sends none of the headers the control-plane guard rejects: no
 * Origin, no Sec-Fetch-*, and a Host that node derives from host:port and therefore matches the
 * server's allowlist.
 */
export function createQueueClient({ host, port, socketPath, timeoutMs = 15000, token }) {
  if (!token) throw new Error('AGENT_POLL_SECRET is required to talk to the queue');

  function request(method, path, body) {
    return new Promise((resolvePromise, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');

      const options = {
        method,
        path,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': payload.length }
            : {}),
        },
        timeout: timeoutMs,
      };

      if (socketPath) {
        options.socketPath = socketPath;
        // With socketPath node sends no Host, but the guard requires one from the allowlist.
        options.headers.host = `${host}:${port}`;
      } else {
        options.host = host;
        options.port = port;
      }

      const req = http.request(options, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
          // The queue never returns anything large; a runaway body is a bug, not data.
          if (raw.length > 8 * 1024 * 1024) req.destroy(new Error('response too large'));
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            return reject(new Error(`${method} ${path} returned non-JSON (${res.statusCode})`));
          }
          resolvePromise({ status: res.statusCode, body: parsed });
        });
      });

      req.on('timeout', () => req.destroy(new Error(`${method} ${path} timed out`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function expectOk(method, path, body, { allowStatuses = [] } = {}) {
    const res = await request(method, path, body);
    if (res.status === 200 || allowStatuses.includes(res.status)) return res;
    const detail = res.body?.error || `status ${res.status}`;
    throw Object.assign(new Error(`${method} ${path} failed: ${detail}`), {
      status: res.status,
      body: res.body,
    });
  }

  return {
    describe: () => (socketPath ? `unix:${socketPath}` : `http://${host}:${port}`),

    async health() {
      const res = await expectOk('GET', '/api/health');
      return res.body;
    },

    async poll({ worker, projectSlugs, leaseSeconds }) {
      const res = await expectOk('POST', '/api/agent/poll', {
        worker,
        ...(projectSlugs?.length ? { project_slugs: projectSlugs } : {}),
        ...(leaseSeconds ? { lease_seconds: leaseSeconds } : {}),
      });
      return res.body?.task || null;
    },

    /** 409 is expected when the reaper or a cancel already moved the row out of processing. */
    async complete(id) {
      const res = await expectOk('POST', `/api/agent/tasks/${id}/complete`, undefined, {
        allowStatuses: [409],
      });
      return { applied: res.status === 200, status: res.status };
    },

    async fail(id, error) {
      const res = await expectOk('POST', `/api/agent/tasks/${id}/fail`, { error }, {
        allowStatuses: [409],
      });
      return { applied: res.status === 200, status: res.status };
    },

    /**
     * A 409 here is meaningful rather than an error: it means the row is no longer 'processing',
     * which is how a cancelled issue or a reaped lease reaches a container that is still running.
     */
    async heartbeat(id, { leaseSeconds } = {}) {
      const res = await expectOk(
        'POST',
        `/api/agent/tasks/${id}/heartbeat`,
        leaseSeconds ? { lease_seconds: leaseSeconds } : {},
        { allowStatuses: [409] }
      );
      return {
        applied: res.status === 200,
        status: res.status,
        taskStatus: res.body?.status || null,
      };
    },

    async getTask(id) {
      const res = await expectOk('GET', `/api/agent/tasks/${id}`, undefined, {
        allowStatuses: [404],
      });
      return res.status === 200 ? res.body.task : null;
    },

    async listTasks({ status, projectSlug, limit } = {}) {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (projectSlug) params.set('project_slug', projectSlug);
      if (limit) params.set('limit', String(limit));
      const query = params.toString();
      const res = await expectOk('GET', `/api/agent/tasks${query ? `?${query}` : ''}`);
      return res.body?.tasks || [];
    },
  };
}
