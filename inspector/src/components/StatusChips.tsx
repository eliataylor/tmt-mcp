import { Chip, Stack } from '@mui/material';
import type { StatusCounts, TaskStatus } from '../types';
import { TASK_STATUSES } from '../types';

const COLOR: Record<TaskStatus, 'default' | 'info' | 'success' | 'error' | 'warning'> = {
  pending: 'default',
  processing: 'info',
  completed: 'success',
  failed: 'error',
  cancelled: 'warning',
};

export function StatusChips({ counts }: { counts: StatusCounts }) {
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
      {TASK_STATUSES.map((status) => {
        const n = counts[status];
        if (!n) return null;
        return (
          <Chip
            key={status}
            size="small"
            label={`${status}: ${n}`}
            color={COLOR[status]}
            variant="outlined"
          />
        );
      })}
    </Stack>
  );
}

export function StatusChip({ status }: { status: TaskStatus }) {
  return <Chip size="small" label={status} color={COLOR[status]} variant="outlined" />;
}
