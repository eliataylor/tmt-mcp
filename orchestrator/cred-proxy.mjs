import { execFileSync } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createSecureContext, TLSSocket } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * HTTP proxy that holds the GitHub token.
 *
 * GitHub hosts are terminated with a certificate signed by a local CA so the proxy can inject
 * Authorization. Every other host is a blind CONNECT tunnel. The token is never written to a
 * response, a log line, or an error string.
 *
 * Runners authenticate with a per-task grant (Proxy-Authorization: Bearer, or Basic userinfo in
 * the proxy URL). The grant names one owner/repo, and only that repo's requests receive the token.
 * A public GET or HEAD to a GitHub host is forwarded with no Authorization, so a dependency
 * install can download a release without a grant and without the token. Anything else outside
 * the repo is rejected. A missing grant is not a tunnel to the rest of the internet.
 */

export const GITHUB_MITM_HOSTS = [
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
];

export const PROXY_PORT = 3128;
export const ADMIN_PORT = 3129;
export const PROXY_CONTAINER = 'tmt-cred-proxy';
export const DUMMY_GITHUB_TOKEN = 'tmt-dummy-github-token';

const MITM = new Set(GITHUB_MITM_HOSTS);
const GRANT = /^[a-f0-9]{64}$/;
const REPO_PART = /^[A-Za-z0-9._-]{1,100}$/;
const HOSTNAME = /^[a-z0-9.-]+$/;

const HOP_BY_HOP = [
  'authorization',
  'proxy-authorization',
  'proxy-connection',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'expect',
];

export function createGrantRegistry() {
  const grants = new Map();
  return {
    put(grant, scope) {
      if (!GRANT.test(grant || '')) throw new Error('grant must be 64 hex characters');
      if (!REPO_PART.test(scope?.owner || '') || !REPO_PART.test(scope?.repo || '')) {
        throw new Error('grant scope is not an owner/repo');
      }
      grants.set(grant, { owner: scope.owner, repo: scope.repo });
    },
    delete(grant) {
      grants.delete(grant);
    },
    get(grant) {
      if (!GRANT.test(grant || '')) return null;
      return grants.get(grant) || null;
    },
  };
}

/** Bearer grant, or the password half of Basic userinfo (git and Go send the proxy URL that way). */
export function parseProxyAuthorization(header) {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || typeof value !== 'string') return null;
  const bearer = /^Bearer\s+([a-f0-9]{64})$/i.exec(value.trim());
  if (bearer) return bearer[1];
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(value.trim());
  if (!basic) return null;
  const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep === -1) return null;
  const grant = decoded.slice(sep + 1);
  return GRANT.test(grant) ? grant : null;
}

export function authorizationFor(host, token) {
  if (host === 'api.github.com') return `Bearer ${token}`;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return `Basic ${basic}`;
}

/**
 * True when this request stays inside the grant's repo.
 * api.github.com also allows the two reads the MCP server makes before it knows the repo
 * (`GET /` and `GET /user`). Search is allowed only when every `repo:` qualifier is this repo.
 */
export function requestAllowed(host, rawUrl, scope, method = 'GET') {
  if (!scope || !MITM.has(host)) return false;
  let url;
  try {
    url = new URL(rawUrl, `https://${host}`);
  } catch {
    return false;
  }
  if (String(rawUrl).includes('..') || url.pathname.includes('..')) return false;
  const owner = String(scope.owner).toLowerCase();
  const repo = String(scope.repo).toLowerCase();
  if (host === 'api.github.com') return apiAllowed(url, owner, repo, method.toUpperCase());
  if (host === 'github.com' || host === 'codeload.github.com') {
    return startsWithRepo(url.pathname, owner, repo);
  }
  return containsRepo(url.pathname, owner, repo);
}

function apiAllowed(url, owner, repo, method) {
  const path = url.pathname.toLowerCase();
  if (path === '/graphql' || path.startsWith('/graphql/')) return false;
  if (method === 'GET' && (path === '/' || path === '/user')) return true;
  if (path === '/search/issues' || path === '/search/code') {
    return searchScoped(url.searchParams.get('q') || '', owner, repo);
  }
  return prefixPath(path, `/repos/${owner}/${repo}`);
}

