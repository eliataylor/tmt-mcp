import { Alert, Box, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import { Column, DataTable } from '../components/DataTable';
import { useDb } from '../db/DbContext';
import { listTunnelHits } from '../db/queries';
import { useDateRange } from '../hooks/useDateRange';
import type { TunnelHitRow } from '../types';

export function TunnelHitsPage() {
  const { open } = useDb();
  const { range } = useDateRange();
  const [rows, setRows] = useState<TunnelHitRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(50);
  const [reason, setReason] = useState('');
  const [ip, setIp] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setRows([]);
      setTotal(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await listTunnelHits({
          ...range,
          reason: reason || null,
          ip: ip || null,
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
  }, [open, range, reason, ip, page, rowsPerPage]);

  const columns = useMemo<Column<TunnelHitRow>[]>(
    () => [
      { id: 'id', label: 'ID', align: 'right', render: (r) => r.id },
      { id: 'created', label: 'Created', render: (r) => r.created_at },
      { id: 'ip', label: 'IP', render: (r) => r.ip },
      { id: 'method', label: 'Method', render: (r) => r.method },
      { id: 'path', label: 'Path', render: (r) => r.path },
      { id: 'status', label: 'Status', align: 'right', render: (r) => r.status },
      { id: 'reason', label: 'Reason', render: (r) => r.reason },
      {
        id: 'ua',
        label: 'User agent',
        render: (r) => (
          <Typography variant="body2" noWrap sx={{ maxWidth: 240 }}>
            {r.user_agent ?? '—'}
          </Typography>
        ),
      },
    ],
    []
  );

  if (!open) {
    return <Alert severity="info">Open a SQLite file to browse tunnel hits.</Alert>;
  }

  return (
    <Box>
      <Typography variant="h5" gutterBottom>
        Tunnel hits
      </Typography>
      <Stack direction="row" spacing={1.5} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <TextField
          size="small"
          label="Reason"
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setPage(0);
          }}
        />
        <TextField
          size="small"
          label="IP"
          value={ip}
          onChange={(e) => {
            setIp(e.target.value);
            setPage(0);
          }}
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
      />
    </Box>
  );
}
