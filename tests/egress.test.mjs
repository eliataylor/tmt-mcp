import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  allowlistHosts,
  directNoProxy,
  gatewayFromSubnet,
  parseRunnerNetwork,
  renderEgressScript,
  resolveAllowlist,
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
    const privateAt = script.indexOf('-d 172.28.0.0/16 -j REJECT');
    assert.ok(proxyAt !== -1 && proxyAt < privateAt);
    assert.equal(sidecarIpFromGateway('172.28.0.1', '172.28.0.0/16'), '172.28.0.2');
    assert.equal(directNoProxy().includes('github.com'), false);
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
});

describe('github mcp mode', () => {
  test('triage is issues only, plan is read-only, execute cannot see workflow secrets', () => {
    assert.equal(githubMcpEnv('agent:triage').GITHUB_TOOLSETS, 'issues');
    assert.equal(githubMcpEnv('agent:triage').GITHUB_LOCKDOWN_MODE, '1');
    assert.equal(githubMcpEnv('agent:assigned').GITHUB_READ_ONLY, '1');
    assert.match(githubMcpEnv('agent:execute').GITHUB_TOOLSETS, /repos/);
    assert.equal(githubMcpEnv('agent:execute').GITHUB_READ_ONLY, undefined);
    assert.doesNotMatch(githubMcpEnv('agent:execute').GITHUB_TOOLSETS, /actions/);
  });
});