function searchScoped(query, owner, repo) {
  const want = `${owner}/${repo}`;
  const found = [];
  for (const match of query.toLowerCase().matchAll(/(?:^|\s)repo:(\S+)/g)) found.push(match[1]);
  return found.length > 0 && found.every((name) => name === want);
}

function startsWithRepo(pathname, owner, repo) {
  const path = pathname.toLowerCase();
  const base = `/${owner}/${repo}`;
  if (path === base || path.startsWith(`${base}/`)) return true;
  if (!path.startsWith(`${base}.git`)) return false;
  const rest = path.slice(base.length + 4);
  return rest === '' || rest.startsWith('/');
}

function prefixPath(path, base) {
  return path === base || path.startsWith(`${base}/`);
}

function containsRepo(pathname, owner, repo) {
  const path = pathname.toLowerCase();
  const needle = `/${owner}/${repo}`;
  let from = 0;
  while (from < path.length) {
    const at = path.indexOf(needle, from);
    if (at === -1) return false;
    const next = path[at + needle.length];
    if (next === undefined || next === '/' || next === '.') return true;
    from = at + 1;
  }
  return false;
}

export function createCertificateAuthority(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = join(dir, 'ca.key');
  const certPath = join(dir, 'ca.crt');
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '825',
        '-nodes',
        '-subj',
        '/CN=tmt-cred-proxy',
      ],
      { stdio: 'pipe' }
    );
  }
  chmodSync(keyPath, 0o600);
  chmodSync(certPath, 0o644);
  return { dir, keyPath, certPath, certPem: readFileSync(certPath, 'utf8') };
}

