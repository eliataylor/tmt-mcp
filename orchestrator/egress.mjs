import { promises as dns } from 'node:dns';

/**
 * Destinations a runner is allowed to open. Everything else, including the bridge gateway
 * (the route back to the Mac), is rejected by the filter rules below.
 *
 * TCP 443 only. GitHub is not in the runner's direct list: only the credential proxy's address
 * may dial those hosts, and it injects the token. Runners reach GitHub by opening the proxy
 * port on the sidecar, and reach npm, Cursor, and PostHog directly.
 */
export const GITHUB_EGRESS_HOSTS = [
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
];

export const EGRESS_ALLOW_HOSTS = [
  ...GITHUB_EGRESS_HOSTS,
  'registry.npmjs.org',
  'api.npmjs.org',
  'cursor.com',
  'api.cursor.com',
  'api2.cursor.sh',
  'api2geo.cursor.sh',
  'api2direct.cursor.sh',
  'marketplace.cursorapi.com',
];

export const POSTHOG_EGRESS_HOSTS = ['mcp.posthog.com', 'us.posthog.com', 'eu.posthog.com'];

const REQUIRED_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'registry.npmjs.org',
  'api2.cursor.sh',
]);

const IPV4 =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const CIDR = new RegExp(`^${IPV4.source.slice(1, -1)}/(?:3[0-2]|[12]?\\d)$`);
const BRIDGE = /^br-[0-9a-f]{12}$/;

const PRIVATE_CIDRS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '127.0.0.0/8'];

export function allowlistHosts({ posthog = false, extra = [] } = {}) {
  const hosts = [...EGRESS_ALLOW_HOSTS];
  if (posthog) hosts.push(...POSTHOG_EGRESS_HOSTS);
  for (const host of extra) {
    if (host) hosts.push(host);
  }
  return [...new Set(hosts)];
}

/** GitHub hosts are dialed by the sidecar. Everything else is direct from the runner. */
export function partitionAllowlist(hosts) {
  const github = [];
  const direct = [];
  for (const host of hosts) {
    if (GITHUB_EGRESS_HOSTS.includes(host)) github.push(host);
    else direct.push(host);
  }
  return { github, direct };
}

/**
 * Hosts that must bypass the proxy so they keep the public CA bundle. GitHub is absent on purpose:
 * git and the MCP server reach it through the sidecar, which presents the local CA.
 */
export function directNoProxy({ posthog = false, extra = [] } = {}) {
  const { direct } = partitionAllowlist(allowlistHosts({ posthog, extra }));
  return ['localhost', '127.0.0.1', ...direct].join(',');
}

/** Pin the sidecar just after the gateway so egress rules have a stable address to name. */
export function sidecarIpFromGateway(gateway, subnet) {
  if (!IPV4.test(gateway || '')) throw new Error(`gateway is not IPv4: ${gateway}`);
  const parts = gateway.split('.').map(Number);
  parts[3] = parts[3] === 2 ? 3 : 2;
  const ip = parts.join('.');
  if (subnet && !ipv4InCidr(ip, subnet)) {
    throw new Error(`credential proxy address ${ip} is outside ${subnet}`);
  }
  return ip;
}

