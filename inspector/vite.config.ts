import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const sqliteRoot = path.resolve(root, '../sqlite_data');

/** Serve ../sqlite_data at /sqlite_data for “Load default” (loopback only). */
function serveSqliteData(): Plugin {
  return {
    name: 'serve-sqlite-data',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (!url.startsWith('/sqlite_data/')) return next();
        const rel = decodeURIComponent(url.slice('/sqlite_data/'.length));
        const filePath = path.resolve(sqliteRoot, rel);
        if (!filePath.startsWith(sqliteRoot) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        fs.createReadStream(filePath).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serveSqliteData()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: {
      allow: [root, sqliteRoot],
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 5173,
  },
  optimizeDeps: {
    // Prebundle the CJS wasm build (not the package "browser" export).
    include: ['sql.js > sql.js/dist/sql-wasm.js', 'sql.js/dist/sql-wasm.js'],
  },
  assetsInclude: ['**/*.wasm'],
});
