import type {
  AgentTaskListItem,
  AgentTaskRow,
  StatusCounts,
  TaskStatus,
  TokenTotals,
  TokenUsage,
  TunnelHitRow,
  TunnelIpRow,
} from '../types';
import { TASK_STATUSES } from '../types';

function asString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  return String(v);
}

function asStringOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = asString(v);
  return s === '' ? null : s;
}

function asNumber(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asNumberOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = asNumber(v, Number.NaN);
  return Number.isFinite(n) ? n : null;
}

function decodeJsonBlob(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === 'object' && !(v instanceof Uint8Array)) return v;
  const text = asString(v);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function parseTokenUsage(raw: unknown): TokenUsage | null {
  if (raw == null || raw === '') return null;
  let obj: unknown = raw;
  if (typeof raw === 'string' || raw instanceof Uint8Array) {
    try {
      obj = JSON.parse(asString(raw));
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
  const out: Partial<TokenUsage> = {};
  for (const key of keys) {
    const n = o[key];
    if (!Number.isInteger(n) || (n as number) < 0) return null;
    out[key] = n as number;
  }
  return out as TokenUsage;
}

function asTaskStatus(v: unknown): TaskStatus {
  const s = asString(v);
  if ((TASK_STATUSES as readonly string[]).includes(s)) return s as TaskStatus;
  return 'pending';
}

export function parseTaskListItem(row: Record<string, unknown>): AgentTaskListItem {
  return {
    id: asString(row.id),
    delivery_id: asStringOrNull(row.delivery_id),
    repo_full_name: asStringOrNull(row.repo_full_name),
    project_slug: asString(row.project_slug),
    github_issue_id: asNumber(row.github_issue_id),
    github_issue_number: asNumber(row.github_issue_number),
    issue_title: asString(row.issue_title),
    action: asString(row.action),
    status: asTaskStatus(row.status),
    attempts: asNumber(row.attempts),
    max_attempts: asNumber(row.max_attempts),
    available_at: asString(row.available_at),
    locked_by: asStringOrNull(row.locked_by),
    locked_at: asStringOrNull(row.locked_at),
    lease_expires_at: asStringOrNull(row.lease_expires_at),
    last_error: asStringOrNull(row.last_error),
    token_usage: parseTokenUsage(row.token_usage),
    completed_at: asStringOrNull(row.completed_at),
    created_at: asString(row.created_at),
    updated_at: asString(row.updated_at),
    author: asStringOrNull(row.author),
  };
}

export function parseTaskRow(row: Record<string, unknown>): AgentTaskRow {
  return {
    ...parseTaskListItem(row),
    payload: decodeJsonBlob(row.payload),
    context: decodeJsonBlob(row.context),
  };
}

export function parseTunnelHit(row: Record<string, unknown>): TunnelHitRow {
  return {
    id: asNumber(row.id),
    ip: asString(row.ip),
    method: asString(row.method),
    path: asString(row.path),
    status: asNumber(row.status),
    reason: asString(row.reason),
    user_agent: asStringOrNull(row.user_agent),
    created_at: asString(row.created_at),
  };
}

export function parseTunnelIp(row: Record<string, unknown>): TunnelIpRow {
  return {
    ip: asString(row.ip),
    first_seen: asString(row.first_seen),
    last_seen: asString(row.last_seen),
    hits: asNumber(row.hits),
    unusual_hits: asNumber(row.unusual_hits),
    last_reason: asStringOrNull(row.last_reason),
    last_notified_at: asStringOrNull(row.last_notified_at),
    last_notified_hit_id: asNumberOrNull(row.last_notified_hit_id),
  };
}

export function emptyStatusCounts(): StatusCounts {
  return {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
}

export function tokenTotalsFromParts(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number
): TokenTotals {
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
