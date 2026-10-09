import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA_SQL = new URL('../db/schema.sql', import.meta.url);

/** jsonb() and jsonb-aware json_extract() landed in SQLite 3.45.0 (January 2024). */
const MIN_SQLITE = [3, 45, 0];

export const DEFAULT_DB_PATH = process.env.DB_PATH || './sqlite_data/agent_queue.db';

function compareVersion(actual, required) {
  const parts = actual.split('.').map(Number);
  for (let i = 0; i < required.length; i++) {
    const a = parts[i] ?? 0;
    if (a !== required[i]) return a - required[i];
  }
  return 0;
}

function assertSqliteVersion(db) {
  const { version } = db.prepare('SELECT sqlite_version() AS version').get();
  if (compareVersion(version, MIN_SQLITE) < 0) {
    throw new Error(
      `SQLite ${MIN_SQLITE.join('.')}+ required for jsonb(), but better-sqlite3 is linked against ${version}. ` +
        'Upgrade better-sqlite3 (>=12) or rebuild it against a newer SQLite.'
    );
  }
  return version;
}

/**
 * Open the queue database, apply pragmas, verify the SQLite build, and ensure the schema.
 * Pass ':memory:' for tests.
 */
export function openDatabase(dbPath = DEFAULT_DB_PATH) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);

  // WAL lets the reaper and request handlers interleave without blocking readers.
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  assertSqliteVersion(db);
  db.exec(readFileSync(SCHEMA_SQL, 'utf8'));
  ensureAgentTaskColumns(db);

  return db;
}

/**
 * CREATE TABLE IF NOT EXISTS never adds columns to an existing table. Apply additive changes
 * here so a restarted queue picks them up without a separate migration tool.
 */
function ensureAgentTaskColumns(db) {
  const cols = new Set(
    db.prepare(`PRAGMA table_info(agent_tasks)`).all().map((row) => row.name)
  );
  if (!cols.has('token_usage')) {
    db.exec(`ALTER TABLE agent_tasks ADD COLUMN token_usage TEXT`);
  }
}

export function databaseInfo(db) {
  return {
    sqlite_version: db.prepare('SELECT sqlite_version() AS v').get().v,
    journal_mode: db.pragma('journal_mode', { simple: true }),
  };
}
