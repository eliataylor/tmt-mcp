/**
 * Discover the public hostname of a cloudflared *quick* tunnel.
 *
 * A quick tunnel mints a fresh random *.trycloudflare.com hostname every time it starts,
 * so the webhook URL changes on each restart. Rather than make you dig through container
 * logs, we ask cloudflared's metrics server for the current hostname and print the exact
 * URL to paste into GitHub.
 *
 * Requires `--metrics 0.0.0.0:2000` on the cloudflared command; see docker-compose.dev.yml.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function discoverQuickTunnelHostname({
  metricsUrl = process.env.TUNNEL_METRICS_URL,
  attempts = 15,
  delayMs = 2000,
  timeoutMs = 1500,
  fetchImpl = fetch,
} = {}) {
  if (!metricsUrl) return null;

  const endpoint = `${metricsUrl.replace(/\/$/, '')}/quicktunnel`;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) {
        const body = await response.json();
        const hostname = body?.hostname || body?.Hostname;
        if (hostname) return hostname;
      }
    } catch {
      // cloudflared is probably still coming up; keep trying.
    }
    if (attempt < attempts) await sleep(delayMs);
  }

  return null;
}

/** Best-effort: log the webhook URL once the tunnel is up. Never throws, never blocks boot. */
export function announceWebhookUrl(log, { path = '/api/agent/webhook', ...options } = {}) {
  discoverQuickTunnelHostname(options)
    .then((hostname) => {
      if (hostname) {
        log(`Webhook URL: https://${hostname}${path}`);
        log('Quick tunnels get a new hostname on every restart — update the repo webhook to match.');
      } else if (options.metricsUrl ?? process.env.TUNNEL_METRICS_URL) {
        log('Could not read the cloudflared quick tunnel hostname; check the tunnel container logs.');
      }
    })
    .catch(() => {});
}
