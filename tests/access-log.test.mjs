import assert from 'node:assert/strict';
import http from 'node:http';
import test, { describe } from 'node:test';

import { signBody } from '../src/auth.mjs';
import {
  clientIp,
  normalizeIp,
  pruneTunnelHits,
  readAccessLog,
  recordTunnelHit,
  requestPath,
} from '../src/access-log.mjs';
import { openDatabase } from '../src/db.mjs';
import { createCoalescer, notifyAdmin } from '../src/notify.mjs';
import { createGithubMeta } from '../src/github-meta.mjs';
import { loadRegistry } from '../src/projects.mjs';
import { createControlApp, createLogger, createWebhookApp, loadConfig } from '../src/server.mjs';
import { leakNeedles } from '../orchestrator/leak.mjs';
import { refuseIfLeak } from '../orchestrator/leak-alert.mjs';

const CONFIG_PATH = new URL('../fixtures/projects.test.json', import.meta.url).pathname;
const silent = createLogger('test', { log() {}, warn() {}, error() {} });

function boot(app) {
  const server = app.listen(0);
  return new Promise((resolve) => {
    server.once('listening', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('tunnel address helpers', () => {
  test('mapped IPv4 addresses collapse to one row', () => {
    assert.equal(normalizeIp('::ffff:203.0.113.8'), '203.0.113.8');
    assert.equal(normalizeIp('203.0.113.8'), '203.0.113.8');
    assert.equal(normalizeIp(''), 'unknown');
  });

  test('CF-Connecting-IP wins over the tunnel socket', () => {
    const req = {
      headers: { 'cf-connecting-ip': '::ffff:198.51.100.4' },
      socket: { remoteAddress: '172.18.0.2' },
      path: '/wp-login.php?token=hunter2',
    };
    assert.equal(clientIp(req), '198.51.100.4');
    assert.equal(requestPath(req), '/wp-login.php');
  });
});

describe('tunnel journal', () => {
  test('a probe alerts once, a later one reports the hits in between, a delivery does not', () => {
    const db = openDatabase(':memory:');
    try {
      const first = recordTunnelHit(db, {
        ip: '203.0.113.8',
        method: 'GET',
        path: '/wp-login.php',
        status: 404,
        reason: 'unknown_route',
        userAgent: 'scanner',
      });
      assert.equal(first.notify, true);
      assert.equal(first.count, 1);

      const quiet = recordTunnelHit(db, {
        ip: '203.0.113.8',
        method: 'GET',
        path: '/.env',
        status: 404,
        reason: 'unknown_route',
        userAgent: null,
      });
      assert.equal(quiet.notify, false);

      db.prepare(`UPDATE tunnel_ips SET last_notified_at = datetime('now', '-16 minutes') WHERE ip = ?`).run(
        '203.0.113.8'
      );
      const again = recordTunnelHit(db, {
        ip: '203.0.113.8',
        method: 'GET',
        path: '/',
        status: 404,
        reason: 'unknown_route',
        userAgent: null,
      });
      assert.equal(again.notify, true);
      assert.equal(again.count, 2);

      const delivery = recordTunnelHit(db, {
        ip: '140.82.112.1',
        method: 'POST',
        path: '/api/agent/webhook',
        status: 200,
        reason: 'github_delivery',
        userAgent: 'GitHub-Hookshot',
      });
      assert.equal(delivery.notify, false);
      const rollup = readAccessLog(db);
      assert.equal(rollup.hits.some((hit) => hit.reason === 'github_delivery'), false);
      assert.equal(rollup.ips.find((row) => row.ip === '140.82.112.1').hits, 1);
      assert.equal(rollup.ips.find((row) => row.ip === '140.82.112.1').unusual_hits, 0);
    } finally {
      db.close();
    }
  });

  test('hits older than 30 days are removed and the IP rollup stays', () => {
    const db = openDatabase(':memory:');
    try {
      db.prepare(
        `INSERT INTO tunnel_hits (ip, method, path, status, reason, created_at)
         VALUES ('203.0.113.9', 'GET', '/old', 404, 'unknown_route', datetime('now', '-31 days'))`
      ).run();
      recordTunnelHit(db, {
        ip: '203.0.113.9',
        method: 'GET',
        path: '/new',
        status: 404,
        reason: 'unknown_route',
        userAgent: null,
      });
      assert.equal(pruneTunnelHits(db), 1);
      const left = db.prepare(`SELECT path FROM tunnel_hits`).all();
      assert.deepEqual(left.map((row) => row.path), ['/new']);
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM tunnel_ips`).get().n, 1);
    } finally {
      db.close();
    }
  });
});

describe('webhook listener access log', () => {
  test('a probe is recorded and notified once, and a failed notify still returns 404', async () => {
    const db = openDatabase(':memory:');
    const registry = loadRegistry({ configPath: CONFIG_PATH });
    const notes = [];
    const notify = async (message) => {
      notes.push(message);
    };
    const app = createWebhookApp({
      db,
      registry,
      config: { ...loadConfig({}), pollSecret: 'x' },
      log: silent,
      notify,
    });
    const { server, base } = await boot(app);
    try {
      const first = await fetch(`${base}/wp-login.php?token=hunter2`, {
        headers: { 'user-agent': 'scanner', 'cf-connecting-ip': '203.0.113.10' },
      });
      assert.equal(first.status, 404);
      await settle();
      assert.equal(notes.length, 1);
      assert.match(notes[0].body, /203\.0\.113\.10 GET \/wp-login\.php → 404 unknown_route/);
      assert.equal(notes[0].body.includes('hunter2'), false);
      assert.equal(notes[0].title, 'tmt tunnel');

      const second = await fetch(`${base}/.env`, { headers: { 'cf-connecting-ip': '203.0.113.10' } });
      assert.equal(second.status, 404);
      await settle();
      assert.equal(notes.length, 1);

      const row = db.prepare(`SELECT path FROM tunnel_hits WHERE ip = ? ORDER BY id`).all('203.0.113.10');
      assert.deepEqual(row.map((hit) => hit.path), ['/wp-login.php', '/.env']);
    } finally {
      server.close();
      db.close();
    }

    const failing = openDatabase(':memory:');
    let calls = 0;
    const broken = createWebhookApp({
      db: failing,
      registry,
      config: { ...loadConfig({}), pollSecret: 'x' },
      log: silent,
      notify: async () => {
        calls += 1;
        throw new Error('down');
      },
    });
    const secondServer = await boot(broken);
    try {
      const res = await fetch(`${secondServer.base}/nope`);
      assert.equal(res.status, 404);
      await settle();
      assert.equal(calls, 1);
    } finally {
      secondServer.server.close();
      failing.close();
    }
  });

  test('a signed webhook is stored as a delivery and does not notify', async () => {
    const db = openDatabase(':memory:');
    const registry = loadRegistry({ configPath: CONFIG_PATH });
    process.env.WEBHOOK_SECRET_MAIN_APP = 'scoped-secret-for-main-app';
    const notes = [];
    const app = createWebhookApp({
      db,
      registry,
      config: { ...loadConfig({}), pollSecret: 'x' },
      log: silent,
      notify: async (message) => {
        notes.push(message);
      },
    });
    const { server, base } = await boot(app);
    try {
      const body = JSON.stringify({
        zen: 'design for failure',
        repository: { full_name: 'my-org/primary-app' },
        secret: 'do-not-leak-this-body',
      });
      const res = await fetch(`${base}/api/agent/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'ping',
          'x-hub-signature-256': signBody(body, process.env.WEBHOOK_SECRET_MAIN_APP),
          'cf-connecting-ip': '140.82.115.17',
        },
        body,
      });
      assert.equal(res.status, 200);
      await settle();
      assert.equal(notes.length, 0);
      const hit = db.prepare(`SELECT reason, path FROM tunnel_hits`).get();
      assert.equal(hit.reason, 'github_delivery');
      assert.equal(hit.path, '/api/agent/webhook');
      assert.equal(JSON.stringify(hit).includes('do-not-leak-this-body'), false);
    } finally {
      delete process.env.WEBHOOK_SECRET_MAIN_APP;
      server.close();
      db.close();
    }
  });

  test('an address outside GitHub ranges is an unusual hit', async () => {
    const db = openDatabase(':memory:');
    const registry = loadRegistry({ configPath: CONFIG_PATH });
    const meta = createGithubMeta({
      fetchImpl: async () => ({ ok: true, json: async () => ({ hooks: ['10.9.9.0/24'] }) }),
    });
    await meta.refresh();
    const notes = [];
    const app = createWebhookApp({
      db,
      registry,
      config: { ...loadConfig({}), pollSecret: 'x' },
      log: silent,
      meta,
      notify: async (message) => {
        notes.push(message);
      },
    });
    const { server, base } = await boot(app);
    try {
      const res = await fetch(`${base}/api/agent/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.50' },
        body: '{}',
      });
      assert.equal(res.status, 403);
      await settle();
      assert.equal(notes.length, 1);
      assert.match(notes[0].body, /outside_github_ranges/);
      assert.equal(notes[0].body.includes('{}'), false);
    } finally {
      server.close();
      db.close();
    }
  });

  test('GET /api/agent/access returns the rollup behind the bearer', async () => {
    const db = openDatabase(':memory:');
    const registry = loadRegistry({ configPath: CONFIG_PATH });
    recordTunnelHit(db, {
      ip: '203.0.113.11',
      method: 'GET',
      path: '/',
      status: 404,
      reason: 'unknown_route',
      userAgent: null,
    });
    const allowed = ['placeholder.invalid'];
    const app = createControlApp({
      db,
      registry,
      config: { ...loadConfig({}), pollSecret: 'poll-secret', controlAllowedHosts: allowed },
      log: silent,
      notify: async () => {},
    });
    const { server, base } = await boot(app);
    allowed.push(`127.0.0.1:${server.address().port}`);
    try {
      const denied = await fetch(`${base}/api/agent/access`);
      assert.equal(denied.status, 401);
      const res = await fetch(`${base}/api/agent/access`, {
        headers: { authorization: 'Bearer poll-secret' },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ips[0].ip, '203.0.113.11');
      assert.equal(body.hits[0].reason, 'unknown_route');
    } finally {
      server.close();
      db.close();
    }
  });
});

describe('control-plane alerts', () => {
  test('a reject notifies once per reason', async () => {
    const db = openDatabase(':memory:');
    const registry = loadRegistry({ configPath: CONFIG_PATH });
    const notes = [];
    const allowed = ['placeholder.invalid'];
    const app = createControlApp({
      db,
      registry,
      config: { ...loadConfig({}), pollSecret: 'poll-secret', controlAllowedHosts: allowed },
      log: silent,
      notify: async (message) => {
        notes.push(message.body);
      },
    });
    const { server, base } = await boot(app);
    allowed.push(`127.0.0.1:${server.address().port}`);
    try {
      const first = await fetch(`${base}/api/health`, { headers: { origin: 'https://evil.example.com' } });
      const second = await fetch(`${base}/api/health`, { headers: { origin: 'https://evil.example.com' } });
      assert.equal(first.status, 403);
      assert.equal(second.status, 403);
      await settle();
      assert.equal(notes.length, 1);
      assert.match(notes[0], /origin_header_present/);

      const rebound = await new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: server.address().port, path: '/api/health', headers: { host: 'attacker.example' } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          }
        );
        req.on('error', reject);
        req.end();
      });
      assert.equal(rebound, 403);
      await settle();
      assert.equal(notes.length, 2);
      assert.match(notes[1], /host_not_allowed/);
    } finally {
      server.close();
      db.close();
    }
  });
});

describe('admin notify', () => {
  test('an empty URL does not call fetch', async () => {
    let called = false;
    const ok = await notifyAdmin({
      body: 'probe',
      env: {},
      fetchImpl: async () => {
        called = true;
        return { ok: true };
      },
    });
    assert.equal(ok, false);
    assert.equal(called, false);
  });

  test('the post is plain text with ntfy headers and no URL in the failure log', async () => {
    const seen = [];
    const ok = await notifyAdmin({
      title: 'tmt tunnel',
      tags: 'warning',
      body: '203.0.113.8 GET / → 404 unknown_route',
      env: { ADMIN_NOTIFY_URL: 'https://ntfy.example/topic-secret', ADMIN_NOTIFY_TOKEN: 'tok' },
      fetchImpl: async (url, init) => {
        seen.push({ url, init });
        return { ok: true };
      },
    });
    assert.equal(ok, true);
    assert.equal(seen[0].init.method, 'POST');
    assert.equal(seen[0].init.body, '203.0.113.8 GET / → 404 unknown_route');
    assert.equal(seen[0].init.headers.Title, 'tmt tunnel');
    assert.equal(seen[0].init.headers.Tags, 'warning');
    assert.equal(seen[0].init.headers.Authorization, 'Bearer tok');

    const warnings = [];
    const failed = await notifyAdmin({
      body: 'probe',
      env: { ADMIN_NOTIFY_URL: 'https://ntfy.example/topic-secret' },
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED https://ntfy.example/topic-secret');
      },
      log: { warn: (message) => warnings.push(message) },
    });
    assert.equal(failed, false);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].includes('topic-secret'), false);
    assert.equal(warnings[0].includes('https://'), false);
  });
});

describe('leak alerts', () => {
  test('the first refusal pages with needle names, a repeat does not, and a failed notify still refuses', async () => {
    const needles = leakNeedles({ secrets: { GITHUB_TOKEN: 'ghp_1234567890abcdef' } });
    const notes = [];
    const coalescer = createCoalescer();
    const notify = async (message) => {
      notes.push(message.body);
    };
    const text = 'token ghp_1234567890abcdef';
    await assert.rejects(() => refuseIfLeak(text, needles, { label: 'main-app #7', issueNumber: 7, notify, coalescer }), /GITHUB_TOKEN/);
    await assert.rejects(() => refuseIfLeak(text, needles, { label: 'main-app #7', issueNumber: 7, notify, coalescer }), /GITHUB_TOKEN/);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /main-app #7/);
    assert.match(notes[0], /GITHUB_TOKEN/);
    assert.equal(notes[0].includes('ghp_1234567890abcdef'), false);

    await assert.rejects(
      () =>
        refuseIfLeak(text, needles, {
          label: 'main-app #7',
          issueNumber: 7,
          notify: async () => {
            throw new Error('down');
          },
          coalescer: createCoalescer(),
        }),
      /refusing to publish/
    );

    await refuseIfLeak('all clear', needles, { label: 'main-app #7', notify, coalescer });
    assert.equal(notes.length, 1);
  });
});
