/**
 * Per-IP journal for the tunnel-facing listener.
 *
 * A signature-verified GitHub delivery is stored and does not page anyone. Everything else
 * is unusual: one alert per IP per 15 minutes, and the next alert says how many hits landed
 * in between. Request bodies, query strings, and signatures are not stored.
 */

import { notifyAdmin } from './notify.mjs';

export const UA_MAX = 120;
export const PATH_MAX = 200;
const COOLDOWN_MODIFIER = '-15 minutes';

export function normalizeIp(address) {
  const value = String(address || '').trim();
  if (!value) return 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
  return mapped ? mapped[1] : value;
}

/** Cloudflare sets CF-Connecting-IP. The socket address is the tunnel container otherwise. */
export function clientIp(req) {
  const header = req.headers?.['cf-connecting-ip'];
  const claimed = Array.isArray(header) ? header[0] : header;
  return normalizeIp(claimed || req.socket?.remoteAddress);
}

export function requestPath(req) {
  const raw = req.path || req.url || '/';
  const path = String(raw).split('?')[0] || '/';
  return path.slice(0, PATH_MAX);
}

export function truncateUa(value) {
  const ua = String(value || '').replace(/[\r\n]/g, ' ').trim();
  if (!ua) return null;
  return ua.slice(0, UA_MAX);
}

export function isUnusualReason(reason) {
  return reason !== 'github_delivery';
}

export function formatTunnelAlert({ ip, method, path, status, reason, count, userAgent }) {
  const lines = [
    `${ip} ${method} ${path} → ${status} ${reason}`,
    `${count} hit${count === 1 ? '' : 's'} from this IP since last alert`,
  ];
  if (userAgent) lines.push(`ua: ${userAgent}`);
  return lines.join('\n');
}

export function recordTunnelHit(db, { ip, method, path, status, reason, userAgent }) {
  return db.transaction(() => {
    const inserted = db
      .prepare(
        `INSERT INTO tunnel_hits (ip, method, path, status, reason, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(ip, method, path.slice(0, PATH_MAX), status, reason, userAgent);
    const hitId = Number(inserted.lastInsertRowid);
    const unusual = isUnusualReason(reason) ? 1 : 0;

    db.prepare(
      `INSERT INTO tunnel_ips (ip, first_seen, last_seen, hits, unusual_hits, last_reason)
       VALUES (?, datetime('now'), datetime('now'), 1, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET
         last_seen = datetime('now'),
         hits = hits + 1,
         unusual_hits = unusual_hits + excluded.unusual_hits,
         last_reason = excluded.last_reason`
    ).run(ip, unusual, reason);

    if (!unusual) return { unusual: false, notify: false, hitId };

    const row = db
      .prepare(
        `SELECT last_notified_hit_id,
                last_notified_at IS NOT NULL
                  AND last_notified_at > datetime('now', ?) AS quiet
         FROM tunnel_ips WHERE ip = ?`
      )
      .get(COOLDOWN_MODIFIER, ip);

    if (Number(row?.quiet) === 1) return { unusual: true, notify: false, hitId };

    const since = row?.last_notified_hit_id || 0;
    const count = db
      .prepare(
        `SELECT COUNT(*) AS n FROM tunnel_hits
         WHERE ip = ? AND reason != 'github_delivery' AND id > ?`
      )
      .get(ip, since).n;

    db.prepare(
      `UPDATE tunnel_ips
       SET last_notified_at = datetime('now'), last_notified_hit_id = ?
       WHERE ip = ?`
    ).run(hitId, ip);

    return {
      unusual: true,
      notify: true,
      hitId,
      count,
      ip,
      method,
      path,
      status,
      reason,
      userAgent,
    };
  })();
}

export async function recordAndAlert(db, fields, { notify = notifyAdmin, log } = {}) {
  let decision;
  try {
    decision = recordTunnelHit(db, fields);
  } catch (err) {
    log?.warn?.(`tunnel access log failed: ${err.message}`);
    return;
  }
  if (!decision?.notify) return;
  try {
    await notify({
      title: 'tmt tunnel',
      tags: 'warning',
      body: formatTunnelAlert(decision),
    });
  } catch (err) {
    log?.warn?.(`admin notify failed: ${err.message}`);
  }
}

export function pruneTunnelHits(db, { days = 30 } = {}) {
  const modifier = `-${Number(days)} days`;
  return db.prepare(`DELETE FROM tunnel_hits WHERE created_at < datetime('now', ?)`).run(modifier).changes;
}

export function readAccessLog(db, { limit = 50 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const ips = db
    .prepare(
      `SELECT ip, first_seen, last_seen, hits, unusual_hits, last_reason, last_notified_at
       FROM tunnel_ips
       ORDER BY last_seen DESC
       LIMIT ?`
    )
    .all(capped);
  const hits = db
    .prepare(
      `SELECT id, ip, method, path, status, reason, user_agent, created_at
       FROM tunnel_hits
       WHERE reason != 'github_delivery'
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(capped);
  return { ips, hits };
}

/** Express middleware. Registered before the source-IP guard so a 403 is still a row. */
export function tunnelAccessMiddleware(db, { log, notify } = {}) {
  return function accessLog(req, res, next) {
    res.on('finish', () => {
      const reason = res.locals.accessReason || (res.statusCode === 404 ? 'unknown_route' : 'other');
      recordAndAlert(
        db,
        {
          ip: clientIp(req),
          method: req.method,
          path: requestPath(req),
          status: res.statusCode,
          reason,
          userAgent: truncateUa(req.get?.('user-agent')),
        },
        { notify, log }
      ).catch((err) => log?.warn?.(`tunnel access log failed: ${err.message}`));
    });
    next();
  };
}
