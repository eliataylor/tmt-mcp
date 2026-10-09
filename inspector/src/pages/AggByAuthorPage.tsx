import { Alert, Box, Typography } from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Column, DataTable } from '../components/DataTable';
import { StatusChips } from '../components/StatusChips';
import { TimelineChart } from '../components/TimelineChart';
import { useDb } from '../db/DbContext';
import { aggByAuthor } from '../db/queries';
import { useDateRange } from '../hooks/useDateRange';
import { writeDateRangeToSearch } from '../lib/dateRange';
import type { AggByAuthorRow, TimelineBucket } from '../types';

export function AggByAuthorPage() {
  const { open } = useDb();
  const { range } = useDateRange();
  const navigate = useNavigate();
  const [rows, setRows] = useState<AggByAuthorRow[]>([]);
  const [timeline, setTimeline] = useState<TimelineBucket[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setRows([]);
      setTimeline([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await aggByAuthor(range);
        if (!cancelled) {
          setRows(result.rows);
          setTimeline(result.timeline);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, range]);

  const columns = useMemo<Column<AggByAuthorRow>[]>(
    () => [
      { id: 'author', label: 'Author', render: (r) => r.author },
      {
        id: 'count',
        label: 'Tasks',
        align: 'right',
        render: (r) => r.taskCount,
      },
      {
        id: 'status',
        label: 'Status',
        render: (r) => <StatusChips counts={r.statusCounts} />,
      },
      {
        id: 'tokens',
        label: 'Total tokens',
        align: 'right',
        render: (r) => r.tokens.totalTokens.toLocaleString(),
      },
      {
        id: 'in',
        label: 'In',
        align: 'right',
        render: (r) => r.tokens.inputTokens.toLocaleString(),
      },
      {
        id: 'out',
        label: 'Out',
        align: 'right',
        render: (r) => r.tokens.outputTokens.toLocaleString(),
      },
      {
        id: 'cache',
        label: 'Cache R/W',
        align: 'right',
        render: (r) =>
          `${r.tokens.cacheReadTokens.toLocaleString()} / ${r.tokens.cacheWriteTokens.toLocaleString()}`,
      },
    ],
    []
  );

  if (!open) {
    return <Alert severity="info">Open a SQLite file to view aggregations.</Alert>;
  }

  return (
    <Box>
      <Typography variant="h5" gutterBottom>
        By author
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Grouped by <code>context.issue.author</code>. Token totals use the latest attempt only
        (column is overwritten on each complete/fail). Click a row to filter tasks.
      </Typography>
      {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}
      <Box sx={{ mb: 3 }}>
        <TimelineChart buckets={timeline} />
      </Box>
      <DataTable
        columns={columns}
        rows={rows}
        total={rows.length}
        page={0}
        rowsPerPage={rows.length || 25}
        onPageChange={() => undefined}
        onRowsPerPageChange={() => undefined}
        hidePagination
        getRowKey={(r) => r.author}
        onRowClick={(r) => {
          const next = writeDateRangeToSearch(new URLSearchParams(), range);
          next.set('author', r.author);
          navigate(`/tasks?${next.toString()}`);
        }}
      />
    </Box>
  );
}
