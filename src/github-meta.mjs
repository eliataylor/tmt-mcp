/**
 * GitHub webhook source-IP verification.
 *
 * Defense in depth behind the HMAC: even a valid-looking delivery is rejected unless it arrived
 * from a published GitHub hooks range. Because cloudflared fronts the listener, the true client
 * is in CF-Connecting-IP; the tunnel is ours, so that header is trustworthy here in a way it
 * would not be on a directly exposed server.
 */

const META_URL = 'https://api.github.com/meta';
const REFRESH_MS = 6 * 60 * 60 * 1000;

function ipv4ToBigInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function ipv6ToBigInt(ip) {
  // ::ffff:1.2.3.4 form, which is how Node reports IPv4 peers on a dual-stack socket.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return ipv4ToBigInt(mapped[1]);

  const [head, tail] = ip.split('::');
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const tailGroups = tail !== undefined && tail ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  if (ip.includes('::') ? missing < 0 : headGroups.length !== 8) return null;

  const groups = ip.includes('::')
    ? [...headGroups, ...Array(missing).fill('0'), ...tailGroups]
    : headGroups;

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

export function parseIp(ip) {
  if (typeof ip !== 'string' || !ip) return null;
  const clean = ip.trim();
  if (clean.includes(':')) {
    const value = ipv6ToBigInt(clean);
    return value === null ? null : { value, bits: clean.startsWith('::ffff:') ? 32 : 128 };
  }
  const value = ipv4ToBigInt(clean);
  return value === null ? null : { value, bits: 32 };
}

export function parseCidr(cidr) {
  const [addr, prefixRaw] = String(cidr).split('/');
  const parsed = parseIp(addr);
  if (!parsed) return null;
  const totalBits = addr.includes(':') && !addr.startsWith('::ffff:') ? 128 : 32;
  const prefix = prefixRaw === undefined ? totalBits : Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > totalBits) return null;

  const hostBits = BigInt(totalBits - prefix);
  return { network: (parsed.value >> hostBits) << hostBits, hostBits, totalBits };
}

export function ipInCidr(ip, cidr) {
  const parsedIp = parseIp(ip);
  const parsedCidr = parseCidr(cidr);
  if (!parsedIp || !parsedCidr) return false;
  if (parsedIp.bits !== parsedCidr.totalBits) return false;
  return (parsedIp.value >> parsedCidr.hostBits) << parsedCidr.hostBits === parsedCidr.network;
}

/**
 * Caches the hooks ranges and refreshes them lazily. A fetch failure keeps the previous list
 * rather than opening the door, and an empty list means "not yet loaded" to the caller.
 */
export function createGithubMeta({ fetchImpl = fetch, refreshMs = REFRESH_MS } = {}) {
  let hooks = [];
  let fetchedAt = 0;
  let lastError = null;

  async function refresh(force = false) {
    if (!force && hooks.length && Date.now() - fetchedAt < refreshMs) {
      return { ok: true, cached: true, count: hooks.length };
    }
    try {
      const res = await fetchImpl(META_URL, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'tmt-mcp-queue' },
      });
      if (!res.ok) throw new Error(`GET /meta returned ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body.hooks) || body.hooks.length === 0) {
        throw new Error('/meta response had no hooks ranges');
      }
      hooks = body.hooks;
      fetchedAt = Date.now();
      lastError = null;
      return { ok: true, cached: false, count: hooks.length };
    } catch (err) {
      lastError = err;
      return { ok: false, error: err, count: hooks.length };
    }
  }

  return {
    refresh,
    get ranges() {
      return hooks.slice();
    },
    get loaded() {
      return hooks.length > 0;
    },
    get lastError() {
      return lastError;
    },
    contains(ip) {
      if (!hooks.length) return null; // unknown, caller decides
      return hooks.some((cidr) => ipInCidr(ip, cidr));
    },
  };
}
