import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer, connect as netConnect } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, describe } from 'node:test';
import { connect as tlsConnect } from 'node:tls';

import { buildProxyRunArgs, proxyUrl, runnerSecrets } from '../orchestrator/cred-proxy-host.mjs';
import { GITHUB_EGRESS_HOSTS } from '../orchestrator/egress.mjs';
import {
  DUMMY_GITHUB_TOKEN,
  GITHUB_MITM_HOSTS,
  authorizationFor,
  createCertificateAuthority,
  createCredentialProxy,
  createGrantRegistry,
  issueLeaf,
  parseProxyAuthorization,
  requestAllowed,
} from '../orchestrator/cred-proxy.mjs';

const TOKEN = 'ghp_real_token_value_0123456789';
const GRANT_A = 'a'.repeat(64);
const GRANT_B = 'b'.repeat(64);
const ADMIN = 'c'.repeat(64);

describe('github request policy', () => {
  const scope = { owner: 'Acme', repo: 'widgets' };

  test('the mitm host list is the egress GitHub list', () => {
    assert.deepEqual([...GITHUB_MITM_HOSTS], [...GITHUB_EGRESS_HOSTS]);
  });

  test('a grant for one repo cannot name another, and client auth is not kept', () => {
    assert.equal(requestAllowed('api.github.com', '/repos/Acme/widgets/issues', scope, 'GET'), true);
    assert.equal(requestAllowed('api.github.com', '/repos/Acme/other/issues', scope, 'GET'), false);
    assert.equal(requestAllowed('api.github.com', '/repos/Acme/widgets-evil', scope, 'GET'), false);
    assert.equal(requestAllowed('api.github.com', '/user/repos', scope, 'GET'), false);
    assert.equal(requestAllowed('api.github.com', '/graphql', scope, 'POST'), false);
    assert.equal(requestAllowed('api.github.com', '/', scope, 'GET'), true);
    assert.equal(requestAllowed('api.github.com', '/user', scope, 'GET'), true);
    assert.equal(requestAllowed('api.github.com', '/user', scope, 'POST'), false);
    assert.equal(
      requestAllowed('api.github.com', '/search/issues?q=repo:Acme/widgets+is:open', scope, 'GET'),
      true
    );
    assert.equal(
      requestAllowed('api.github.com', '/search/issues?q=repo:Acme/other', scope, 'GET'),
      false
    );
    assert.equal(requestAllowed('api.github.com', '/search/issues?q=is:open', scope, 'GET'), false);
    assert.equal(requestAllowed('github.com', '/Acme/widgets.git/info/refs?service=git-upload-pack', scope), true);
    assert.equal(requestAllowed('github.com', '/Other/widgets.git/info/refs', scope), false);
    assert.equal(requestAllowed('codeload.github.com', '/Acme/widgets/tar.gz/main', scope), true);
    assert.equal(
      requestAllowed('objects.githubusercontent.com', '/release/Acme/widgets/asset', scope),
      true
    );
    assert.equal(requestAllowed('objects.githubusercontent.com', '/release/Other/widgets/asset', scope), false);
    assert.equal(authorizationFor('api.github.com', TOKEN).startsWith('Bearer '), true);
    assert.equal(authorizationFor('github.com', TOKEN).startsWith('Basic '), true);
    assert.equal(parseProxyAuthorization(`Bearer ${GRANT_A}`), GRANT_A);
    assert.equal(
      parseProxyAuthorization(`Basic ${Buffer.from(`tmt:${GRANT_A}`).toString('base64')}`),
      GRANT_A
    );
    assert.equal(parseProxyAuthorization('Bearer nope'), null);
  });
});

