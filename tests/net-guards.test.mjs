import assert from 'node:assert/strict';
import http from 'node:http';
import test, { describe } from 'node:test';

import { checkControlRequest, isLoopbackAddress } from '../src/net-guards.mjs';
import { createGithubMeta, ipInCidr, parseIp } from '../src/github-meta.mjs';
import { openDatabase } from '../src/db.mjs';
import { loadRegistry } from '../src/projects.mjs';
import { createControlApp, createWebhookApp, loadConfig } from '../src/server.mjs';
import { createLogger } from '../src/server.mjs';

const CONFIG_PATH = new URL('../fixtures/projects.test.json', import.meta.url).pathname;
const silent = createLogger('test', { log() {}, warn() {}, error() {} });

const allowedHosts = ['127.0.0.1:3001', 'localhost:3001'];
const cliRequest = () => ({
  headers: { host: '127.0.0.1:3001', authorization: 'Bearer x' },
  socket: { remoteAddress: '127.0.0.1' },
});

describe('control-plane guard', () => {
  test('a plain CLI request passes', () => {
    assert.equal(checkControlRequest(cliRequest(), { allowedHosts }).ok, true);
  });

  test('a DNS rebinding attempt is rejected: it carries the attacker Host', () => {
    const req = cliRequest();
    req.headers.host = 'evil.example.com';
    assert.equal(checkControlRequest(req, { allowedHosts }).reason, 'host_not_allowed');
  });

  test('a Host with the right name but wrong port is rejected', () => {
    const req = cliRequest();
    req.headers.host = '127.0.0.1:9999';
    assert.equal(checkControlRequest(req, { allowedHosts }).ok, false);
  });

  test('any Origin header is rejected, because a CLI never sends one', () => {
    const req = cliRequest();
    req.headers.origin = 'https://evil.example.com';
    assert.equal(checkControlRequest(req, { allowedHosts }).reason, 'origin_header_present');
  });

  test('even a same-origin Origin is rejected, which is what defeats rebinding', () => {
    const req = cliRequest();
    req.headers.origin = 'http://127.0.0.1:3001';
    assert.equal(checkControlRequest(req, { allowedHosts }).ok, false);
  });

  test('Sec-Fetch-Site is rejected; page JavaScript cannot strip it', () => {
    for (const value of ['same-origin', 'cross-site', 'none']) {
      const req = cliRequest();
      req.headers['sec-fetch-site'] = value;
      assert.equal(checkControlRequest(req, { allowedHosts }).ok, false, value);
    }
  });

  test("Sec-Fetch-Mode alone is allowed, because Node's fetch() sends it", () => {
    // Measured on Node 20: fetch() sends `sec-fetch-mode: cors` and no sec-fetch-site. Rejecting
    // on Mode would lock out every non-browser client using fetch, and browsers never send Mode
    // without Site, so keying on Site alone loses no coverage.
    const req = cliRequest();
    req.headers['sec-fetch-mode'] = 'cors';
    assert.equal(checkControlRequest(req, { allowedHosts }).ok, true);
  });

  test('a missing Host is rejected', () => {
    assert.equal(checkControlRequest({ headers: {}, socket: {} }, { allowedHosts }).ok, false);
  });

  test('the loopback peer check is opt-in, because docker rewrites the peer address', () => {
    const viaBridge = {
      headers: { host: '127.0.0.1:3001' },
      socket: { remoteAddress: '172.18.0.1' },
    };
    assert.equal(checkControlRequest(viaBridge, { allowedHosts }).ok, true);
    assert.equal(
      checkControlRequest(viaBridge, { allowedHosts, requireLoopbackPeer: true }).reason,
      'non_loopback_peer'
    );
  });

  test('recognizes the loopback forms node reports', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      assert.ok(isLoopbackAddress(address), address);
    }
    assert.equal(isLoopbackAddress('10.0.0.5'), false);
  });
});

