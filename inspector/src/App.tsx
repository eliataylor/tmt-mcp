import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { DbProvider } from './db/DbContext';
import { AppShell } from './layout/AppShell';
import { AggByActionPage } from './pages/AggByActionPage';
import { AggByAuthorPage } from './pages/AggByAuthorPage';
import { TasksPage } from './pages/TasksPage';
import { TunnelHitsPage } from './pages/TunnelHitsPage';
import { TunnelIpsPage } from './pages/TunnelIpsPage';

const theme = createTheme({
  typography: {
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
  },
  palette: {
    mode: 'light',
    primary: { main: '#1b4d3e' },
    secondary: { main: '#b45309' },
    background: { default: '#f7f7f5' },
  },
  shape: { borderRadius: 6 },
});

export default function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <DbProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<Navigate to="/tasks" replace />} />
              <Route path="tasks" element={<TasksPage />} />
              <Route path="agg/by-author" element={<AggByAuthorPage />} />
              <Route path="agg/by-action" element={<AggByActionPage />} />
              <Route path="tunnel/hits" element={<TunnelHitsPage />} />
              <Route path="tunnel/ips" element={<TunnelIpsPage />} />
              <Route path="*" element={<Navigate to="/tasks" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </DbProvider>
    </ThemeProvider>
  );
}
