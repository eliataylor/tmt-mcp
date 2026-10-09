import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  allowlistHosts,
  directNoProxy,
  gatewayFromSubnet,
  githubSidecarDestinations,
  GITHUB_SIDECAR_FALLBACK,
  parseRunnerNetwork,
  renderEgressScript,
  resolveAllowlist,
  RUNNER_GATEWAY,
  RUNNER_SUBNET,
  runnerNetworkAction,
  runnerNetworkCreateArgs,
  sidecarIpFromGateway,
} from '../orchestrator/egress.mjs';
import { assertNoLeak, leakHits, leakNeedles } from '../orchestrator/leak.mjs';
import { githubMcpEnv } from '../orchestrator/mcp.mjs';

const quiet = { warn() {} };

describe('egress allowlist', () => {
  test('includes GitHub, npm, and Cursor, and PostHog only when asked', () => {
    const plain = allowlistHosts();
    assert.ok(plain.includes('github.com'));
    assert.ok(plain.includes('registry.npmjs.org'));
    assert.ok(plain.includes('api2.cursor.sh'));
    assert.ok(plain.includes('agentn.global.api5.cursor.sh'));
    assert.ok(!plain.includes('mcp.posthog.com'));
    assert.ok(allowlistHosts({ posthog: true, extra: ['example.com'] }).includes('example.com'));
    assert.ok(allowlistHosts({ posthog: true }).includes('mcp.posthog.com'));
  });

  test('derives the gateway and the bridge name from a docker inspect payload', () => {
    assert.equal(gatewayFromSubnet('172.28.0.0/16'), '172.28.0.1');
    const parsed = parseRunnerNetwork([
      { Id: 'abcdef0123456789', IPAM: { Config: [{ Subnet: '172.28.0.0/16', Gateway: '172.28.0.1' }] } },
    ]);
    assert.equal(parsed.bridge, 'br-abcdef012345');
    assert.equal(parsed.gateway, '172.28.0.1');
  });

  test('the script rejects the gateway and private ranges, and allows only :443 to the list', () => {
    const script = renderEgressScript({
      bridge: 'br-abcdef012345',
      gateway: '172.28.0.1',
      subnet: '172.28.0.0/16',
      allowedIps: ['140.82.112.3'],
    });
    assert.match(script, /-d 172\.28\.0\.1 -j REJECT/);
    assert.match(script, /-d 10\.0\.0\.0\/8 -j REJECT/);
    assert.match(script, /-d 192\.168\.0\.0\/16 -j REJECT/);
    assert.match(script, /-p tcp -d 140\.82\.112\.3 --dport 443 -j RETURN/);
    assert.doesNotMatch(script, /--dport 22/);
    assert.match(script, /TMT-AGENT-INPUT/);
    assert.match(script, /ip6tables/);
  });

  test('GitHub is reachable only from the sidecar, and the proxy port is allowed first', () => {
    const script = renderEgressScript({
      bridge: 'br-abcdef012345',
      gateway: '172.28.0.1',
      subnet: '172.28.0.0/16',
      allowedIps: ['140.82.112.3', '104.16.0.1'],
      githubIps: ['140.82.112.3'],
      sidecarIp: '172.28.0.2',
    });
    const githubLines = script.split('\n').filter((line) => line.includes('140.82.112.3'));
    assert.ok(githubLines.length >= 1);
    assert.ok(githubLines.every((line) => line.includes('-s 172.28.0.2')));
    const direct = script.split('\n').find((line) => line.includes('104.16.0.1'));
    assert.match(direct, /--dport 443 -j RETURN/);
    assert.doesNotMatch(direct, /-s 172\.28\.0\.2/);
    const proxyAt = script.indexOf('--dport 3128');
    const dnsAt = script.indexOf('--dport 53');
    const privateAt = script.indexOf('-d 172.28.0.0/16 -j REJECT');
    assert.ok(proxyAt !== -1 && dnsAt !== -1 && proxyAt < dnsAt && dnsAt < privateAt);
    assert.match(script, /\/etc\/resolv\.conf/);
    assert.match(script, /nameserver/);
    assert.equal(sidecarIpFromGateway('172.28.0.1', '172.28.0.0/16'), '172.28.0.2');
    assert.equal(RUNNER_SUBNET, '172.28.0.0/16');
    assert.equal(RUNNER_GATEWAY, '172.28.0.1');
    assert.deepEqual(runnerNetworkCreateArgs('tmt-agent-runners').slice(2, 7), [
      '--driver',
      'bridge',
      '--subnet',
      '172.28.0.0/16',
      '--gateway',
    ]);
    const pinned = [{ Id: 'abcdef0123456789', IPAM: { Config: [{ Subnet: '172.28.0.0/16', Gateway: '172.28.0.1' }] }, Containers: {} }];
    const auto = [{ Id: 'abcdef0123456789', IPAM: { Config: [{ Subnet: '172.18.0.0/16', Gateway: '172.18.0.1' }] }, Containers: {} }];
    const busy = [{ Id: 'abcdef0123456789', IPAM: { Config: [{ Subnet: '172.18.0.0/16', Gateway: '172.18.0.1' }] }, Containers: { abc: {} } }];
    assert.equal(runnerNetworkAction(null), 'create');
    assert.equal(runnerNetworkAction(pinned), 'keep');
    assert.equal(runnerNetworkAction(auto), 'recreate');
    assert.equal(runnerNetworkAction(busy), 'busy');
    const covered = renderEgressScript({
      bridge: 'br-abcdef012345',
      gateway: '172.28.0.1',
      subnet: '172.28.0.0/16',
      allowedIps: ['140.82.116.4', '104.16.0.1'],
      githubIps: ['140.82.112.0/20'],
      sidecarIp: '172.28.0.2',
    });
    assert.match(covered, /-s 172\.28\.0\.2 -p tcp -d 140\.82\.112\.0\/20 --dport 443 -j RETURN/);
    assert.equal(covered.includes('140.82.116.4'), false);
    assert.match(covered, /-d 104\.16\.0\.1 --dport 443 -j RETURN/);
    assert.equal(githubSidecarDestinations({
      web: ['140.82.112.0/20', '2a0a:a440::/29', '10.0.0.0/8'],
      api: ['140.82.112.0/20'],
      git: ['185.199.108.0/22'],
      actions: ['4.148.0.0/16'],
    }).join(','), '140.82.112.0/20,185.199.108.0/22');
    assert.ok(GITHUB_SIDECAR_FALLBACK.includes('140.82.112.0/20'));
    assert.equal(directNoProxy().includes('github.com'), false);
    assert.equal(directNoProxy().includes('.cursor.sh'), true);
    assert.equal(directNoProxy().includes('registry.npmjs.org'), true);
    assert.equal(directNoProxy({ posthog: true }).includes('mcp.posthog.com'), true);
  });

  test('refuses to interpolate a bridge name that is not a docker bridge', () => {
    assert.throws(() =>
      renderEgressScript({
        bridge: 'br-abcdef012345; touch /tmp/pwned',
        gateway: '172.28.0.1',
        subnet: null,
        allowedIps: [],
      })
    );
  });

  test('a required host that fails to resolve aborts, an optional mirror does not', async () => {
    const calls = [];
    const resolve4 = async (host) => {
      calls.push(host);
      if (host === 'codeload.github.com') throw new Error('nope');
      return ['1.2.3.4'];
    };
    const ips = await resolveAllowlist(['github.com', 'codeload.github.com'], { resolve4, logger: quiet });
    assert.deepEqual(ips, ['1.2.3.4']);
    await assert.rejects(
      resolveAllowlist(['github.com'], {
        resolve4: async () => {
          throw new Error('dns down');
        },
        logger: quiet,
      }),
      /github\.com/
    );
  });
});

