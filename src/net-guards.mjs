/**
 * Request-origin guards for the control listener.
 *
 * The control listener is published to the host as 127.0.0.1:<port> only, which keeps it off the
 * LAN, but a loopback binding alone does not stop a browser: a page can POST to 127.0.0.1, and
 * DNS rebinding defeats the CORS protection a custom Authorization header would otherwise give
 * by making the request same-origin from the browser's point of view.
 *
 * Two header checks close that: an allowlisted Host, plus the absence of the fetch metadata and
 * Origin headers a browser is obliged to attach. A CLI client sends neither, so requiring their
 * absence costs nothing and rejects every browser-originated request.
 */

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackAddress(address) {
  return LOOPBACK_ADDRESSES.has(String(address || '').trim());
}

/**
 * @param {object} req
 * @param {{allowedHosts: string[], requireLoopbackPeer?: boolean}} options
 *
 * requireLoopbackPeer is off by default because Docker's port publishing rewrites the peer
 * address to the bridge gateway, so inside a container every legitimate request looks non-local.
 * Reachability is restricted by binding the published port to 127.0.0.1 instead. Turn it on when
 * running the server directly on the host.
 */
export function checkControlRequest(req, { allowedHosts, requireLoopbackPeer = false }) {
  const host = req.headers.host;
  if (!host || !allowedHosts.includes(host)) {
    // A rebinding attack arrives with the attacker's hostname in Host, never ours.
    return { ok: false, reason: 'host_not_allowed' };
  }

  // Browsers always attach Origin to cross-origin requests and to any non-GET fetch.
  if (req.headers.origin !== undefined) {
    return { ok: false, reason: 'origin_header_present' };
  }

  // Sec-Fetch-Site is set by the browser and cannot be forged or stripped by page JavaScript.
  // Note that Sec-Fetch-Mode is deliberately NOT checked: Node's fetch() sends
  // `Sec-Fetch-Mode: cors` with no Sec-Fetch-Site, so rejecting on it would lock out every
  // non-browser client that happens to use fetch. Browsers never send Mode without Site, so
  // keying on Site alone loses no coverage.
  if (req.headers['sec-fetch-site'] !== undefined) {
    return { ok: false, reason: 'sec_fetch_site_present' };
  }

  if (requireLoopbackPeer && !isLoopbackAddress(req.socket?.remoteAddress)) {
    return { ok: false, reason: 'non_loopback_peer' };
  }

  return { ok: true };
}

/** Express middleware wrapper around checkControlRequest. */
export function controlPlaneGuard(options) {
  return function guard(req, res, next) {
    const verdict = checkControlRequest(req, options);
    if (!verdict.ok) {
      options.logger?.warn?.(`[Control] rejected request: ${verdict.reason}`);
      // Deliberately terse: a browser probe learns nothing about what is listening here.
      return res.status(403).json({ error: 'Forbidden' });
    }
    return next();
  };
}

/**
 * Middleware asserting a webhook delivery came from a GitHub hooks range.
 *
 * When the ranges have not loaded yet the request is allowed through with a warning, so a
 * network hiccup at startup cannot silently drop every delivery while the HMAC is still doing
 * the real work. A loaded list always rejects addresses outside it.
 */
export function githubSourceGuard(meta, { logger = console } = {}) {
  return function guard(req, res, next) {
    const claimed = req.headers['cf-connecting-ip'] || req.socket?.remoteAddress;
    const verdict = meta.contains(claimed);

    if (verdict === null) {
      logger.warn?.(
        `[Webhook] GitHub /meta ranges unavailable, skipping source-IP check for ${claimed}`
      );
      return next();
    }
    if (verdict) return next();

    logger.warn?.(`[Webhook] rejected delivery from ${claimed}: outside GitHub hooks ranges`);
    return res.status(403).json({ error: 'Forbidden' });
  };
}
