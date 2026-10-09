import { Box, Typography } from '@mui/material';
import type { TimelineBucket } from '../types';

export function TimelineChart({ buckets }: { buckets: TimelineBucket[] }) {
  if (!buckets.length) {
    return (
      <Typography variant="body2" color="text.secondary">
        No tasks in this range.
      </Typography>
    );
  }

  const maxCount = Math.max(...buckets.map((b) => b.taskCount), 1);
  const maxTokens = Math.max(...buckets.map((b) => b.tokens.totalTokens), 1);

  return (
    <Box>
      <Typography variant="subtitle2" gutterBottom>
        Daily timeline (count bars · token line scale)
      </Typography>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 0.5,
          height: 140,
          overflowX: 'auto',
          pb: 1,
        }}
      >
        {buckets.map((b) => {
          const h = (b.taskCount / maxCount) * 100;
          const tokenH = (b.tokens.totalTokens / maxTokens) * 100;
          return (
            <Box
              key={b.day}
              title={`${b.day}: ${b.taskCount} tasks, ${b.tokens.totalTokens} tokens`}
              sx={{
                flex: '0 0 28px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                height: '100%',
                justifyContent: 'flex-end',
              }}
            >
              <Box sx={{ position: 'relative', width: '100%', height: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: '2px' }}>
                <Box
                  sx={{
                    width: 10,
                    height: `${h}%`,
                    minHeight: b.taskCount ? 2 : 0,
                    bgcolor: 'primary.main',
                    borderRadius: '2px 2px 0 0',
                  }}
                />
                <Box
                  sx={{
                    width: 10,
                    height: `${tokenH}%`,
                    minHeight: b.tokens.totalTokens ? 2 : 0,
                    bgcolor: 'secondary.main',
                    borderRadius: '2px 2px 0 0',
                    opacity: 0.7,
                  }}
                />
              </Box>
              <Typography variant="caption" sx={{ writingMode: 'vertical-rl', fontSize: 9, mt: 0.5 }}>
                {b.day.slice(5)}
              </Typography>
            </Box>
          );
        })}
      </Box>
      <Typography variant="caption" color="text.secondary">
        Primary = task count · Secondary = total tokens (latest attempt per task)
      </Typography>
    </Box>
  );
}
