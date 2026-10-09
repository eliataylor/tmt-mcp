import type {
  AggByActionRow,
  AggByAuthorRow,
  AgentTaskListItem,
  AgentTaskRow,
  DateRangeFilter,
  PaginatedResult,
  StatusCounts,
  TableCounts,
  TaskListFilters,
  TimelineBucket,
  TunnelHitFilters,
  TunnelHitRow,
  TunnelIpFilters,
  TunnelIpRow,
} from '../types';
import { UNKNOWN_AUTHOR } from '../types';
import { exec, rowsFromResult } from './client';
import {
  emptyStatusCounts,
  parseTaskListItem,
  parseTaskRow,
  parseTunnelHit,
  parseTunnelIp,
  tokenTotalsFromParts,
} from './parse';
import { tokenSumsSelectExpr, tokenUsageSelectExpr } from './schema';

type Clause = { sql: string; params: Array<string | number | null> };

function dateClauses(column: string, range: DateRangeFilter): Clause[] {
  const out: Clause[] = [];
  if (range.from) out.push({ sql: `${column} >= ?`, params: [range.from] });
  if (range.to) out.push({ sql: `${column} <= ?`, params: [range.to] });
  return out;
}

function combine(clauses: Clause[]): { where: string; params: Array<string | number | null> } {
  if (!clauses.length) return { where: '', params: [] };
  return {
    where: `WHERE ${clauses.map((c) => c.sql).join(' AND ')}`,
    params: clauses.flatMap((c) => c.params),
  };
}

const AUTHOR_EXPR = `COALESCE(json_extract(json(context), '$.issue.author'), '${UNKNOWN_AUTHOR}')`;

const STATUS_SUMS = `
  SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
  SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
  SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
  SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
`;

function statusCountsFromRow(row: Record<string, unknown>): StatusCounts {
  return {
    pending: Number(row.pending) || 0,
    processing: Number(row.processing) || 0,
    completed: Number(row.completed) || 0,
    failed: Number(row.failed) || 0,
    cancelled: Number(row.cancelled) || 0,
  };
}

function tokensFromRow(row: Record<string, unknown>) {
  return tokenTotalsFromParts(
    Number(row.input_tokens) || 0,
    Number(row.output_tokens) || 0,
    Number(row.cache_read_tokens) || 0,
    Number(row.cache_write_tokens) || 0
  );
}

function taskFilterClauses(filters: TaskListFilters): Clause[] {
  const clauses = dateClauses('created_at', filters);
  if (filters.status) clauses.push({ sql: 'status = ?', params: [filters.status] });
  if (filters.projectSlug) clauses.push({ sql: 'project_slug = ?', params: [filters.projectSlug] });
  if (filters.action) clauses.push({ sql: 'action = ?', params: [filters.action] });
  if (filters.author) {
    if (filters.author === UNKNOWN_AUTHOR) {
      clauses.push({
        sql: `(json_extract(json(context), '$.issue.author') IS NULL OR json_extract(json(context), '$.issue.author') = '')`,
        params: [],
      });
    } else {
      clauses.push({
        sql: `json_extract(json(context), '$.issue.author') = ?`,
        params: [filters.author],
      });
    }
  }
  return clauses;
}

export async function getTableCounts(): Promise<TableCounts> {
  const result = await exec(`
    SELECT
      (SELECT COUNT(*) FROM agent_tasks) AS agent_tasks,
      (SELECT COUNT(*) FROM tunnel_hits) AS tunnel_hits,
      (SELECT COUNT(*) FROM tunnel_ips) AS tunnel_ips
  `);
  const row = rowsFromResult(result)[0] ?? {};
  return {
    agent_tasks: Number(row.agent_tasks) || 0,
    tunnel_hits: Number(row.tunnel_hits) || 0,
    tunnel_ips: Number(row.tunnel_ips) || 0,
  };
}

export async function listTasks(filters: TaskListFilters): Promise<PaginatedResult<AgentTaskListItem>> {
  const { where, params } = combine(taskFilterClauses(filters));
  const countRes = await exec(`SELECT COUNT(*) AS n FROM agent_tasks ${where}`, params);
  const total = Number(rowsFromResult(countRes)[0]?.n) || 0;

  const listRes = await exec(
    `SELECT id, delivery_id, repo_full_name, project_slug, github_issue_id, github_issue_number,
            issue_title, action, status, attempts, max_attempts, available_at,
            locked_by, locked_at, lease_expires_at, last_error, ${tokenUsageSelectExpr()},
            completed_at, created_at, updated_at,
            ${AUTHOR_EXPR} AS author
       FROM agent_tasks
       ${where}
      ORDER BY created_at DESC, rowid DESC
      LIMIT ? OFFSET ?`,
    [...params, filters.limit, filters.offset]
  );

  return {
    total,
    rows: rowsFromResult(listRes).map(parseTaskListItem),
  };
}

export async function getTask(id: string): Promise<AgentTaskRow | null> {
  const result = await exec(
    `SELECT id, delivery_id, repo_full_name, project_slug, github_issue_id, github_issue_number,
            issue_title, action, status, attempts, max_attempts, available_at,
            locked_by, locked_at, lease_expires_at, last_error, ${tokenUsageSelectExpr()},
            completed_at, created_at, updated_at,
            ${AUTHOR_EXPR} AS author,
            json(payload) AS payload, json(context) AS context
       FROM agent_tasks
      WHERE id = ?
      LIMIT 1`,
    [id]
  );
  const row = rowsFromResult(result)[0];
  return row ? parseTaskRow(row) : null;
}

