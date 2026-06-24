import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Emitted to backoffice/dist, served as static assets by the read-only server
// (src/backoffice). base './' keeps asset URLs relative so the bundle works
// behind `tailscale serve` regardless of the mount path. The dev server
// proxies /api to the local read-only server (pnpm backoffice on :8787).
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    css: false,
  },
});
