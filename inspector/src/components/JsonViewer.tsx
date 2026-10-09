import { Box, Typography } from '@mui/material';

export function JsonViewer({ value, label }: { value: unknown; label?: string }) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }

  return (
    <Box sx={{ mb: 2 }}>
      {label ? (
        <Typography variant="subtitle2" color="text.secondary" gutterBottom>
          {label}
        </Typography>
      ) : null}
      <Box
        component="pre"
        sx={{
          m: 0,
          p: 1.5,
          borderRadius: 1,
          bgcolor: 'grey.100',
          overflow: 'auto',
          maxHeight: 360,
          fontSize: 12,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        }}
      >
        {text}
      </Box>
    </Box>
  );
}