function mapAggRow(row: Record<string, unknown>, key: 'author' | 'action'): AggByAuthorRow | AggByActionRow {
  const base = {
    taskCount: Number(row.task_count) || 0,
    statusCounts: statusCountsFromRow(row),
    tokens: tokensFromRow(row),
  };
  if (key === 'author') {
    return { author: String(row.author ?? UNKNOWN_AUTHOR), ...base };
  }
  return { action: String(row.action ?? ''), ...base };
}

async function timelineFor(
  range: DateRangeFilter,
  extra: Clause[],
  groupFilterSql: string,
  groupParams: Array<string | number | null>
): Promise<TimelineBucket[]> {
  const clauses = [...dateClauses('created_at', range), ...extra];
  const { where, params } = combine(clauses);
  // groupFilterSql unused for global timeline — kept for symmetry if we scope later
  void groupFilterSql;
  void groupParams;
  const result = await exec(
    `SELECT substr(created_at, 1, 10) AS day,
            COUNT(*) AS task_count,
            ${tokenSumsSelectExpr()}
       FROM agent_tasks
       ${where}
      GROUP BY day
      ORDER BY day ASC`,
    params
  );
  return rowsFromResult(result).map((row) => ({
    day: String(row.day ?? ''),
    taskCount: Number(row.task_count) || 0,
    tokens: tokensFromRow(row),
  }));
}

export async function aggByAuthor(range: DateRangeFilter): Promise<{
  rows: AggByAuthorRow[];
  timeline: TimelineBucket[];
}> {
  const { where, params } = combine(dateClauses('created_at', range));
  const result = await exec(
    `SELECT ${AUTHOR_EXPR} AS author,
            COUNT(*) AS task_count,
            ${STATUS_SUMS},
            ${tokenSumsSelectExpr()}
       FROM agent_tasks
       ${where}
      GROUP BY author
      ORDER BY task_count DESC`,
    params
  );
  const rows = rowsFromResult(result).map((r) => mapAggRow(r, 'author') as AggByAuthorRow);
  const timeline = await timelineFor(range, [], '', []);
  return { rows, timeline };
}

export async function aggByAction(range: DateRangeFilter): Promise<{
  rows: AggByActionRow[];
  timeline: TimelineBucket[];
}> {
  const { where, params } = combine(dateClauses('created_at', range));
  const result = await exec(
    `SELECT action,
            COUNT(*) AS task_count,
            ${STATUS_SUMS},
            ${tokenSumsSelectExpr()}
       FROM agent_tasks
       ${where}
      GROUP BY action
      ORDER BY task_count DESC`,
    params
  );
  const rows = rowsFromResult(result).map((r) => mapAggRow(r, 'action') as AggByActionRow);
  const timeline = await timelineFor(range, [], '', []);
  return { rows, timeline };
}

export async function listTunnelHits(
  filters: TunnelHitFilters
): Promise<PaginatedResult<TunnelHitRow>> {
  const clauses = dateClauses('created_at', filters);
  if (filters.reason) clauses.push({ sql: 'reason = ?', params: [filters.reason] });
  if (filters.ip) clauses.push({ sql: 'ip = ?', params: [filters.ip] });
  const { where, params } = combine(clauses);

  const countRes = await exec(`SELECT COUNT(*) AS n FROM tunnel_hits ${where}`, params);
  const total = Number(rowsFromResult(countRes)[0]?.n) || 0;

  const listRes = await exec(
    `SELECT id, ip, method, path, status, reason, user_agent, created_at
       FROM tunnel_hits
       ${where}
      ORDER BY id DESC
      LIMIT ? OFFSET ?`,
    [...params, filters.limit, filters.offset]
  );

  return { total, rows: rowsFromResult(listRes).map(parseTunnelHit) };
}

export async function listTunnelIps(filters: TunnelIpFilters): Promise<PaginatedResult<TunnelIpRow>> {
  const clauses = dateClauses('last_seen', filters);
  if (filters.unusualOnly) clauses.push({ sql: 'unusual_hits > 0', params: [] });
  const { where, params } = combine(clauses);

  const countRes = await exec(`SELECT COUNT(*) AS n FROM tunnel_ips ${where}`, params);
  const total = Number(rowsFromResult(countRes)[0]?.n) || 0;

  const listRes = await exec(
    `SELECT ip, first_seen, last_seen, hits, unusual_hits, last_reason,
            last_notified_at, last_notified_hit_id
       FROM tunnel_ips
       ${where}
      ORDER BY last_seen DESC
      LIMIT ? OFFSET ?`,
    [...params, filters.limit, filters.offset]
  );

  return { total, rows: rowsFromResult(listRes).map(parseTunnelIp) };
}

export async function statusBreakdown(range: DateRangeFilter): Promise<StatusCounts> {
  const { where, params } = combine(dateClauses('created_at', range));
  const result = await exec(
    `SELECT ${STATUS_SUMS} FROM agent_tasks ${where}`,
    params
  );
  const row = rowsFromResult(result)[0];
  return row ? statusCountsFromRow(row) : emptyStatusCounts();
}
