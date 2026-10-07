import crypto from 'node:crypto';

/**
 * Constant-time string comparison that does not leak the expected length.
 *
 * timingSafeEqual throws on a length mismatch, so comparing raw values would turn a
 * malformed header into a 500. Hashing both sides first gives two fixed-length digests,
 * which sidesteps both the throw and the length side channel.
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Verify GitHub's X-Hub-Signature-256 against the exact bytes GitHub sent.
 *
 * rawBody must be the untouched request buffer. Hashing a re-serialized JSON.stringify()
 * of the parsed body does not reproduce those bytes and rejects valid deliveries.
 */
export function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret) return false;
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) return false;
  if (!Buffer.isBuffer(rawBody)) return false;

  const digest = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const expected = Buffer.from(digest, 'utf8');
  const received = Buffer.from(signatureHeader, 'utf8');

  // Length guard first: timingSafeEqual throws when the buffers differ in size.
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

export function signBody(rawBody, secret) {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/**
 * The webhook secret for a project is the environment variable named by webhook_secret_env.
 * There is no shared fallback: a missing name or an unset variable fails closed.
 */
export function resolveWebhookSecret(project, env = process.env) {
  const name = project?.webhook_secret_env;
  if (!name) return { secret: null, source: null, missing: true };
  const scoped = env[name];
  if (scoped) return { secret: scoped, source: name };
  return { secret: null, source: name, missing: true };
}

/**
 * Read repository.full_name from an unverified body so we know which project's secret to
 * check the signature against. Nothing here is trusted: the peek only selects a key, and
 * the delivery is still rejected unless the HMAC verifies against it.
 */
export function peekRepoFullName(rawBody) {
  try {
    const parsed = JSON.parse(rawBody.toString('utf8'));
    const name = parsed?.repository?.full_name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

export function extractBearer(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match ? match[1] : null;
}

/** Express middleware guarding the orchestrator-facing endpoints. */
export function requireBearer(getSecret) {
  return function bearerGuard(req, res, next) {
    const expected = typeof getSecret === 'function' ? getSecret() : getSecret;
    if (!expected) {
      // Fail closed rather than accepting anything when the secret is unconfigured.
      return res.status(503).json({ error: 'AGENT_POLL_SECRET is not configured' });
    }
    const presented = extractBearer(req.headers.authorization);
    if (!presented || !safeEqual(presented, expected)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  };
}
