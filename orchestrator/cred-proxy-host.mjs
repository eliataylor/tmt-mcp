import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ADMIN_PORT, PROXY_CONTAINER, PROXY_PORT } from './cred-proxy.mjs';
import { parseRunnerNetwork, sidecarIpFromGateway } from './egress.mjs';
import { run } from './exec.mjs';

export { DUMMY_GITHUB_TOKEN, PROXY_CONTAINER, PROXY_PORT, ADMIN_PORT } from './cred-proxy.mjs';

const IPV4 =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Proxy URL whose userinfo is the per-task grant. Git and Go send that as Proxy-Authorization. */
export function proxyUrl({ host, port = PROXY_PORT, grant }) {
  if (!/^[a-f0-9]{64}$/.test(grant || '')) throw new Error('grant must be 64 hex characters');
  if (!IPV4.test(host || '')) throw new Error('proxy host must be an IPv4 address');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('proxy port is invalid');
  return `http://tmt:${grant}@${host}:${port}`;
}

/**
 * What the runner's secrets file is allowed to contain. There is no GitHub token key: the proxy
 * holds that, and the grant in the proxy URL is useless off the runner network.
 */
export function runnerSecrets({ cursorApiKey, proxyUrl: url, noProxy, posthogEnv = {} }) {
  return {
    CURSOR_API_KEY: cursorApiKey,
    https_proxy: url,
    http_proxy: url,
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    no_proxy: noProxy,
    NO_PROXY: noProxy,
    ...posthogEnv,
  };
}

export function buildProxyRunArgs({
  image,
  network,
  sidecarIp,
  tokenFile,
  adminFile,
  caDir,
  adminPort = ADMIN_PORT,
}) {
  return [
    'run',
    '--detach',
    '--name',
    PROXY_CONTAINER,
    '--network',
    network,
    '--ip',
    sidecarIp,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,size=64m',
    '--volume',
    `${caDir}:/var/lib/tmt-cred-proxy`,
    '--volume',
    `${tokenFile}:/run/secrets/github_token:ro`,
    '--volume',
    `${adminFile}:/run/secrets/admin:ro`,
    '--env',
    'TMT_CA_DIR=/var/lib/tmt-cred-proxy',
    '--env',
    'TMT_TOKEN_FILE=/run/secrets/github_token',
    '--env',
    'TMT_ADMIN_FILE=/run/secrets/admin',
    '-p',
    `127.0.0.1:${adminPort}:${adminPort}`,
    '--entrypoint',
    'node',
    image,
    '/usr/local/lib/tmt/cred-proxy.mjs',
  ];
}

export async function registerGrant({ adminPort, adminSecret, grant, owner, repo }) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${adminPort}/grants`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ grant, owner, repo }),
    });
  } catch {
    throw new Error('credential proxy did not accept the grant');
  }
  if (!res.ok) throw new Error(`credential proxy refused the grant (${res.status})`);
}

export async function revokeGrant({ adminPort, adminSecret, grant }) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${adminPort}/grants/${grant}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${adminSecret}` },
    });
  } catch {
    throw new Error('credential proxy did not revoke the grant');
  }
  if (!res.ok && res.status !== 404) {
    throw new Error(`credential proxy refused to revoke the grant (${res.status})`);
  }
}

/**
 * One long-lived sidecar on the runner network. It is the only container that mounts the token.
 * Recreated at boot so a rebuilt image and a rotated token file are what the next task uses.
 * Grants live in the proxy's memory and are registered per task.
 */
export async function ensureCredentialProxy({
  docker,
  image,
  network,
  token,
  workdir,
  dryRun = false,
  logger = console,
}) {
  const dir = join(workdir, 'cred-proxy');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tokenFile = join(dir, 'github_token');
  const adminFile = join(dir, 'admin');
  const caCert = join(dir, 'ca.crt');
  if (!token) throw new Error('GITHUB_TOKEN is required to start the credential proxy');
  writeFileSync(tokenFile, `${String(token).trim()}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);

  let adminSecret = existsSync(adminFile) ? readFileSync(adminFile, 'utf8').trim() : '';
  if (!/^[a-f0-9]{64}$/.test(adminSecret)) {
    adminSecret = randomBytes(32).toString('hex');
    writeFileSync(adminFile, `${adminSecret}\n`, { mode: 0o600 });
  }
  chmodSync(adminFile, 0o600);

  if (dryRun) {
    logger.log('[DryRun] credential proxy not started');
    return {
      sidecarIp: null,
      adminSecret: null,
      adminPort: ADMIN_PORT,
      proxyPort: PROXY_PORT,
      caCert,
    };
  }

  const { stdout } = await run('docker', ['network', 'inspect', network]);
  const parsed = parseRunnerNetwork(JSON.parse(stdout));
  const sidecarIp = sidecarIpFromGateway(parsed.gateway, parsed.subnet);
  await docker.remove(PROXY_CONTAINER);
  logger.log(`[Docker] starting credential proxy at ${sidecarIp}`);
  await docker.start(
    buildProxyRunArgs({
      image,
      network,
      sidecarIp,
      tokenFile,
      adminFile,
      caDir: dir,
    })
  );
  try {
    await waitForProxy({ adminPort: ADMIN_PORT, adminSecret, caCert });
  } catch (err) {
    const logs = await run('docker', ['logs', '--tail', '20', PROXY_CONTAINER], { allowFailure: true });
    const tail = `${logs.stderr || ''}${logs.stdout || ''}`.trim().split('\n').slice(-3).join(' ');
    throw new Error(`${err.message}${tail ? ` (${tail})` : ''}`);
  }
  return { sidecarIp, adminSecret, adminPort: ADMIN_PORT, proxyPort: PROXY_PORT, caCert };
}

async function waitForProxy({ adminPort, adminSecret, caCert, timeoutMs = 20000 }) {
  const deadline = Date.now() + timeoutMs;
  let last = 'not up';
  while (Date.now() < deadline) {
    try {
      if (!existsSync(caCert)) throw new Error('ca not written');
      const res = await fetch(`http://127.0.0.1:${adminPort}/health`, {
        headers: { authorization: `Bearer ${adminSecret}` },
      });
      if (res.ok) return;
      last = `health ${res.status}`;
    } catch (err) {
      last = err.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `credential proxy did not become ready (${last}). Rebuild the runner image so it contains the proxy (npm run runner:build).`
  );
}