describe('credential proxy', { concurrency: 1 }, () => {
  /** @type {string} */
  let root;
  /** @type {Awaited<ReturnType<createCredentialProxy>>} */
  let proxy;
  /** @type {{ port: number, close: () => Promise<void> }} */
  let upstream;
  const seen = [];

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'tmt-cred-proxy-'));
    const upstreamCa = createCertificateAuthority(join(root, 'upstream-ca'));
    const leaf = issueLeaf(upstreamCa, 'api.github.com', {
      altNames: ['api.github.com', 'github.com', 'codeload.github.com'],
    });
    const requests = [];
    const server = createHttpsServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const record = {
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization || '',
          body,
        };
        requests.push(record);
        seen.push(record);
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      });
    });
    await listen(server);
    upstream = {
      port: server.address().port,
      requests,
      close: () => closeServer(server),
    };
    proxy = await createCredentialProxy({
      token: TOKEN,
      adminSecret: ADMIN,
      caDir: join(root, 'ca'),
      dial: (host) => ({
        hostname: '127.0.0.1',
        port: upstream.port,
        servername: host,
        ca: upstreamCa.certPem,
      }),
      connectTunnel: () => {
        throw new Error('github traffic must not be blind-tunneled');
      },
    });
    await adminJson(proxy, 'POST', '/grants', { grant: GRANT_A, owner: 'Acme', repo: 'widgets' });
  });

  test('a request without a grant is rejected and never reaches upstream', async () => {
    const before = seen.length;
    await assert.rejects(connectRequest({ proxy, host: 'api.github.com', path: '/user' }), /407/);
    assert.equal(seen.length, before);
  });

  test('a grant for repo A cannot fetch repo B, and the client never sees the token', async () => {
    const before = seen.length;
    const denied = await connectRequest({
      proxy,
      grant: GRANT_A,
      host: 'api.github.com',
      path: '/repos/Acme/other',
      headers: { authorization: 'Bearer client-sent-secret' },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body, 'rejected');
    assert.equal(denied.body.includes(TOKEN), false);
    assert.equal(seen.length, before);

    const allowed = await connectRequest({
      proxy,
      grant: GRANT_A,
      host: 'api.github.com',
      method: 'POST',
      path: '/repos/Acme/widgets/issues',
      headers: { authorization: 'Bearer client-sent-secret', 'content-type': 'text/plain' },
      body: 'pack-bytes',
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.includes(TOKEN), false);
    const hit = seen.at(-1);
    assert.equal(hit.authorization, `Bearer ${TOKEN}`);
    assert.equal(hit.authorization.includes('client-sent-secret'), false);
    assert.equal(hit.body.toString(), 'pack-bytes');
    assert.equal(hit.url, '/repos/Acme/widgets/issues');
  });

  test('git hosts get basic auth, and a second request on the same connection is streamed', async () => {
    const body = Buffer.alloc(64 * 1024, 7);
    const session = await openSession({ proxy, grant: GRANT_A, host: 'github.com' });
    try {
      const first = await session.request({ path: '/Acme/widgets.git/info/refs?service=git-upload-pack' });
      assert.equal(first.status, 200);
      const second = await session.request({
        method: 'POST',
        path: '/Acme/widgets.git/git-receive-pack',
        headers: { 'content-type': 'application/x-git-receive-pack-request' },
        body,
      });
      assert.equal(second.status, 200);
    } finally {
      session.close();
    }
    const packed = seen.at(-1);
    assert.ok(packed.authorization.startsWith('Basic '));
    assert.equal(Buffer.from(packed.authorization.slice(6), 'base64').toString(), `x-access-token:${TOKEN}`);
    assert.equal(packed.body.length, body.length);
    assert.ok(packed.body.equals(body));
  });

  test('an unknown grant and a revoked grant are both rejected', async () => {
    await adminJson(proxy, 'POST', '/grants', { grant: GRANT_B, owner: 'Acme', repo: 'widgets' });
    await adminJson(proxy, 'DELETE', `/grants/${GRANT_B}`);
    await assert.rejects(
      connectRequest({ proxy, grant: GRANT_B, host: 'api.github.com', path: '/user' }),
      /407/
    );
  });

  after(async () => {
    await proxy?.close();
    await upstream?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });
});

