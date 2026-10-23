import type { ProxyOptions } from 'vite';

/**
 * Development proxy for `npm run dev` (and `vite preview`).
 *
 * Only /api/admin goes anywhere: to the admin auth service, which in
 * development listens on loopback TCP (auth-service/README.md). Every other
 * /api path is answered here with 404 and never forwarded - in particular
 * never to the customer backend, which the dashboard must not talk to.
 *
 * The Host header is passed through unchanged (changeOrigin: false): the auth
 * service answers only the exact host of an allowed origin, such as
 * ats-admin.localhost:5070, and the browser's Origin header passes through
 * as sent. Nothing here relaxes those checks.
 */

export const DEFAULT_AUTH_SERVICE = 'http://127.0.0.1:5071';

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

export class DevProxyError extends Error {}

/** The auth service in development is always on this machine, over plain http. */
export function authServiceTarget(raw: string | undefined): string {
  const value = raw?.trim() || DEFAULT_AUTH_SERVICE;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DevProxyError(`ADMIN_AUTH_PROXY_TARGET is not a URL: ${value}`);
  }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.pathname !== '/' || url.search || url.username) {
    throw new DevProxyError(
      `ADMIN_AUTH_PROXY_TARGET must be http://127.0.0.1:<port> (the local admin auth service), got ${value}`,
    );
  }
  return url.origin;
}

/** Keys starting with ^ are regular expressions; Vite tries them in this order and uses the first match. */
export const ADMIN_API = '^/api/admin(/|$|\\?)';
export const ANY_API = '^/api(/|$|\\?)';

export function devProxy(env: Record<string, string | undefined>): Record<string, ProxyOptions> {
  if (env.ADMIN_API_PROXY_TARGET) {
    // The old variable pointed /api at the customer backend (127.0.0.1:5000).
    throw new DevProxyError(
      'ADMIN_API_PROXY_TARGET is no longer used. Remove it from your .env.local; set ADMIN_AUTH_PROXY_TARGET to the local admin auth service if it is not on 127.0.0.1:5071.',
    );
  }
  const target = authServiceTarget(env.ADMIN_AUTH_PROXY_TARGET);
  return {
    [ADMIN_API]: { target, changeOrigin: false },
    [ANY_API]: {
      target,
      // Returning false makes Vite answer 404 itself; the request is never proxied.
      bypass: () => false,
    },
  };
}
