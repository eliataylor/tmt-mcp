import {
  AppBar,
  Box,
  Drawer,
  List,
  ListItemButton,
  ListItemText,
  Toolbar,
  Typography,
} from '@mui/material';
import { NavLink, Outlet, useSearchParams } from 'react-router-dom';
import { NAV_ITEMS } from '../types';
import { DateRangeBar } from './DateRangeBar';
import { OpenDbBar } from './OpenDbBar';

const DRAWER_WIDTH = 200;

export function AppShell() {
  const [searchParams] = useSearchParams();
  const sharedQs = searchParams.toString();

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar
        position="fixed"
        elevation={0}
        color="inherit"
        sx={{
          zIndex: (t) => t.zIndex.drawer + 1,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Toolbar variant="dense">
          <Typography variant="h6" sx={{ fontWeight: 700, letterSpacing: '-0.02em' }}>
            tmt queue inspector
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ ml: 2 }}>
            local · read-only · in-browser SQLite
          </Typography>
        </Toolbar>
      </AppBar>

      <Drawer
        variant="permanent"
        sx={{
          width: DRAWER_WIDTH,
          flexShrink: 0,
          [`& .MuiDrawer-paper`]: {
            width: DRAWER_WIDTH,
            boxSizing: 'border-box',
            borderRight: 1,
            borderColor: 'divider',
          },
        }}
      >
        <Toolbar variant="dense" />
        <List dense sx={{ pt: 1 }}>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.path}
              to={sharedQs ? `${item.path}?${sharedQs}` : item.path}
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              {({ isActive }) => (
                <ListItemButton
                  selected={isActive}
                  sx={{
                    '&.Mui-selected': {
                      borderRight: 3,
                      borderColor: 'primary.main',
                    },
                  }}
                >
                  <ListItemText primary={item.label} />
                </ListItemButton>
              )}
            </NavLink>
          ))}
        </List>
      </Drawer>

      <Box component="main" sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Toolbar variant="dense" />
        <OpenDbBar />
        <DateRangeBar />
        <Box sx={{ p: 2, flexGrow: 1 }}>
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
}