describe('listener split', () => {
  /** GET /api/health with an arbitrary Host header, which fetch() will not let us forge. */
  function statusWithHost(port, host) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/health', headers: { host } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  function boot(app) {
    const server = app.listen(0);
    return new Promise((resolve) => {
      server.once('listening', () =>
        resolve({ server, base: `http://127.0.0.1:${server.address().port}` })
      );
    });
  }

  test('the tunnel-facing app serves the webhook and nothing else', async () => {
    const db = openDatabase(':memory:');
    const registry = loadRegistry({ configPath: CONFIG_PATH });
    const config = { ...loadConfig({}), pollSecret: 'poll-secret' };
    const app = createWebhookApp({ db, registry, config, log: silent });
    const { server, base } = await boot(app);

    try {
      // These are the endpoints that would otherwise be live on a public trycloudflare hostname.
      for (const path of ['/api/agent/poll', '/api/agent/tasks', '/api/health']) {
        const res = await fetch(`${base}${path}`, {
          method: path === '/api/agent/poll' ? 'POST' : 'GET',
          headers: { authorization: 'Bearer poll-secret' },
        });
        assert.equal(res.status, 404, `${path} must not exist on the webhook listener`);
      }
      // The webhook route itself is present; an unsigned request is rejected, not 404.
      const webhook = await fetch(`${base}/api/agent/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-github-event': 'issues' },
        body: '{}',
      });
      assert.notEqual(webhook.status, 404);
    } finally {
      server.close();
      db.close();
    }
  });

  test('the control app serves the orchestrator endpoints and rejects browser-shaped requests', async () => {
    const db = openDatabase(':memory:');
    const registry = loadRegistry({ configPath: CONFIG_PATH });
    const app = createControlApp({
      db,
      registry,
      // An empty allowlist would disable the guard, so pin it to the port we bind below.
      config: { ...loadConfig({}), pollSecret: 'poll-secret', controlAllowedHosts: [] },
      log: silent,
    });
    const { server, base } = await boot(app);
    const host = `127.0.0.1:${server.address().port}`;

    try {
      const ok = await fetch(`${base}/api/health`, { headers: { host } });
      assert.equal(ok.status, 200);

      // The guard closes over this array, so the real host can be pushed once the port is known.
      // It has to start non-empty, because an empty allowlist means "no guard".
      const allowed = ['placeholder.invalid'];
      const guarded = createControlApp({
        db,
        registry,
        config: { ...loadConfig({}), pollSecret: 'poll-secret', controlAllowedHosts: allowed },
        log: silent,
      });
      const second = await boot(guarded);
      try {
        allowed.push(`127.0.0.1:${second.server.address().port}`);

        // A CLI shape: node's fetch sets Host itself, sends no Origin, and sends no
        // Sec-Fetch-Site. This must pass, and it is exactly what the orchestrator looks like.
        const fromCli = await fetch(`${second.base}/api/health`);
        assert.equal(fromCli.status, 200);

        const fromBrowser = await fetch(`${second.base}/api/health`, {
          headers: { origin: 'https://evil.example.com' },
        });
        assert.equal(fromBrowser.status, 403);

        // A rebinding attempt resolves the attacker's hostname to 127.0.0.1, so it reaches the
        // listener but carries the wrong Host. This needs node:http, because Host is a forbidden
        // header that fetch() silently replaces with the real authority.
        const rebound = await statusWithHost(
          second.server.address().port,
          'attacker.example.com'
        );
        assert.equal(rebound, 403);
      } finally {
        second.server.close();
      }
    } finally {
      server.close();
      db.close();
    }
  });

  test('the webhook route still requires a valid signature', async () => {
    const db = openDatabase(':memory:');
    const registry = loadRegistry({ configPath: CONFIG_PATH });
    // main-app declares webhook_secret_env, so without this the secret check 503s before the
    // signature is ever examined.
    process.env.WEBHOOK_SECRET_MAIN_APP = 'scoped-secret-for-main-app';
    const app = createWebhookApp({
      db,
      registry,
      config: { ...loadConfig({}), pollSecret: 'x' },
      log: silent,
    });
    const { server, base } = await boot(app);
    try {
      const res = await fetch(`${base}/api/agent/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-hub-signature-256': 'sha256=deadbeef',
        },
        body: JSON.stringify({ repository: { full_name: 'my-org/primary-app' } }),
      });
      assert.equal(res.status, 401);
    } finally {
      delete process.env.WEBHOOK_SECRET_MAIN_APP;
      server.close();
      db.close();
    }
  });

  test('a source outside GitHub hooks ranges is rejected', async () => {
    const db = openDatabase(':memory:');
    const registry = loadRegistry({ configPath: CONFIG_PATH });
    const meta = createGithubMeta({
      fetchImpl: async () => ({ ok: true, json: async () => ({ hooks: ['10.9.9.0/24'] }) }),
    });
    await meta.refresh();
    const app = createWebhookApp({
      db,
      registry,
      config: { ...loadConfig({}), pollSecret: 'x' },
      log: silent,
      meta,
    });
    const { server, base } = await boot(app);
    try {
      const res = await fetch(`${base}/api/agent/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-github-event': 'issues' },
        body: '{}',
      });
      assert.equal(res.status, 403);
    } finally {
      server.close();
      db.close();
    }
  });

  test('WEBHOOK_IP_CHECK cannot be turned off', () => {
    assert.doesNotThrow(() => loadConfig({}));
    assert.doesNotThrow(() => loadConfig({ WEBHOOK_IP_CHECK: 'enforce' }));
    assert.doesNotThrow(() => loadConfig({ WEBHOOK_IP_CHECK: 'true' }));
    assert.throws(() => loadConfig({ WEBHOOK_IP_CHECK: 'warn' }), /WEBHOOK_IP_CHECK=warn is not supported/);
    assert.throws(() => loadConfig({ WEBHOOK_IP_CHECK: 'off' }), /WEBHOOK_IP_CHECK=off is not supported/);
    assert.throws(() => loadConfig({ WEBHOOK_IP_CHECK: 'false' }), /WEBHOOK_IP_CHECK=false is not supported/);
  });
});

describe('github source ranges', () => {
  test('matches ipv4 inside and outside a cidr', () => {
    assert.equal(ipInCidr('192.30.252.10', '192.30.252.0/22'), true);
    assert.equal(ipInCidr('192.30.255.255', '192.30.252.0/22'), true);
    assert.equal(ipInCidr('192.31.0.1', '192.30.252.0/22'), false);
    assert.equal(ipInCidr('10.0.0.1', '192.30.252.0/22'), false);
  });

  test('matches ipv6 and never confuses the two families', () => {
    assert.equal(ipInCidr('2a0a:a440::1', '2a0a:a440::/29'), true);
    assert.equal(ipInCidr('2606:4700::1', '2a0a:a440::/29'), false);
    assert.equal(ipInCidr('192.30.252.10', '2a0a:a440::/29'), false);
    assert.equal(ipInCidr('2a0a:a440::1', '192.30.252.0/22'), false);
  });

  test('handles the ipv4-mapped form node reports on a dual-stack socket', () => {
    assert.equal(ipInCidr('::ffff:192.30.252.10', '192.30.252.0/22'), true);
    assert.equal(parseIp('::ffff:127.0.0.1').bits, 32);
  });

  test('garbage input is false rather than an exception mid-request', () => {
    assert.equal(ipInCidr('not-an-ip', '192.30.252.0/22'), false);
    assert.equal(ipInCidr('192.30.252.10', 'nonsense'), false);
    assert.equal(ipInCidr(undefined, '192.30.252.0/22'), false);
  });

  test('an unloaded range list answers "unknown" so deliveries are not silently dropped', async () => {
    const meta = createGithubMeta({
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    assert.equal((await meta.refresh()).ok, false);
    assert.equal(meta.contains('192.30.252.10'), null);
    assert.equal(meta.loaded, false);
  });

  test('a loaded list answers definitively', async () => {
    const meta = createGithubMeta({
      fetchImpl: async () => ({ ok: true, json: async () => ({ hooks: ['192.30.252.0/22'] }) }),
    });
    assert.equal((await meta.refresh()).ok, true);
    assert.equal(meta.contains('192.30.252.10'), true);
    assert.equal(meta.contains('10.0.0.1'), false);
  });

  test('an empty hooks array is a failure, not an allowlist that blocks everything', async () => {
    const meta = createGithubMeta({
      fetchImpl: async () => ({ ok: true, json: async () => ({ hooks: [] }) }),
    });
    assert.equal((await meta.refresh()).ok, false);
    assert.equal(meta.contains('192.30.252.10'), null);
  });

  test('a failed refresh keeps the previously loaded ranges rather than opening up', async () => {
    let calls = 0;
    const meta = createGithubMeta({
      refreshMs: 0,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return { ok: true, json: async () => ({ hooks: ['192.30.252.0/22'] }) };
        throw new Error('offline');
      },
    });
    await meta.refresh();
    await meta.refresh(true);
    assert.equal(meta.contains('192.30.252.10'), true);
    assert.equal(meta.contains('10.0.0.1'), false);
  });
});
