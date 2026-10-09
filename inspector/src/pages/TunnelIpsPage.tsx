import {
  Alert,
  Box,
  FormControlLabel,
  Switch,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import { Column, DataTable } from '../components/DataTable';
import { useDb } from '../db/DbContext';
import { listTunnelIps } from '../db/queries';
import { useDateRange } from '../hooks/useDateRange';
import type { TunnelIpRow } from '../types';

export function TunnelIpsPage() {
  const { open } = useDb();
  const { range } = useDateRange();
  const [rows, setRows] = useState<TunnelIpRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(50);
  const [unusualOnly, setUnusualOnly] = useState(false);
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
        const result = await listTunnelIps({
          ...range,
          unusualOnly,
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
  }, [open, range, unusualOnly, page, rowsPerPage]);

  const columns = useMemo<Column<TunnelIpRow>[]>(
    () => [
      { id: 'ip', label: 'IP', render: (r) => r.ip },
      { id: 'first', label: 'First seen', render: (r) => r.first_seen },
      { id: 'last', label: 'Last seen', render: (r) => r.last_seen },
      { id: 'hits', label: 'Hits', align: 'right', render: (r) => r.hits },
      {
        id: 'unusual',
        label: 'Unusual',
        align: 'right',
        render: (r) => r.unusual_hits,
      },
      { id: 'reason', label: 'Last reason', render: (r) => r.last_reason ?? '—' },
      {
        id: 'notified',
        label: 'Last notified',
        render: (r) => r.last_notified_at ?? '—',
      },
    ],
    []
  );

  if (!open) {
    return <Alert severity="info">Open a SQLite file to browse tunnel IPs.</Alert>;
  }

  return (
    <Box>
      <Typography variant="h5" gutterBottom>
        Tunnel IPs
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Date filter applies to <code>last_seen</code>.
      </Typography>
      <FormControlLabel
        control={
          <Switch
            checked={unusualOnly}
            onChange={(e) => {
              setUnusualOnly(e.target.checked);
              setPage(0);
            }}
          />
        }
        label="Unusual only"
        sx={{ mb: 2 }}
      />
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
        getRowKey={(r) => r.ip}
      />
    </Box>
  );
}
