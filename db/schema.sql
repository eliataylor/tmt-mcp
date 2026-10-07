-- Agent task queue. Applied idempotently at boot by src/db.mjs.
--
-- Timestamps use SQLite's native datetime() text format ('YYYY-MM-DD HH:MM:SS', UTC).
-- It stays readable when browsing the file directly and still compares correctly as
-- a string, so lease and backoff checks are plain <= comparisons against datetime('now').
--
-- Requires SQLite >= 3.45 for jsonb(). src/db.mjs asserts this at boot.

CREATE TABLE IF NOT EXISTS agent_tasks (
    id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    delivery_id         TEXT UNIQUE,              -- X-GitHub-Delivery, idempotency
    repo_full_name      TEXT GENERATED ALWAYS AS (json_extract(payload, '$.repository.full_name')) VIRTUAL,
    project_slug        TEXT NOT NULL,
    github_issue_id     INTEGER NOT NULL,         -- GitHub internal id
    github_issue_number INTEGER NOT NULL,         -- the #42 humans use
    issue_title         TEXT NOT NULL,
    action              TEXT NOT NULL,            -- 'agent:assigned', 'comment_created', ...
    payload             BLOB NOT NULL,            -- raw delivery, jsonb
    context             BLOB NOT NULL,            -- normalized manifest, jsonb
    status              TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','processing','completed','failed','cancelled')),
    attempts            INTEGER NOT NULL DEFAULT 0,
    max_attempts        INTEGER NOT NULL DEFAULT 3,
    available_at        TEXT NOT NULL DEFAULT (datetime('now')),  -- retry backoff
    locked_by           TEXT,
    locked_at           TEXT,
    lease_expires_at    TEXT,
    last_error          TEXT,
    completed_at        TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_claim  ON agent_tasks(project_slug, status, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_repo   ON agent_tasks(repo_full_name);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_issue  ON agent_tasks(project_slug, github_issue_number);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_lease  ON agent_tasks(lease_expires_at) WHERE status = 'processing';

-- Every request the tunnel-facing listener sees. unusual rows are anything that is not a
-- signature-verified GitHub delivery. The per-IP rollup is what an admin reads; raw hits are
-- pruned after 30 days. last_notified_hit_id is the newest unusual hit already included in an
-- alert, so the next push can say how many landed during the quiet period.
CREATE TABLE IF NOT EXISTS tunnel_hits (
    id          INTEGER PRIMARY KEY,
    ip          TEXT NOT NULL,
    method      TEXT NOT NULL,
    path        TEXT NOT NULL,
    status      INTEGER NOT NULL,
    reason      TEXT NOT NULL,
    user_agent  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tunnel_hits_ip      ON tunnel_hits(ip, id);
CREATE INDEX IF NOT EXISTS idx_tunnel_hits_created ON tunnel_hits(created_at);

CREATE TABLE IF NOT EXISTS tunnel_ips (
    ip                    TEXT PRIMARY KEY,
    first_seen            TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen             TEXT NOT NULL DEFAULT (datetime('now')),
    hits                  INTEGER NOT NULL DEFAULT 0,
    unusual_hits          INTEGER NOT NULL DEFAULT 0,
    last_reason           TEXT,
    last_notified_at      TEXT,
    last_notified_hit_id  INTEGER
);
