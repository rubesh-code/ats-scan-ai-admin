import type { ProxyOptions } from 'vite';
import { describe, expect, it } from 'vitest';

import { ADMIN_API, ANY_API, authServiceTarget, DEFAULT_AUTH_SERVICE, devProxy, DevProxyError } from './dev-proxy.ts';

/** Mirrors Vite's matching: keys starting with ^ are regexes, first match in key order wins. */
function route(proxy: Record<string, ProxyOptions>, url: string): string | null {
  for (const key of Object.keys(proxy)) {
    const matches = key.startsWith('^') ? new RegExp(key).test(url) : url.startsWith(key);
    if (matches) return key;
  }
  return null;
}

describe('dev proxy routing', () => {
  const proxy = devProxy({});

  it.each([
    '/api/admin/auth/login',
    '/api/admin/auth/me',
    '/api/admin/auth/logout',
    '/api/admin/overview?range=30d',
    '/api/admin',
    '/api/admin?x=1',
  ])('sends %s to the admin auth service', (url) => {
    expect(route(proxy, url)).toBe(ADMIN_API);
    expect(proxy[ADMIN_API]).toMatchObject({ target: DEFAULT_AUTH_SERVICE, changeOrigin: false });
  });

  it.each(['/api/user', '/api/payments/verify', '/api/administrator', '/api/adminx/auth/login', '/api', '/api?x=1'])(
    'answers %s with 404 and never forwards it',
    (url) => {
      expect(route(proxy, url)).toBe(ANY_API);
      // Vite treats bypass() === false as "respond 404 here, do not proxy".
      const bypass = proxy[ANY_API]?.bypass as unknown as () => unknown;
      expect(bypass()).toBe(false);
    },
  );

  it.each(['/', '/users', '/login', '/assets/app.js', '/apix'])('leaves app route %s to Vite', (url) => {
    expect(route(proxy, url)).toBeNull();
  });

  it('never targets the customer backend by default', () => {
    for (const options of Object.values(proxy)) expect(options.target).toBe('http://127.0.0.1:5071');
  });

  it('keeps the Host header the auth service checks (changeOrigin is off)', () => {
    expect(proxy[ADMIN_API]?.changeOrigin).toBe(false);
  });
});

describe('dev proxy target', () => {
  it.each([
    ['http://127.0.0.1:5072', 'http://127.0.0.1:5072'],
    ['http://localhost:5071/', 'http://localhost:5071'],
    ['http://[::1]:5071', 'http://[::1]:5071'],
    [undefined, DEFAULT_AUTH_SERVICE],
    ['  ', DEFAULT_AUTH_SERVICE],
  ])('accepts %s', (raw, expected) => {
    expect(authServiceTarget(raw)).toBe(expected);
  });

  it.each([
    'https://127.0.0.1:5071',
    'http://10.0.0.5:5071',
    'http://admin.atsscanai.com',
    'http://127.0.0.1:5071/api',
    'http://u:p@127.0.0.1:5071',
    'not a url',
  ])('refuses %s', (raw) => {
    expect(() => authServiceTarget(raw)).toThrow(DevProxyError);
  });

  it('refuses the old variable that pointed /api at the customer backend', () => {
    expect(() => devProxy({ ADMIN_API_PROXY_TARGET: 'http://127.0.0.1:5000' })).toThrow(/no longer used/);
  });
});
