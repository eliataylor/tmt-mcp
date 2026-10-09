import { exec, rowsFromResult } from './client';

export interface SchemaCaps {
  /** agent_tasks.token_usage — added via ensureAgentTaskColumns on queue boot. */
  hasTokenUsage: boolean;
}

let caps: SchemaCaps = { hasTokenUsage: true };

export function getSchemaCaps(): SchemaCaps {
  return caps;
}

export async function refreshSchemaCaps(): Promise<SchemaCaps> {
  const result = await exec(`PRAGMA table_info(agent_tasks)`);
  const cols = new Set(
    rowsFromResult(result).map((row) => String(row.name ?? ''))
  );
  caps = {
    hasTokenUsage: cols.has('token_usage'),
  };
  return caps;
}

export function resetSchemaCaps(): void {
  caps = { hasTokenUsage: true };
}

/** SELECT fragment: real column or NULL alias when the DB predates the migration. */
export function tokenUsageSelectExpr(): string {
  return caps.hasTokenUsage ? 'token_usage' : 'NULL AS token_usage';
}

/** Aggregation fragment for token sums (zeros when column absent). */
export function tokenSumsSelectExpr(): string {
  if (!caps.hasTokenUsage) {
    return `
      0 AS input_tokens,
      0 AS output_tokens,
      0 AS cache_read_tokens,
      0 AS cache_write_tokens
    `;
  }
  return `
    SUM(COALESCE(json_extract(token_usage, '$.inputTokens'), 0)) AS input_tokens,
    SUM(COALESCE(json_extract(token_usage, '$.outputTokens'), 0)) AS output_tokens,
    SUM(COALESCE(json_extract(token_usage, '$.cacheReadTokens'), 0)) AS cache_read_tokens,
    SUM(COALESCE(json_extract(token_usage, '$.cacheWriteTokens'), 0)) AS cache_write_tokens
  `;
}
