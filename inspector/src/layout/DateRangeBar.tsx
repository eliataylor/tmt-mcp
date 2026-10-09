import { Box, Button, Stack, TextField, Typography } from '@mui/material';
import { useDateRange } from '../hooks/useDateRange';
import { inputValueToSqlite, sqliteToInputValue } from '../lib/dateRange';

export function DateRangeBar() {
  const { range, setRange, setAllTime, resetDefault, allTime } = useDateRange();

  return (
    <Box sx={{ px: 2, py: 1.5, borderBottom: 1, borderColor: 'divider', bgcolor: 'grey.50' }}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }} flexWrap="wrap" useFlexGap>
        <Typography variant="subtitle2" sx={{ minWidth: 88 }}>
          Time range
        </Typography>
        <TextField
          label="From (UTC)"
          type="datetime-local"
          size="small"
          value={sqliteToInputValue(range.from)}
          onChange={(e) =>
            setRange({ ...range, from: inputValueToSqlite(e.target.value) })
          }
          InputLabelProps={{ shrink: true }}
          sx={{ minWidth: 220 }}
        />
        <TextField
          label="To (UTC)"
          type="datetime-local"
          size="small"
          value={sqliteToInputValue(range.to)}
          onChange={(e) => setRange({ ...range, to: inputValueToSqlite(e.target.value) })}
          InputLabelProps={{ shrink: true }}
          sx={{ minWidth: 220 }}
        />
        <Button size="small" variant={allTime ? 'contained' : 'outlined'} onClick={setAllTime}>
          All time
        </Button>
        <Button size="small" variant="text" onClick={resetDefault}>
          Last 7 days
        </Button>
        <Typography variant="caption" color="text.secondary">
          Applies to every view (tasks · aggs · tunnel). SQLite UTC datetime text.
        </Typography>
      </Stack>
    </Box>
  );
}
