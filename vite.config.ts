/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * The dashboard is served on 127.0.0.1 only. It is never bound to a public
 * interface: on the server it is reached through an SSH tunnel until
 * admin.atsscanai.com and Cloudflare Access are in place (docs/deployment.md).
 *
 * The default port is 5070, not 5060: Chrome, Edge and Firefox refuse to load
 * http:// on 5060/5061 (SIP ports, blocked against NAT slipstreaming) and show
 * ERR_UNSAFE_PORT. Override with ADMIN_PORT.
 *
 * In development `/api` is proxied to the ATS Scan AI backend, so the browser
 * talks to one origin and the backend needs no extra CORS origin.
 */
const BROWSER_BLOCKED_PORTS = new Set([5060, 5061]);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.ADMIN_API_PROXY_TARGET || 'http://127.0.0.1:5000';
  const port = Number(env.ADMIN_PORT) || 5070;
  if (BROWSER_BLOCKED_PORTS.has(port)) {
    throw new Error(`ADMIN_PORT=${port} is blocked by web browsers (ERR_UNSAFE_PORT). Pick another port.`);
  }

  return {
    plugins: [react()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
      },
    },
    preview: {
      host: '127.0.0.1',
      port,
      strictPort: true,
    },
    build: {
      sourcemap: false,
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      css: false,
    },
  };
});
