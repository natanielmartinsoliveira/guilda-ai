import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
const api = 'http://localhost:3000';
// Dev server: the API checks Origin on actions, so the proxy presents the API's own origin.
const proxy = { target: api, headers: { origin: api } };
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  build: { outDir: 'dist', modulePreload: { polyfill: false } },
  server: { proxy: { '/api': proxy, '/web-api': proxy } },
  // userEvent typing in jsdom is slow when every file runs in parallel on a loaded machine.
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], testTimeout: 20000 },
});