/** Leaf signed by `ca`. `altNames` defaults to `host`. Cached by the caller. */
export function issueLeaf(ca, host, { altNames = [host] } = {}) {
  if (!HOSTNAME.test(host) || altNames.some((name) => !HOSTNAME.test(name))) {
    throw new Error('refusing to mint a certificate for this host');
  }
  const dir = mkdtempSync(join(tmpdir(), 'tmt-leaf-'));
  const id = host;
  const keyPath = join(dir, `${id}.key`);
  const csrPath = join(dir, `${id}.csr`);
  const certPath = join(dir, `${id}.crt`);
  const extPath = join(dir, `${id}.ext`);
  const san = altNames.map((name) => `DNS:${name}`).join(',');
  writeFileSync(
    extPath,
    `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
    { mode: 0o600 }
  );
  execFileSync(
    'openssl',
    ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', csrPath, '-subj', `/CN=${host}`],
    { stdio: 'pipe' }
  );
  execFileSync(
    'openssl',
    [
      'x509',
      '-req',
      '-in',
      csrPath,
      '-CA',
      ca.certPath,
      '-CAkey',
      ca.keyPath,
      '-CAcreateserial',
      '-out',
      certPath,
      '-days',
      '30',
      '-extfile',
      extPath,
    ],
    { stdio: 'pipe' }
  );
  chmodSync(keyPath, 0o600);
  const key = readFileSync(keyPath);
  const cert = readFileSync(certPath);
  return { key, cert, context: createSecureContext({ key, cert }) };
}

function leafContext(ca, host, cache) {
  const existing = cache.get(host);
  if (existing) return existing;
  const issued = issueLeaf(ca, host);
  cache.set(host, issued.context);
  return issued.context;
}

function rejectConnect(socket, statusLine) {
  if (!socket.writable) return;
  socket.end(`HTTP/1.1 ${statusLine}\r\nContent-Type: text/plain\r\nContent-Length: 8\r\nConnection: close\r\n\r\nrejected`);
}

function parseConnectTarget(raw) {
  const value = String(raw || '');
  const colon = value.lastIndexOf(':');
  if (colon <= 0) return null;
  const host = value.slice(0, colon).toLowerCase();
  const port = Number(value.slice(colon + 1));
  if (!HOSTNAME.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

function secretsEqual(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function adminBearer(header) {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer\s+(\S+)$/.exec(value || '');
  return match ? match[1] : '';
}

/**
 * @param {object} options
 * @param {string | (() => string)} options.token GitHub token, or a reader (the file is re-read per request)
 * @param {string | (() => string)} options.adminSecret
 * @param {ReturnType<createGrantRegistry>} [options.registry]
 * @param {string} options.caDir
 * @param {number} [options.proxyPort]
 * @param {number} [options.adminPort]
 * @param {string} [options.listenHost]
 * @param {(host: string) => { hostname: string, port: number, servername?: string, ca?: string }} [options.dial]
 * @param {(host: string, port: number) => import('node:net').Socket} [options.connectTunnel]
 */
export async function createCredentialProxy({
  token,
  adminSecret,
  registry = createGrantRegistry(),
  caDir,
  proxyPort = 0,
  adminPort = 0,
  listenHost = '127.0.0.1',
  dial = (host) => ({ hostname: host, port: 443, servername: host }),
  connectTunnel,
}) {
  const readToken = typeof token === 'function' ? token : () => token;
  const readAdmin = typeof adminSecret === 'function' ? adminSecret : () => adminSecret;
  const ca = createCertificateAuthority(caDir);
  const leafs = new Map();
  const inners = new Set();
  const openTunnel = connectTunnel || ((host, port) => netConnect(port, host));

  const proxy = createHttpServer((_req, res) => {
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('rejected');
  });
  proxy.timeout = 0;
  proxy.requestTimeout = 0;
  proxy.headersTimeout = 0;
  proxy.on('clientError', (_err, socket) => {
    socket.destroy();
  });

  proxy.on('connect', (req, clientSocket, head) => {
    const grant = parseProxyAuthorization(req.headers['proxy-authorization']);
    const scope = grant ? registry.get(grant) : null;
    const target = parseConnectTarget(req.url);
    if (!target) {
      rejectConnect(clientSocket, '400 Bad Request');
      return;
    }
    if (MITM.has(target.host)) {
      if (target.port !== 443) {
        rejectConnect(clientSocket, '403 Forbidden');
        return;
      }
      // An unknown grant is rejected. No grant at all still terminates GitHub, so a public
      // download is inspected and the token is never attached. It is not a blind tunnel.
      if (grant && !scope) {
        rejectConnect(clientSocket, '407 Proxy Authentication Required');
        return;
      }
      intercept(clientSocket, head, target.host, scope, { ca, leafs, readToken, dial, inners });
      return;
    }
    if (!scope) {
      rejectConnect(clientSocket, '407 Proxy Authentication Required');
      return;
    }
    tunnel(clientSocket, head, target.host, target.port, openTunnel);
  });

  const admin = createHttpServer((req, res) => handleAdmin(req, res, { registry, readAdmin }));
  admin.timeout = 30_000;
  admin.on('clientError', (_err, socket) => socket.destroy());

  await listen(proxy, proxyPort, listenHost);
  await listen(admin, adminPort, listenHost);

  return {
    proxyPort: proxy.address().port,
    adminPort: admin.address().port,
    caCertPath: ca.certPath,
    caCertPem: ca.certPem,
    registry,
    async close() {
      for (const inner of inners) {
        inner.closeAllConnections?.();
        inner.close();
      }
      proxy.closeAllConnections?.();
      admin.closeAllConnections?.();
      await Promise.race([
        Promise.all([closed(proxy), closed(admin)]),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    },
  };
}

function intercept(clientSocket, head, host, scope, ctx) {
  if (head?.length) clientSocket.unshift(head);
  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  let secureContext;
  try {
    secureContext = leafContext(ctx.ca, host, ctx.leafs);
  } catch {
    clientSocket.destroy();
    return;
  }
  const tlsSocket = new TLSSocket(clientSocket, {
    isServer: true,
    secureContext,
    ALPNProtocols: ['http/1.1'],
  });
  const inner = createHttpServer((req, res) => forward(req, res, host, scope, ctx));
  ctx.inners.add(inner);
  inner.timeout = 0;
  inner.requestTimeout = 0;
  inner.headersTimeout = 60_000;
  inner.keepAliveTimeout = 120_000;
  inner.on('clientError', (_err, socket) => socket.destroy());
  tlsSocket.once('secure', () => {
    inner.emit('connection', tlsSocket);
  });
  tlsSocket.on('error', () => clientSocket.destroy());
  const done = () => {
    ctx.inners.delete(inner);
    inner.close();
  };
  tlsSocket.on('close', done);
  clientSocket.on('error', () => tlsSocket.destroy());
}

function forward(req, res, host, scope, ctx) {
  const method = String(req.method || 'GET').toUpperCase();
  const allowed = Boolean(scope) && requestAllowed(host, req.url, scope, method);
  // Public release downloads (and the signed CDN URL they redirect to) are GET/HEAD and must
  // not carry the token. Writes outside the granted repo stay rejected.
  const anonymous = !allowed && (method === 'GET' || method === 'HEAD');
  if (!allowed && !anonymous) {
    req.resume();
    endPlain(res, 403);
    return;
  }

  const headers = { ...req.headers };
  for (const name of HOP_BY_HOP) delete headers[name];
  headers.host = host;
  if (allowed) {
    let token;
    try {
      token = ctx.readToken();
      if (!token || typeof token !== 'string') throw new Error('empty');
    } catch {
      req.resume();
      endPlain(res, 502);
      return;
    }
    headers.authorization = authorizationFor(host, token);
  }

  const dialed = ctx.dial(host);
  const upstream = httpsRequest(
    {
      method: req.method,
      hostname: dialed.hostname,
      port: dialed.port,
      servername: dialed.servername || host,
      ca: dialed.ca,
      path: req.url,
      headers,
      ALPNProtocols: ['http/1.1'],
      timeout: 0,
    },
    (upRes) => {
      const responseHeaders = { ...upRes.headers };
      delete responseHeaders.authorization;
      res.writeHead(upRes.statusCode || 502, responseHeaders);
      upRes.pipe(res);
    }
  );
  upstream.on('error', () => {
    if (!res.headersSent) endPlain(res, 502);
    else res.end();
  });
  req.pipe(upstream);
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy();
  });
}

function endPlain(res, status) {
  const body = 'rejected';
  res.writeHead(status, {
    'content-type': 'text/plain',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function tunnel(clientSocket, head, host, port, openTunnel) {
  let upstream;
  try {
    upstream = openTunnel(host, port);
  } catch {
    rejectConnect(clientSocket, '502 Bad Gateway');
    return;
  }
  let started = false;
  const fail = () => {
    if (!started) rejectConnect(clientSocket, '502 Bad Gateway');
    else clientSocket.destroy();
    upstream.destroy();
  };
  const start = () => {
    if (started) return;
    started = true;
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  };
  upstream.on('error', fail);
  clientSocket.on('error', () => upstream.destroy());
  upstream.once('connect', start);
  // net.connect emits connect on a later turn. A socket handed to us already open does not.
  if (upstream.readyState === 'open') start();
}

function handleAdmin(req, res, { registry, readAdmin }) {
  let expected = '';
  try {
    expected = readAdmin();
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('rejected');
    return;
  }
  if (!secretsEqual(adminBearer(req.headers.authorization), expected)) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('rejected');
    return;
  }
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (req.method === 'POST' && url.pathname === '/grants') {
    readBody(req)
      .then((body) => {
        const parsed = JSON.parse(body || '{}');
        registry.put(parsed.grant, { owner: parsed.owner, repo: parsed.repo });
        res.writeHead(204);
        res.end();
      })
      .catch(() => {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('rejected');
      });
    return;
  }
  const removal = /^\/grants\/([a-f0-9]{64})$/.exec(url.pathname);
  if (req.method === 'DELETE' && removal) {
    registry.delete(removal[1]);
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('rejected');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4096) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closed(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function main() {
  const tokenPath = process.env.TMT_TOKEN_FILE || '/run/secrets/github_token';
  const adminPath = process.env.TMT_ADMIN_FILE || '/run/secrets/admin';
  const caDir = process.env.TMT_CA_DIR || '/var/lib/tmt-cred-proxy';
  const proxyPort = Number(process.env.TMT_PROXY_PORT || PROXY_PORT);
  const adminPort = Number(process.env.TMT_ADMIN_PORT || ADMIN_PORT);
  const readFileSecret = (path) => () => readFileSync(path, 'utf8').trim();
  await createCredentialProxy({
    token: readFileSecret(tokenPath),
    adminSecret: readFileSecret(adminPath),
    caDir,
    proxyPort,
    adminPort,
    listenHost: '0.0.0.0',
  });
  process.stdout.write(`[cred-proxy] listening proxy=${proxyPort} admin=${adminPort}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('[cred-proxy] failed to start\n');
    process.exit(1);
  });
}
