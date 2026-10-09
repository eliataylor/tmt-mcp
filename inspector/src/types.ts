/** Constrained agent_tasks.status values (schema CHECK). */
export type TaskStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const TASK_STATUSES: readonly TaskStatus[] = [
  'pending',
  'processing',
  'completed',
  'failed',
  'cancelled',
] as const;

/** Latest-attempt CLI usage stored in agent_tasks.token_usage. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** agent_tasks list projection (no payload/context blobs). */
export interface AgentTaskListItem {
  id: string;
  delivery_id: string | null;
  repo_full_name: string | null;
  project_slug: string;
  github_issue_id: number;
  github_issue_number: number;
  issue_title: string;
  action: string;
  status: TaskStatus;
  attempts: number;
  max_attempts: number;
  available_at: string;
  locked_by: string | null;
  locked_at: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  token_usage: TokenUsage | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  /** From context.issue.author when available. */
  author: string | null;
}

/** Full agent_tasks row for the detail drawer. */
export interface AgentTaskRow extends AgentTaskListItem {
  payload: unknown;
  context: unknown;
}

export interface TunnelHitRow {
  id: number;
  ip: string;
  method: string;
  path: string;
  status: number;
  reason: string;
  user_agent: string | null;
  created_at: string;
}

export interface TunnelIpRow {
  ip: string;
  first_seen: string;
  last_seen: string;
  hits: number;
  unusual_hits: number;
  last_reason: string | null;
  last_notified_at: string | null;
  last_notified_hit_id: number | null;
}

/**
 * Shared URL + query window.
 * Values are SQLite datetime text ('YYYY-MM-DD HH:MM:SS', UTC).
 * Null bounds = all time.
 */
export interface DateRangeFilter {
  from: string | null;
  to: string | null;
}

export interface Pagination {
  limit: number;
  offset: number;
}

export interface TaskListFilters extends DateRangeFilter, Pagination {
  status?: TaskStatus | null;
  projectSlug?: string | null;
  author?: string | null;
  action?: string | null;
}

export interface TunnelHitFilters extends DateRangeFilter, Pagination {
  reason?: string | null;
  ip?: string | null;
}

export interface TunnelIpFilters extends DateRangeFilter, Pagination {
  unusualOnly?: boolean;
}

export interface StatusCounts {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface AggByAuthorRow {
  author: string;
  taskCount: number;
  statusCounts: StatusCounts;
  tokens: TokenTotals;
}

export interface AggByActionRow {
  action: string;
  taskCount: number;
  statusCounts: StatusCounts;
  tokens: TokenTotals;
}

export interface TimelineBucket {
  day: string;
  taskCount: number;
  tokens: TokenTotals;
}

export interface AggResult {
  rows: AggByAuthorRow[] | AggByActionRow[];
  timeline: TimelineBucket[];
}

export interface PaginatedResult<T> {
  rows: T[];
  total: number;
}

export interface DbMeta {
  fileName: string;
  byteLength: number;
  loadedAt: string;
}

export interface TableCounts {
  agent_tasks: number;
  tunnel_hits: number;
  tunnel_ips: number;
}

export type NavPath =
  | '/tasks'
  | '/agg/by-author'
  | '/agg/by-action'
  | '/tunnel/hits'
  | '/tunnel/ips';

export interface NavItem {
  path: NavPath;
  label: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { path: '/tasks', label: 'Tasks' },
  { path: '/agg/by-author', label: 'By author' },
  { path: '/agg/by-action', label: 'By action' },
  { path: '/tunnel/hits', label: 'Tunnel hits' },
  { path: '/tunnel/ips', label: 'Tunnel IPs' },
] as const;

export const UNKNOWN_AUTHOR = '(unknown)';

export type SqlValue = string | number | null | Uint8Array;
export type SqlParams = Array<string | number | null>;

export interface QueryResult {
  columns: string[];
  values: SqlValue[][];
}
