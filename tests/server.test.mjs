import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

import { signBody } from '../src/auth.mjs';
import { openDatabase } from '../src/db.mjs';
import { loadRegistry } from '../src/projects.mjs';
import { createApp, createLogger, loadConfig } from '../src/server.mjs';
import { fixtureBuffer } from './helpers.mjs';

const CONFIG_PATH = new URL('../fixtures/projects.test.json', import.meta.url).pathname;
const MAIN_SECRET = 'scoped-secret-for-main-app';
const SIDE_SECRET = 'scoped-secret-for-side-project';
const GLOBAL_SECRET = 'global-fallback-secret';
const POLL_SECRET = 'poll-secret';

const silent = createLogger('test', { log() {}, warn() {}, error() {} });

/** Boot a real HTTP server so the test exercises Express, not just the handlers. */
async function startServer({ projectSlug = null } = {}) {
  const db = openDatabase(':memory:');
  const registry = loadRegistry({ configPath: CONFIG_PATH, projectSlug });
  const config = { ...loadConfig({}), pollSecret: POLL_SECRET };
  const app = createApp({ db, registry, config, log: silent });

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));

  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: `Bearer ${POLL_SECRET}`, 'content-type': 'application/json' };

  return {
    db,
    base,
    auth,
    close: () => new Promise((resolve) => server.close(resolve)),

    deliver(fixtureName, { event = 'issues', delivery = 'delivery-1', secret = MAIN_SECRET, mutate } = {}) {
      let body = fixtureBuffer(fixtureName);
      if (mutate) body = Buffer.from(JSON.stringify(mutate(JSON.parse(body.toString('utf8')))), 'utf8');
      return fetch(`${base}/api/agent/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': event,
          'x-github-delivery': delivery,
          'x-hub-signature-256': signBody(body, secret),
        },
        body,
      });
    },
  };
}

before(() => {
  process.env.WEBHOOK_SECRET_MAIN_APP = MAIN_SECRET;
  process.env.WEBHOOK_SECRET_SIDE_PROJECT = SIDE_SECRET;
  process.env.GITHUB_WEBHOOK_SECRET = GLOBAL_SECRET;
});

after(() => {
  delete process.env.WEBHOOK_SECRET_MAIN_APP;
  delete process.env.WEBHOOK_SECRET_SIDE_PROJECT;
  delete process.env.GITHUB_WEBHOOK_SECRET;
});

describe('shared instance', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(() => srv.close());

  test('health reports shared mode and both tenants', async () => {
    const body = await (await fetch(`${srv.base}/api/health`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'shared');
    assert.deepEqual(body.projects, ['main-app', 'side-project']);
  });

  test('a signed delivery is queued', async () => {
    const res = await srv.deliver('issues.labeled.json', { delivery: 'd-queued' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.project_slug, 'main-app');
    assert.equal(body.action, 'agent:assigned');
    assert.equal(body.duplicate, false);
  });

  test('a redelivery is acknowledged without queueing again', async () => {
    const res = await srv.deliver('issues.labeled.json', { delivery: 'd-queued' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).duplicate, true);
  });

  test('control ingest queues without HMAC', async () => {
    const payload = JSON.parse(fixtureBuffer('issues.labeled.json').toString('utf8'));
    payload.label.name = 'agent:execute';
    const res = await fetch(`${srv.base}/api/agent/ingest`, {
      method: 'POST',
      headers: srv.auth,
      body: JSON.stringify({ event: 'issues', payload, delivery_id: 'ingest-execute-1' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.action, 'agent:execute');
    assert.equal(body.duplicate, false);
  });

  test('the per-project secret is required, not the global one', async () => {
    const res = await srv.deliver('issues.labeled.json', { delivery: 'd-global', secret: GLOBAL_SECRET });
    assert.equal(res.status, 401);
  });

  test('a malformed signature header is a 401, never a 500', async () => {
    const body = fixtureBuffer('issues.labeled.json');
    for (const signature of ['garbage', 'sha256=short', '']) {
      const res = await fetch(`${srv.base}/api/agent/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-hub-signature-256': signature },
        body,
      });
      assert.equal(res.status, 401, `signature: ${signature}`);
    }

    const missing = await fetch(`${srv.base}/api/agent/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'issues' },
      body,
    });
    assert.equal(missing.status, 401);
  });

  test('an unregistered repo is acknowledged, not queued', async () => {
    const res = await srv.deliver('issues.labeled.json', {
      delivery: 'd-unknown',
      secret: GLOBAL_SECRET,
      mutate: (payload) => {
        payload.repository.full_name = 'someone-else/random-repo';
        return payload;
      },
    });
    assert.equal(res.status, 202);
    assert.equal((await res.json()).reason, 'unregistered repository');
  });

  test('a non-trigger event is acknowledged so GitHub does not retry', async () => {
    const res = await srv.deliver('issues.labeled.json', {
      delivery: 'd-ignored',
      mutate: (payload) => {
        payload.action = 'edited';
        return payload;
      },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ignored, true);
  });

  test('ping is answered', async () => {
    const res = await srv.deliver('issues.labeled.json', { event: 'ping', delivery: 'd-ping' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).pong, true);
  });

  test('the orchestrator loop: poll, heartbeat, complete', async () => {
    // PLAN.md's orchestrator posts no body at all, so this must work without one.
    const polled = await fetch(`${srv.base}/api/agent/poll`, { method: 'POST', headers: srv.auth });
    const { task } = await polled.json();
    assert.equal(task.project_slug, 'main-app');
    assert.equal(task.status, 'processing');
    assert.equal(task.context.schema_version, 1);
    assert.ok(task.context.references.files.length > 0);

    const beat = await fetch(`${srv.base}/api/agent/tasks/${task.id}/heartbeat`, {
      method: 'POST',
      headers: srv.auth,
      body: JSON.stringify({ lease_seconds: 120 }),
    });
    assert.equal((await beat.json()).ok, true);

    const done = await fetch(`${srv.base}/api/agent/tasks/${task.id}/complete`, {
      method: 'POST',
      headers: srv.auth,
    });
    assert.equal((await done.json()).task.status, 'completed');

    const again = await fetch(`${srv.base}/api/agent/tasks/${task.id}/complete`, {
      method: 'POST',
      headers: srv.auth,
    });
    assert.equal(again.status, 409);
  });

  test('every orchestrator endpoint requires the bearer token', async () => {
    const routes = [
      ['POST', '/api/agent/poll'],
      ['POST', '/api/agent/tasks/whatever/complete'],
      ['POST', '/api/agent/tasks/whatever/fail'],
      ['POST', '/api/agent/tasks/whatever/heartbeat'],
      ['GET', '/api/agent/tasks'],
      ['POST', '/api/agent/ingest'],
    ];
    for (const [method, path] of routes) {
      const res = await fetch(`${srv.base}${path}`, { method });
      assert.equal(res.status, 401, `${method} ${path}`);
      const wrong = await fetch(`${srv.base}${path}`, {
        method,
        headers: { authorization: 'Bearer nope' },
      });
      assert.equal(wrong.status, 401, `${method} ${path} with a wrong token`);
    }
  });

  test('unknown routes return JSON, not an HTML stack page', async () => {
    const res = await fetch(`${srv.base}/api/nope`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /application\/json/);
  });
});

describe('isolated instance (PROJECT_SLUG=side-project)', () => {
  let srv;
  before(async () => {
    srv = await startServer({ projectSlug: 'side-project' });
  });
  after(() => srv.close());

  test('health reports isolated mode with a single tenant', async () => {
    const body = await (await fetch(`${srv.base}/api/health`)).json();
    assert.equal(body.mode, 'isolated');
    assert.equal(body.project_slug, 'side-project');
    assert.deepEqual(body.projects, ['side-project']);
  });

  test('a repo belonging to another project is refused even though it is in the same config', async () => {
    const res = await srv.deliver('issues.labeled.json', { delivery: 'd-other', secret: MAIN_SECRET });
    assert.equal(res.status, 202);
    assert.equal((await res.json()).reason, 'unregistered repository');
  });

  test('its own repo is queued and polling ignores a mismatched slug from the caller', async () => {
    const res = await srv.deliver('issues.labeled.json', {
      delivery: 'd-side',
      secret: SIDE_SECRET,
      mutate: (payload) => {
        payload.repository.full_name = 'personal/side-project';
        return payload;
      },
    });
    assert.equal(res.status, 201);

    const polled = await fetch(`${srv.base}/api/agent/poll`, {
      method: 'POST',
      headers: srv.auth,
      body: JSON.stringify({ project_slug: 'main-app' }),
    });
    const { task } = await polled.json();
    assert.equal(task.project_slug, 'side-project', 'the instance scope wins over the request');
  });
});
