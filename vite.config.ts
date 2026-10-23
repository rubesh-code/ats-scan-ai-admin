/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { configDefaults } from 'vitest/config';

import { devProxy } from './dev-proxy.ts';

/**
 * The dashboard is served on 127.0.0.1 only. It is never bound to a public
 * interface: on the server it is reached through an SSH tunnel until
 * admin.atsscanai.com and Cloudflare Access are in place (docs/deployment.md).
 *
 * The default port is 5070, not 5060: Chrome, Edge and Firefox refuse to load
 * http:// on 5060/5061 (SIP ports, blocked against NAT slipstreaming) and show
 * ERR_UNSAFE_PORT. Override with ADMIN_PORT. strictPort means a port already
 * in use (for example by an SSH tunnel) is an error, never silently changed.
 *
 * Open the dashboard at http://ats-admin.localhost:<port>, not 127.0.0.1: the
 * auth service accepts plain-http origins only on *.localhost, and its
 * __Host- cookie is bound to that host.
 *
 * In development only /api/admin is proxied, to the admin auth service; any
 * other /api path gets 404 from the dev server (see dev-proxy.ts).
 */
const BROWSER_BLOCKED_PORTS = new Set([5060, 5061]);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const port = Number(env.ADMIN_PORT) || 5070;
  if (BROWSER_BLOCKED_PORTS.has(port)) {
    throw new Error(`ADMIN_PORT=${port} is blocked by web browsers (ERR_UNSAFE_PORT). Pick another port.`);
  }
  const proxy = devProxy(env);

  return {
    plugins: [react()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      proxy,
    },
    preview: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      proxy,
    },
    build: {
      sourcemap: false,
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      // auth-service/ is a separate Node package with its own test runner config.
      exclude: [...configDefaults.exclude, 'auth-service/**'],
    },
  };
});
