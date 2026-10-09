import type { Database, SqlJsStatic } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import type { DbMeta, QueryResult, SqlParams } from '../types';

type InitSqlJs = (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>;

let SQL: SqlJsStatic | null = null;
let db: Database | null = null;
let currentMeta: DbMeta | null = null;
let initPromise: Promise<SqlJsStatic> | null = null;

async function loadInitSqlJs(): Promise<InitSqlJs> {
  // sql.js ships CJS; Vite's browser export condition points at a file with no ESM default.
  // Import the wasm build explicitly and normalize the export shape.
  const mod = await import('sql.js/dist/sql-wasm.js');
  const init = (mod as { default?: InitSqlJs }).default ?? (mod as unknown as InitSqlJs);
  if (typeof init !== 'function') {
    throw new Error('sql.js did not export initSqlJs');
  }
  return init;
}

async function ensureSql(): Promise<SqlJsStatic> {
  if (SQL) return SQL;
  if (!initPromise) {
    initPromise = (async () => {
      const initSqlJs = await loadInitSqlJs();
      const mod = await initSqlJs({ locateFile: () => wasmUrl });
      SQL = mod;
      return mod;
    })();
  }
  try {
    return await initPromise;
  } catch (err) {
    initPromise = null;
    throw err;
  }
}

export function getDbMeta(): DbMeta | null {
  return currentMeta;
}

export function isDbOpen(): boolean {
  return currentMeta != null && db != null;
}

export async function openFromArrayBuffer(buffer: ArrayBuffer, fileName: string): Promise<DbMeta> {
  const sql = await ensureSql();
  if (db) {
    db.close();
    db = null;
  }
  // Copy so callers can reuse the original buffer; also avoids detached-transfer pitfalls.
  const bytes = new Uint8Array(buffer.slice(0));
  db = new sql.Database(bytes);
  currentMeta = {
    fileName,
    byteLength: bytes.byteLength,
    loadedAt: new Date().toISOString(),
  };
  return currentMeta;
}

export async function openFromFile(file: File): Promise<DbMeta> {
  const buffer = await file.arrayBuffer();
  return openFromArrayBuffer(buffer, file.name);
}

export async function openFromUrl(url: string, fileName: string): Promise<DbMeta> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const buffer = await res.arrayBuffer();
  return openFromArrayBuffer(buffer, fileName);
}

export async function closeDb(): Promise<void> {
  if (db) {
    db.close();
    db = null;
  }
  currentMeta = null;
}

export async function exec(sql: string, params: SqlParams = []): Promise<QueryResult> {
  if (!db) throw new Error('No database loaded');
  const stmt = db.prepare(sql);
  try {
    if (params.length) stmt.bind(params);
    const columns = stmt.getColumnNames();
    const values: Array<Array<string | number | null | Uint8Array>> = [];
    while (stmt.step()) {
      values.push(stmt.get() as Array<string | number | null | Uint8Array>);
    }
    return { columns, values };
  } finally {
    stmt.free();
  }
}

/** Map sql.js columns/values into plain objects. */
export function rowsFromResult(result: QueryResult): Record<string, unknown>[] {
  return result.values.map((row) => {
    const obj: Record<string, unknown> = {};
    result.columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}
