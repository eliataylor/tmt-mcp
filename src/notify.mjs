/**
 * One optional text POST for admin alerts.
 *
 * The body is the message. Title and Tags are the headers ntfy reads, so a private topic URL
 * is the whole integration. Empty ADMIN_NOTIFY_URL records nothing and sends nothing.
 * The URL is never written to the log: a topic path is a secret.
 */

export const NOTIFY_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * First call for a key returns true. Further calls inside the window return false.
 * A leak retry and a browser tab both need this; tunnel probes use the SQLite rollup instead.
 */
export function createCoalescer(windowMs = NOTIFY_COOLDOWN_MS, now = Date.now) {
  const last = new Map();
  return {
    allow(key) {
      const t = now();
      const prev = last.get(key);
      if (prev != null && t - prev < windowMs) return false;
      last.set(key, t);
      return true;
    },
  };
}

export async function notifyAdmin({
  title = 'tmt',
  body = '',
  tags = 'warning',
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 2000,
  log,
} = {}) {
  const url = env.ADMIN_NOTIFY_URL;
  if (!url) return false;

  const headers = {
    Title: title,
    Tags: tags,
    'Content-Type': 'text/plain; charset=utf-8',
  };
  if (env.ADMIN_NOTIFY_TOKEN) headers.Authorization = `Bearer ${env.ADMIN_NOTIFY_TOKEN}`;

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: String(body ?? ''),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      log?.warn?.(`admin notify failed: HTTP ${response.status}`);
      return false;
    }
    return true;
  } catch (err) {
    const detail = /https?:\/\//i.test(err?.message || '') ? 'request failed' : err?.message || 'request failed';
    log?.warn?.(`admin notify failed: ${detail}`);
    return false;
  }
}