describe('blind tunnel', () => {
  test('a non-github host is not terminated and does not see the token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tmt-cred-tunnel-'));
    const received = [];
    const echo = createNetServer((socket) => {
      socket.on('data', (chunk) => received.push(chunk.toString()));
    });
    const connected = once(echo, 'connection');
    await listen(echo);
    const proxy = await createCredentialProxy({
      token: TOKEN,
      adminSecret: ADMIN,
      caDir: join(root, 'ca'),
      connectTunnel: (host, port) => {
        assert.equal(host, 'registry.npmjs.org');
        assert.equal(port, 443);
        return netConnect(echo.address().port, '127.0.0.1');
      },
    });
    await adminJson(proxy, 'POST', '/grants', { grant: GRANT_A, owner: 'Acme', repo: 'widgets' });
    const socket = netConnect(proxy.proxyPort, '127.0.0.1');
    const auth = Buffer.from(`tmt:${GRANT_A}`).toString('base64');
    socket.write(
      `CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`
    );
    const status = await readHeader(socket);
    assert.match(status, /^HTTP\/1\.1 200/);
    await connected;
    socket.write('GET /pkg HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n');
    const deadline = Date.now() + 1000;
    while (received.join('').includes('GET /pkg') === false && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const text = received.join('');
    assert.match(text, /GET \/pkg/);
    assert.equal(text.includes(TOKEN), false);
    socket.destroy();
    await proxy.close();
    await closeServer(echo);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('runner credential wiring', () => {
  test('the entrypoint does not embed a GitHub token, and the rendered config has only the dummy', async () => {
    const entry = readFileSync(new URL('../docker/agent-entrypoint.sh', import.meta.url), 'utf8');
    assert.equal(entry.includes('password=${GITHUB_TOKEN}'), false);
    assert.equal(entry.includes('GITHUB_PERSONAL_ACCESS_TOKEN="${GITHUB_TOKEN}"'), false);
    assert.ok(entry.includes(DUMMY_GITHUB_TOKEN));
    assert.match(entry, /http\.sslCAInfo/);
    assert.match(entry, /NODE_EXTRA_CA_CERTS/);
    assert.match(entry, /SSL_CERT_FILE/);
    assert.match(entry, /unset GITHUB_TOKEN/);

    const root = mkdtempSync(join(tmpdir(), 'tmt-entrypoint-'));
    const home = join(root, 'home');
    mkdirSync(join(root, 'run/secrets'), { recursive: true });
    mkdirSync(join(root, 'task'), { recursive: true });
    mkdirSync(join(root, 'out'), { recursive: true });
    mkdirSync(join(root, 'etc/ssl/tmt'), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(root, 'etc/ssl/tmt/ca.crt'), 'test-ca\n');
    writeFileSync(join(root, 'task/prompt.md'), 'hello\n');
    const real = 'ghp_should_not_appear_in_runner';
    writeFileSync(
      join(root, 'run/secrets/env'),
      [
        `GITHUB_TOKEN='${real}'`,
        "CURSOR_API_KEY='cursor-test'",
        "https_proxy='http://tmt:grant@172.28.0.2:3128'",
        "http_proxy='http://tmt:grant@172.28.0.2:3128'",
        "HTTPS_PROXY='http://tmt:grant@172.28.0.2:3128'",
        "HTTP_PROXY='http://tmt:grant@172.28.0.2:3128'",
        "no_proxy='registry.npmjs.org'",
        "NO_PROXY='registry.npmjs.org'",
        "GITHUB_TOOLSETS='repos'",
        '',
      ].join('\n')
    );

    const child = spawn('bash', [new URL('../docker/agent-entrypoint.sh', import.meta.url).pathname], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMT_FS_PREFIX: root,
        TMT_ENTRYPOINT_STOP: 'config',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, stderr);

    const gitconfig = readFileSync(join(home, '.gitconfig'), 'utf8');
    const mcp = readFileSync(join(home, '.cursor/mcp.json'), 'utf8');
    assert.equal(gitconfig.includes(real), false);
    assert.equal(gitconfig.includes(TOKEN), false);
    assert.match(gitconfig, /sslCAInfo/);
    assert.match(gitconfig, /172\.28\.0\.2:3128/);
    assert.equal(mcp.includes(real), false);
    assert.equal(mcp.includes(DUMMY_GITHUB_TOKEN), true);
    assert.match(mcp, /SSL_CERT_FILE/);
    const env = JSON.parse(mcp).mcpServers.github.env;
    assert.equal(env.GITHUB_PERSONAL_ACCESS_TOKEN, DUMMY_GITHUB_TOKEN);
    assert.equal(Object.values(env).includes(real), false);
    rmSync(root, { recursive: true, force: true });
  });

  test('runner secrets and the proxy container argv do not carry the GitHub token', () => {
    const grant = 'd'.repeat(64);
    const secrets = runnerSecrets({
      cursorApiKey: 'cursor-test',
      proxyUrl: proxyUrl({ host: '172.28.0.2', grant }),
      noProxy: 'registry.npmjs.org',
    });
    assert.equal(Object.hasOwn(secrets, 'GITHUB_TOKEN'), false);
    assert.equal(secrets.https_proxy.includes(TOKEN), false);
    assert.match(secrets.https_proxy, new RegExp(`tmt:${grant}@172\\.28\\.0\\.2:3128`));
    const argv = buildProxyRunArgs({
      image: 'tmt-agent-runner',
      network: 'tmt-agent-runners',
      sidecarIp: '172.28.0.2',
      tokenFile: '/Users/me/.tmt-agent/cred-proxy/github_token',
      adminFile: '/Users/me/.tmt-agent/cred-proxy/admin',
      caDir: '/Users/me/.tmt-agent/cred-proxy',
    }).join(' ');
    assert.equal(argv.includes(TOKEN), false);
    assert.match(argv, /--ip 172\.28\.0\.2/);
    assert.match(argv, /-p 127\.0\.0\.1:3129:3129/);
    const index = readFileSync(new URL('../orchestrator/index.mjs', import.meta.url), 'utf8');
    assert.equal(index.includes('GITHUB_TOKEN: config.secrets.GITHUB_TOKEN'), false);
  });
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function closeServer(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function adminJson(proxy, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${proxy.adminPort}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`admin ${method} ${path} -> ${res.status}`);
}

async function connectRequest({ proxy, grant, host, method = 'GET', path, headers = {}, body }) {
  const session = await openSession({ proxy, grant, host });
  try {
    return await session.request({ method, path, headers, body });
  } finally {
    session.close();
  }
}

async function openSession({ proxy, grant, host }) {
  const socket = netConnect(proxy.proxyPort, '127.0.0.1');
  const lines = [`CONNECT ${host}:443 HTTP/1.1`, `Host: ${host}:443`];
  if (grant) lines.push(`Proxy-Authorization: Bearer ${grant}`);
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  const status = await readHeader(socket);
  if (!status.startsWith('HTTP/1.1 200')) {
    socket.destroy();
    throw new Error(status.split('\r\n')[0]);
  }
  const tlsSocket = tlsConnect({
    socket,
    servername: host,
    ca: readFileSync(proxy.caCertPath),
    ALPNProtocols: ['http/1.1'],
  });
  await once(tlsSocket, 'secure');
  return {
    close: () => tlsSocket.destroy(),
    request({ method = 'GET', path, headers = {}, body }) {
      const pending = readHttpResponse(tlsSocket);
      writeHttpRequest(tlsSocket, { method, path, headers: { host, ...headers }, body });
      return pending;
    },
  };
}

function writeHttpRequest(socket, { method, path, headers, body }) {
  const payload = body == null ? Buffer.alloc(0) : Buffer.from(body);
  const lines = [`${method} ${path} HTTP/1.1`, 'connection: keep-alive'];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  if (payload.length) lines.push(`content-length: ${payload.length}`);
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  if (payload.length) socket.write(payload);
}

function readHttpResponse(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for a proxied response')), 3000);
    let buf = Buffer.alloc(0);
    const finish = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = buf.slice(0, idx).toString('utf8');
      const status = Number(/^HTTP\/1\.[01] (\d+)/.exec(head)?.[1]);
      const len = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] || 0);
      if (buf.length < idx + 4 + len) return;
      socket.off('data', onData);
      const extra = buf.slice(idx + 4 + len);
      if (extra.length) socket.unshift(extra);
      finish({ status, body: buf.slice(idx + 4, idx + 4 + len).toString('utf8') });
    };
    socket.on('data', onData);
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function readHeader(socket) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      socket.off('data', onData);
      const rest = buf.slice(idx + 4);
      if (rest.length) socket.unshift(rest);
      resolve(buf.slice(0, idx).toString('utf8'));
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}
