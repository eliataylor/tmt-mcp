import type { DateRangeFilter } from '../types';

/** SQLite datetime text: YYYY-MM-DD HH:MM:SS */
const SQLITE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function toSqliteDatetime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** datetime-local value (no seconds, local wall clock for the input). */
export function sqliteToInputValue(sqlite: string | null): string {
  if (!sqlite || !SQLITE_RE.test(sqlite)) return '';
  return sqlite.slice(0, 16).replace(' ', 'T');
}

/** Interpret datetime-local as UTC components matching our stored UTC strings. */
export function inputValueToSqlite(value: string): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) return null;
  const sec = m[3] ?? '00';
  return `${m[1]} ${m[2]}:${sec}`;
}

export function defaultDateRange(): DateRangeFilter {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from: toSqliteDatetime(from), to: toSqliteDatetime(to) };
}

export function readDateRangeFromSearch(params: URLSearchParams): DateRangeFilter {
  const fromRaw = params.get('from');
  const toRaw = params.get('to');
  if (!fromRaw && !toRaw) return defaultDateRange();
  return {
    from: fromRaw ? normalizeParam(fromRaw) : null,
    to: toRaw ? normalizeParam(toRaw) : null,
  };
}

function normalizeParam(raw: string): string | null {
  if (SQLITE_RE.test(raw)) return raw;
  return inputValueToSqlite(raw.includes('T') ? raw : raw.replace(' ', 'T'));
}

export function writeDateRangeToSearch(
  params: URLSearchParams,
  range: DateRangeFilter
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (range.from) next.set('from', range.from);
  else next.delete('from');
  if (range.to) next.set('to', range.to);
  else next.delete('to');
  return next;
}

export function isAllTime(range: DateRangeFilter): boolean {
  return range.from == null && range.to == null;
}
