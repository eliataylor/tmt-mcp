const MIN_SECRET_LENGTH = 12;

/**
 * Names of values that must not show up in anything the orchestrator commits or posts, or in a
 * GitHub comment the runner sends through the credential proxy.
 * The canary is planted in the prompt so a model that echoes its instructions is caught here.
 * A database URL is split into host, username, and password so a partial copy is caught too.
 * Parts shorter than a real token are ignored, which keeps a username like "postgres" from
 * matching ordinary text.
 */
export function leakNeedles({ secrets = {}, canary = null, databaseUrls = null } = {}) {
  const urls = databaseUrls || {
    DATABASE_URL: secrets.DATABASE_URL,
    DATABASE_URL_UNPOOLED: secrets.DATABASE_URL_UNPOOLED,
  };
  const needles = {
    canary,
    GITHUB_TOKEN: secrets.GITHUB_TOKEN,
    CURSOR_API_KEY: secrets.CURSOR_API_KEY,
    POSTHOG_MCP_API_KEY: secrets.POSTHOG_MCP_API_KEY,
  };
  for (const [name, url] of Object.entries(urls || {})) {
    if (!/^[A-Z0-9_]+$/.test(name)) continue;
    const parts = databaseUrlParts(url);
    if (!parts) continue;
    assign(needles, `${name}_HOST`, parts.host);
    assign(needles, `${name}_USERNAME`, parts.username);
    assign(needles, `${name}_PASSWORD`, parts.password);
    // The file stores the connection string as written. A percent-encoded password is not the
    // decoded value, so both have to be needles or pasting the URL would miss.
    assign(needles, `${name}_USERNAME_ENCODED`, parts.usernameEncoded);
    assign(needles, `${name}_PASSWORD_ENCODED`, parts.passwordEncoded);
  }
  return needles;
}

/** Host, username, and password from a database URL. Null when `value` is not a URL. */
export function databaseUrlParts(value) {
  if (typeof value !== 'string' || !value.includes('://')) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const username = decodePart(parsed.username);
  const password = decodePart(parsed.password);
  const raw = rawUserinfo(value);
  return {
    host: parsed.hostname || '',
    username,
    password,
    usernameEncoded: raw.username && raw.username !== username ? raw.username : '',
    passwordEncoded: raw.password && raw.password !== password ? raw.password : '',
  };
}

function decodePart(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Userinfo as it appears in the original string, before the URL parser decodes it. */
function rawUserinfo(value) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)@/i.exec(value);
  if (!match) return { username: '', password: '' };
  const info = match[1];
  const colon = info.indexOf(':');
  if (colon === -1) return { username: info, password: '' };
  return { username: info.slice(0, colon), password: info.slice(colon + 1) };
}

function assign(needles, name, value) {
  if (typeof value === 'string' && value) needles[name] = value;
}

/** Which needle names occur in `text`. Values shorter than a real token are ignored. */
export function leakHits(text, needles) {
  const body = String(text ?? '');
  const hits = [];
  for (const [name, value] of Object.entries(needles || {})) {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) continue;
    if (body.includes(value)) hits.push(name);
  }
  return hits;
}

export function assertNoLeak(text, needles) {
  const hits = leakHits(text, needles);
  if (!hits.length) return;
  throw new Error(`refusing to publish: content contains ${hits.join(', ')}`);
}
