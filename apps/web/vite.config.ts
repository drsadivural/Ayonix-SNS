import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Worker (wrangler dev on :8787) serves the API, auth, MCP, OAuth and
// webhooks. In production wrangler serves apps/web/dist as static assets
// with SPA fallback, so these paths are same-origin in both environments.
const WORKER = 'http://localhost:8787';
const proxied = ['/api', '/mcp', '/oauth', '/authorize', '/auth', '/u', '/.well-known', '/webhooks', '/health', '/dev'];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(proxied.map((p) => [p, { target: WORKER, changeOrigin: false }])),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
});