describe('publish scan', () => {
  const needles = leakNeedles({
    secrets: { GITHUB_TOKEN: 'ghp_1234567890abcdef', CURSOR_API_KEY: 'sk-cursor-secret-value' },
    canary: 'tmt-canary-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });

  test('a plan that repeats the canary or a runner secret is refused', () => {
    assert.deepEqual(leakHits('all clear', needles), []);
    assert.deepEqual(leakHits('token ghp_1234567890abcdef', needles), ['GITHUB_TOKEN']);
    assert.throws(
      () => assertNoLeak('see tmt-canary-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', needles),
      /canary/
    );
  });

  test('short values are not treated as secrets', () => {
    assert.deepEqual(leakHits('sk-short', leakNeedles({ secrets: { CURSOR_API_KEY: 'short' } })), []);
  });

  test('a database url is split into host, username, and password', () => {
    const pooled =
      'postgresql://branch_user_abcdef:p%40ssword-value@ep-example-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require';
    const direct =
      'postgresql://branch_user_abcdef:p%40ssword-value@ep-example.us-east-2.aws.neon.tech/neondb?sslmode=require';
    const withUrl = leakNeedles({
      secrets: { CURSOR_API_KEY: 'sk-cursor-secret-value' },
      databaseUrls: { DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: direct },
    });
    assert.equal(withUrl.DATABASE_URL_HOST, 'ep-example-pooler.us-east-2.aws.neon.tech');
    assert.equal(withUrl.DATABASE_URL_USERNAME, 'branch_user_abcdef');
    assert.equal(withUrl.DATABASE_URL_PASSWORD, 'p@ssword-value');
    assert.equal(withUrl.DATABASE_URL_PASSWORD_ENCODED, 'p%40ssword-value');
    assert.equal(withUrl.DATABASE_URL_UNPOOLED_HOST, 'ep-example.us-east-2.aws.neon.tech');
    assert.deepEqual(leakHits(`host ${withUrl.DATABASE_URL_HOST}`, withUrl), ['DATABASE_URL_HOST']);
    assert.ok(leakHits(pooled, withUrl).includes('DATABASE_URL_PASSWORD_ENCODED'));
    assert.ok(leakHits(pooled, withUrl).includes('DATABASE_URL_HOST'));
    assert.ok(leakHits(pooled, withUrl).includes('DATABASE_URL_USERNAME'));
    assert.throws(() => assertNoLeak('password p@ssword-value', withUrl), /DATABASE_URL_PASSWORD/);
    assert.throws(
      () => assertNoLeak('direct host ep-example.us-east-2.aws.neon.tech', withUrl),
      /DATABASE_URL_UNPOOLED_HOST/
    );
  });

  test('short database url parts are not treated as secrets', () => {
    const needles = leakNeedles({
      databaseUrls: { DATABASE_URL: 'postgresql://postgres:short@localhost/db' },
    });
    assert.equal(needles.DATABASE_URL_HOST, 'localhost');
    assert.equal(needles.DATABASE_URL_USERNAME, 'postgres');
    assert.equal(needles.DATABASE_URL_PASSWORD, 'short');
    assert.deepEqual(leakHits('localhost postgres short', needles), []);
    assert.deepEqual(leakHits('all clear', leakNeedles({ databaseUrls: { DATABASE_URL: 'not a url' } })), []);
  });
});

describe('github mcp mode', () => {
  test('triage is issues only, plan is read-only, execute cannot see workflow secrets', () => {
    assert.equal(githubMcpEnv('agent:triage').GITHUB_TOOLSETS, 'issues');
    assert.equal(githubMcpEnv('agent:triage').GITHUB_LOCKDOWN_MODE, '1');
    assert.equal(githubMcpEnv('agent:sdd').GITHUB_READ_ONLY, '1');
    assert.match(githubMcpEnv('agent:execute').GITHUB_TOOLSETS, /repos/);
    assert.equal(githubMcpEnv('agent:execute').GITHUB_READ_ONLY, undefined);
    assert.doesNotMatch(githubMcpEnv('agent:execute').GITHUB_TOOLSETS, /actions/);
  });
});