function ipv4InCidr(ip, cidr) {
  if (!CIDR.test(cidr) || !IPV4.test(ip)) return false;
  const [addr, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(addr) & mask);
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

export function egressOptionsFrom(config, env = process.env) {
  const extra = String(env.RUNNER_EGRESS_ALLOW_HOSTS || '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  return {
    network: config.runner.network,
    image: config.runner.image,
    posthog: Boolean(config.secrets?.POSTHOG_MCP_API_KEY),
    extraHosts: extra,
  };
}

/** First address of a subnet, plus one. Docker's gateway when IPAM omits it. */
export function gatewayFromSubnet(cidr) {
  if (!CIDR.test(cidr || '')) return null;
  const [addr, bits] = cidr.split('/');
  if (Number(bits) > 30) return null;
  const parts = addr.split('.').map(Number);
  parts[3] += 1;
  return parts.join('.');
}

export function parseRunnerNetwork(inspect) {
  const net = Array.isArray(inspect) ? inspect[0] : inspect;
  if (!net || typeof net !== 'object') throw new Error('docker network inspect returned no network');
  const id = String(net.Id || '');
  if (!/^[0-9a-f]{12,}$/.test(id)) {
    throw new Error(`runner network id is not a docker id: ${id || '(empty)'}`);
  }
  const bridge = `br-${id.slice(0, 12)}`;
  const ipam = net.IPAM?.Config?.[0] || {};
  const subnet = ipam.Subnet || null;
  const gateway = ipam.Gateway || gatewayFromSubnet(subnet);
  if (!IPV4.test(gateway || '')) {
    throw new Error(`runner network ${bridge} has no IPv4 gateway`);
  }
  if (subnet && !CIDR.test(subnet)) {
    throw new Error(`runner network subnet is not IPv4 CIDR: ${subnet}`);
  }
  return { bridge, gateway, subnet };
}

/**
 * Resolve the allowlist. Required hosts fail the boot; the rest are skipped with a warning so a
 * missing geo endpoint does not take the orchestrator down.
 */
export async function resolveAllowlist(hosts, { resolve4 = dns.resolve4, logger = console } = {}) {
  const ips = new Set();
  for (const host of hosts) {
    if (!/^[A-Za-z0-9.-]+$/.test(host)) {
      throw new Error(`egress allowlist host is not a hostname: ${host}`);
    }
    try {
      const found = await resolve4(host);
      for (const ip of found) {
        if (!IPV4.test(ip)) throw new Error(`${host} resolved to a non-IPv4 address`);
        ips.add(ip);
      }
      if (!found.length) throw new Error(`${host} resolved to no addresses`);
    } catch (err) {
      // Mirrors and regional PostHog hosts are optional. Extra hosts the operator named are not.
      const optionalMirror = EGRESS_ALLOW_HOSTS.includes(host) && !REQUIRED_HOSTS.has(host);
      const optionalPosthog = POSTHOG_EGRESS_HOSTS.includes(host) && host !== 'mcp.posthog.com';
      if (optionalMirror || optionalPosthog) {
        logger.warn(`[Egress] skipping ${host}: ${err.message}`);
        continue;
      }
      throw new Error(`egress allowlist could not resolve ${host}: ${err.message}`);
    }
  }
  return [...ips];
}

/**
 * Shell script run with `iptables` inside the Docker VM's network namespace.
 *
 * DOCKER-USER sees forwarded packets (container to the internet). INPUT sees packets addressed
 * to the VM itself, which is how a container reaches a port published on the Mac. Both chains
 * reject the runner bridge except TCP 443 to the direct allowlist. When `sidecarIp` is set,
 * GitHub's addresses are reachable only from that source, and the proxy ports are allowed
 * before the private-range reject (the sidecar itself is a private address on the bridge).
 */
export function renderEgressScript({
  bridge,
  gateway,
  subnet,
  allowedIps,
  githubIps = [],
  sidecarIp = null,
  proxyPort = 3128,
  adminPort = 3129,
}) {
  if (!BRIDGE.test(bridge)) throw new Error(`refusing egress script for bridge "${bridge}"`);
  if (!IPV4.test(gateway)) throw new Error(`refusing egress script for gateway "${gateway}"`);
  if (subnet && !CIDR.test(subnet)) throw new Error(`refusing egress script for subnet "${subnet}"`);
  if (sidecarIp !== null && sidecarIp !== undefined) {
    if (!IPV4.test(sidecarIp)) throw new Error(`refusing egress script for sidecar "${sidecarIp}"`);
    if (sidecarIp === gateway) throw new Error('credential proxy address cannot be the gateway');
    assertPort(proxyPort);
    assertPort(adminPort);
  }
  for (const ip of [...allowedIps, ...githubIps]) {
    if (!IPV4.test(ip)) throw new Error(`refusing egress script for address "${ip}"`);
  }

  // A GitHub address that also appears in the direct list would let a runner skip the proxy.
  const githubSet = new Set(githubIps);
  const directIps = sidecarIp ? allowedIps.filter((ip) => !githubSet.has(ip)) : allowedIps;

  const lines = ['set -eu', 'if iptables -S DOCKER-USER >/dev/null 2>&1; then IPT=iptables'];
  lines.push('elif command -v iptables-legacy >/dev/null 2>&1 && iptables-legacy -S DOCKER-USER >/dev/null 2>&1; then IPT=iptables-legacy');
  lines.push('else echo "DOCKER-USER chain not found; is this the Docker VM network namespace?" >&2; exit 1; fi');

  lines.push(...chainPreamble('$IPT', 'TMT-AGENT-EGRESS', 'DOCKER-USER'));
  lines.push('$IPT -A TMT-AGENT-EGRESS -i ' + bridge + ' -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN');
  if (sidecarIp) {
    for (const ip of githubIps) {
      lines.push(
        `$IPT -A TMT-AGENT-EGRESS -i ${bridge} -s ${sidecarIp} -p tcp -d ${ip} --dport 443 -j RETURN`
      );
    }
    lines.push(
      `$IPT -A TMT-AGENT-EGRESS -i ${bridge} -p tcp -d ${sidecarIp} --dport ${proxyPort} -j RETURN`
    );
    lines.push(
      `$IPT -A TMT-AGENT-EGRESS -i ${bridge} -p tcp -d ${sidecarIp} --dport ${adminPort} -j RETURN`
    );
  }
  lines.push(`$IPT -A TMT-AGENT-EGRESS -i ${bridge} -d ${gateway} -j REJECT`);
  if (subnet) lines.push(`$IPT -A TMT-AGENT-EGRESS -i ${bridge} -d ${subnet} -j REJECT`);
  for (const cidr of PRIVATE_CIDRS) {
    lines.push(`$IPT -A TMT-AGENT-EGRESS -i ${bridge} -d ${cidr} -j REJECT`);
  }
  for (const ip of directIps) {
    lines.push(`$IPT -A TMT-AGENT-EGRESS -i ${bridge} -p tcp -d ${ip} --dport 443 -j RETURN`);
  }
  lines.push(`$IPT -A TMT-AGENT-EGRESS -i ${bridge} -j REJECT`);
  lines.push('$IPT -A TMT-AGENT-EGRESS -j RETURN');

  lines.push(...chainPreamble('$IPT', 'TMT-AGENT-INPUT', 'INPUT'));
  lines.push('$IPT -A TMT-AGENT-INPUT -i ' + bridge + ' -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN');
  lines.push(`$IPT -A TMT-AGENT-INPUT -i ${bridge} -j REJECT`);
  lines.push('$IPT -A TMT-AGENT-INPUT -j RETURN');

  lines.push('if command -v ip6tables >/dev/null 2>&1 && ip6tables -S DOCKER-USER >/dev/null 2>&1; then');
  lines.push(...chainPreamble('ip6tables', 'TMT-AGENT-EGRESS6', 'DOCKER-USER').map((line) => `  ${line}`));
  lines.push(`  ip6tables -A TMT-AGENT-EGRESS6 -i ${bridge} -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN`);
  lines.push(`  ip6tables -A TMT-AGENT-EGRESS6 -i ${bridge} -j REJECT`);
  lines.push('  ip6tables -A TMT-AGENT-EGRESS6 -j RETURN');
  lines.push(...chainPreamble('ip6tables', 'TMT-AGENT-INPUT6', 'INPUT').map((line) => `  ${line}`));
  lines.push(`  ip6tables -A TMT-AGENT-INPUT6 -i ${bridge} -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN`);
  lines.push(`  ip6tables -A TMT-AGENT-INPUT6 -i ${bridge} -j REJECT`);
  lines.push('  ip6tables -A TMT-AGENT-INPUT6 -j RETURN');
  lines.push('fi');

  return `${lines.join('\n')}\n`;
}

function assertPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`refusing egress script for port "${port}"`);
  }
}

function chainPreamble(ipt, chain, parent) {
  return [
    `${ipt} -N ${chain} 2>/dev/null || true`,
    `${ipt} -F ${chain}`,
    `${ipt} -C ${parent} -j ${chain} 2>/dev/null || ${ipt} -I ${parent} 1 -j ${chain}`,
  ];
}
