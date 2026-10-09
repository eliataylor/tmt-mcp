import {
  Alert,
  Box,
  Drawer,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { Column, DataTable } from '../components/DataTable';
import { JsonViewer } from '../components/JsonViewer';
import { StatusChip } from '../components/StatusChips';
import { useDb } from '../db/DbContext';
import { getTask, listTasks } from '../db/queries';
import { useDateRange } from '../hooks/useDateRange';
import type { AgentTaskListItem, AgentTaskRow, TaskStatus } from '../types';
import { TASK_STATUSES } from '../types';

const PAGE_SIZE_DEFAULT = 50;

export function TasksPage() {
  const { open } = useDb();
  const { range } = useDateRange();
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<AgentTaskListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(PAGE_SIZE_DEFAULT);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentTaskRow | null>(null);

  const status = (params.get('status') as TaskStatus | null) || null;
  const projectSlug = params.get('project') || null;
  const author = params.get('author') || null;
  const action = params.get('action') || null;

  const setFilter = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params);
      if (value) next.set(key, value);
      else next.delete(key);
      setParams(next, { replace: true });
      setPage(0);
    },
    [params, setParams]
  );

  useEffect(() => {
    if (!open) {
      setRows([]);
      setTotal(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await listTasks({
          ...range,
          status: status && TASK_STATUSES.includes(status) ? status : null,
          projectSlug,
          author,
          action,
          limit: rowsPerPage,
          offset: page * rowsPerPage,
        });
        if (!cancelled) {
          setRows(result.rows);
          setTotal(result.total);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, range, status, projectSlug, author, action, page, rowsPerPage]);

  const columns = useMemo<Column<AgentTaskListItem>[]>(
    () => [
      {
        id: 'created',
        label: 'Created',
        render: (r) => r.created_at,
        width: 150,
      },
      {
        id: 'status',
        label: 'Status',
        render: (r) => <StatusChip status={r.status} />,
      },
      { id: 'project', label: 'Project', render: (r) => r.project_slug },
      {
        id: 'issue',
        label: 'Issue',
        render: (r) => `#${r.github_issue_number}`,
      },
      {
        id: 'title',
        label: 'Title',
        render: (r) => (
          <Typography variant="body2" noWrap sx={{ maxWidth: 280 }}>
            {r.issue_title}
          </Typography>
        ),
      },
      { id: 'action', label: 'Action', render: (r) => r.action },
      { id: 'author', label: 'Author', render: (r) => r.author ?? '—' },
      {
        id: 'attempts',
        label: 'Attempts',
        align: 'right',
        render: (r) => `${r.attempts}/${r.max_attempts}`,
      },
      {
        id: 'tokens',
        label: 'Tokens',
        align: 'right',
        render: (r) => {
          if (!r.token_usage) return '—';
          const t = r.token_usage;
          return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
        },
      },
    ],
    []
  );

  if (!open) {
    return <Alert severity="info">Open a SQLite file to browse tasks.</Alert>;
  }

  return (
    <Box>
      <Typography variant="h5" gutterBottom>
        All tasks
      </Typography>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <FormControl size="small" sx={{ minWidth: 140 }}>
          <InputLabel>Status</InputLabel>
          <Select
            label="Status"
            value={status ?? ''}
            onChange={(e) => setFilter('status', e.target.value || null)}
          >
            <MenuItem value="">All</MenuItem>
            {TASK_STATUSES.map((s) => (
              <MenuItem key={s} value={s}>
                {s}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <TextField
          size="small"
          label="Project"
          value={projectSlug ?? ''}
          onChange={(e) => setFilter('project', e.target.value || null)}
        />
        <TextField
          size="small"
          label="Author"
          value={author ?? ''}
          onChange={(e) => setFilter('author', e.target.value || null)}
        />
        <TextField
          size="small"
          label="Action"
          value={action ?? ''}
          onChange={(e) => setFilter('action', e.target.value || null)}
        />
      </Stack>

      {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}

      <DataTable
        columns={columns}
        rows={rows}
        total={total}
        page={page}
        rowsPerPage={rowsPerPage}
        onPageChange={setPage}
        onRowsPerPageChange={(n) => {
          setRowsPerPage(n);
          setPage(0);
        }}
        getRowKey={(r) => r.id}
        onRowClick={async (r) => {
          const full = await getTask(r.id);
          setDetail(full);
        }}
      />

      <Drawer anchor="right" open={!!detail} onClose={() => setDetail(null)} PaperProps={{ sx: { width: { xs: '100%', sm: 480 } } }}>
        {detail ? (
          <Box sx={{ p: 2 }}>
            <Typography variant="h6" gutterBottom>
              {detail.issue_title}
            </Typography>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              {detail.project_slug} #{detail.github_issue_number} · {detail.action} ·{' '}
              <StatusChip status={detail.status} />
            </Typography>
            <Typography variant="caption" display="block" sx={{ mb: 2 }}>
              id {detail.id}
              {detail.author ? (
                <>
                  {' '}
                  · author{' '}
                  <Box
                    component={RouterLink}
                    to={`/tasks?author=${encodeURIComponent(detail.author)}`}
                    sx={{ color: 'primary.main' }}
                  >
                    {detail.author}
                  </Box>
                </>
              ) : null}
            </Typography>
            {detail.last_error ? (
              <Alert severity="warning" sx={{ mb: 2 }}>
                {detail.last_error}
              </Alert>
            ) : null}
            <JsonViewer label="token_usage (latest attempt)" value={detail.token_usage} />
            <JsonViewer label="context" value={detail.context} />
            <JsonViewer label="payload" value={detail.payload} />
          </Box>
        ) : null}
      </Drawer>
    </Box>
  );
}
