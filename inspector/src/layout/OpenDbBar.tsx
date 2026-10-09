import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import RefreshIcon from '@mui/icons-material/Refresh';
import StorageIcon from '@mui/icons-material/Storage';
import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/material';
import { useRef } from 'react';
import { useDb } from '../db/DbContext';
import { formatBytes } from '../db/parse';
import { getSchemaCaps } from '../db/schema';

export function OpenDbBar() {
  const { meta, counts, error, loading, loadFile, loadDefault, reload, open } = useDb();
  const inputRef = useRef<HTMLInputElement>(null);
  const caps = open ? getSchemaCaps() : null;

  return (
    <Box sx={{ px: 2, py: 1.5, borderBottom: 1, borderColor: 'divider' }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} flexWrap="wrap" useFlexGap>
        <Stack direction="row" spacing={1} alignItems="center">
          <StorageIcon fontSize="small" color="action" />
          <Typography variant="subtitle2">Queue DB</Typography>
        </Stack>
        <Button
          size="small"
          variant="contained"
          startIcon={<FolderOpenIcon />}
          onClick={() => inputRef.current?.click()}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Open file'}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept=".db,application/x-sqlite3,application/octet-stream"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void loadFile(file).catch(() => undefined);
            e.target.value = '';
          }}
        />
        <Button size="small" variant="outlined" onClick={() => void loadDefault().catch(() => undefined)} disabled={loading}>
          Load default
        </Button>
        <Button
          size="small"
          variant="text"
          startIcon={<RefreshIcon />}
          onClick={() => void reload().catch(() => undefined)}
          disabled={loading || !open}
        >
          Reload
        </Button>
        {meta ? (
          <Chip
            size="small"
            label={`${meta.fileName} · ${formatBytes(meta.byteLength)}`}
            variant="outlined"
          />
        ) : (
          <Typography variant="body2" color="text.secondary">
            No database loaded
          </Typography>
        )}
        {counts ? (
          <Typography variant="caption" color="text.secondary">
            tasks {counts.agent_tasks} · hits {counts.tunnel_hits} · ips {counts.tunnel_ips}
          </Typography>
        ) : null}
        {caps && !caps.hasTokenUsage ? (
          <Chip
            size="small"
            color="warning"
            variant="outlined"
            label="token_usage column missing — restart queue server to migrate"
          />
        ) : null}
      </Stack>
      {error ? (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      ) : null}
    </Box>
  );
}
