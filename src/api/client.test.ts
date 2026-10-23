import { describe, expect, it, vi } from 'vitest';

import { httpAdminApi } from '@/api/admin';
import { ApiError, BACKGROUND_HEADER, buildUrl, onUnauthorized, request } from '@/api/client';

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fn = vi.fn(
    async () =>
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
      }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

function sent(fetch: ReturnType<typeof mockFetch>, call = 0) {
  const [url, init] = fetch.mock.calls[call] as unknown as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
}

const session = {
  admin: { id: 'adm_1', username: 'owner', role: 'owner' },
  expiresAt: '2026-10-22T17:00:00.000Z',
  idleExpiresAt: '2026-10-22T09:30:00.000Z',
};

describe('buildUrl', () => {
  it('drops empty query values and keeps the path relative', () => {
    expect(buildUrl('/api/admin/users', { page: 2, search: '', status: undefined, q: 'a b' })).toBe(
      '/api/admin/users?page=2&q=a+b',
    );
  });
});

describe('request: cookie authentication', () => {
  it('sends the session cookie (same-origin credentials) and no Authorization header', async () => {
    const fetch = mockFetch(200, session);
    await request('/api/admin/auth/me');

    const { url, init, headers } = sent(fetch);
    expect(url).toBe('/api/admin/auth/me');
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('authorization');
    expect(headers.Accept).toBe('application/json');
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('calls the API without any prior client-side session (the cookie is the session)', async () => {
    const fetch = mockFetch(200, { ok: true });
    await request('/api/admin/users');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never reads or writes sessionStorage or localStorage', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    mockFetch(200, session);
    await httpAdminApi.login('owner', 'a long and unguessable passphrase');
    await httpAdminApi.me();
    mockFetch(204, null);
    await httpAdminApi.logout();
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    get.mockRestore();
    set.mockRestore();
  });

  it('sends state-changing requests as JSON POSTs', async () => {
    const fetch = mockFetch(200, session);
    await httpAdminApi.login('owner', 'pw');
    const { url, init, headers } = sent(fetch);
    expect(url).toBe('/api/admin/auth/login');
    expect(init.method).toBe('POST');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ username: 'owner', password: 'pw' });
  });

  it('logs out with a body-less POST and accepts 204', async () => {
    const fetch = mockFetch(204, null);
    await expect(httpAdminApi.logout()).resolves.toBeUndefined();
    const { url, init } = sent(fetch);
    expect(url).toBe('/api/admin/auth/logout');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('checks the session at /api/admin/auth/me', async () => {
    const fetch = mockFetch(200, session);
    await expect(httpAdminApi.me()).resolves.toEqual(session);
    expect(sent(fetch).url).toBe('/api/admin/auth/me');
  });

  it('marks background requests so they do not extend the idle timeout', async () => {
    const fetch = mockFetch(200, session);
    await httpAdminApi.me({ background: true });
    await httpAdminApi.me();
    await httpAdminApi.health({ background: true });
    expect(sent(fetch, 0).headers[BACKGROUND_HEADER]).toBe('1');
    expect(sent(fetch, 1).headers[BACKGROUND_HEADER]).toBeUndefined();
    expect(sent(fetch, 2).headers[BACKGROUND_HEADER]).toBe('1');
  });
});

describe('request: errors', () => {
  it('signs out (notifies) on 401 from an ordinary call', async () => {
    mockFetch(401, { error: 'Authentication required.' });
    const listener = vi.fn();
    const stop = onUnauthorized(listener);
    await expect(request('/api/admin/users')).rejects.toMatchObject({ status: 401 });
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not treat a wrong password (401 from login) as an expired session', async () => {
    mockFetch(401, { error: 'Invalid username or password.' });
    const listener = vi.fn();
    const stop = onUnauthorized(listener);
    await expect(httpAdminApi.login('owner', 'wrong')).rejects.toMatchObject({
      status: 401,
      message: 'Invalid username or password.',
    });
    expect(listener).not.toHaveBeenCalled();
    stop();
  });

  it('does not signal sign-out for the startup check or logout', async () => {
    const listener = vi.fn();
    const stop = onUnauthorized(listener);
    mockFetch(401, { error: 'Authentication required.' });
    await expect(httpAdminApi.me({ startup: true })).rejects.toMatchObject({ status: 401 });
    await expect(httpAdminApi.logout()).rejects.toMatchObject({ status: 401 });
    expect(listener).not.toHaveBeenCalled();
    stop();
  });

  it('does not sign out on 403, and surfaces the server message', async () => {
    mockFetch(403, { error: 'Cross-origin request refused.' });
    const listener = vi.fn();
    const stop = onUnauthorized(listener);
    await expect(request('/api/admin/users')).rejects.toMatchObject({
      status: 403,
      message: 'Cross-origin request refused.',
    });
    expect(listener).not.toHaveBeenCalled();
    stop();
  });

  it('reads Retry-After from a 429', async () => {
    mockFetch(429, { error: 'Too many attempts. Try again later.' }, { 'Retry-After': '60' });
    const error = await httpAdminApi.login('owner', 'pw').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, retryAfterSeconds: 60, message: 'Too many attempts. Try again later.' });
  });

  it('ignores a Retry-After that is not a number of seconds', async () => {
    mockFetch(429, { error: 'Too many attempts. Try again later.' }, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' });
    await expect(httpAdminApi.login('owner', 'pw')).rejects.toMatchObject({ retryAfterSeconds: null });
  });

  it('surfaces the server message on other errors', async () => {
    mockFetch(500, { error: 'Internal error.' });
    await expect(request('/api/admin/users')).rejects.toMatchObject({ status: 500, message: 'Internal error.' });
  });

  it('uses a generic message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>blocked</html>', { status: 502 })));
    await expect(request('/api/admin/users')).rejects.toMatchObject({ message: 'Request failed (502).' });
  });
});

describe('same-origin only', () => {
  it('refuses an API base URL on another origin, where the cookie would not be sent', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.net');
    vi.resetModules();
    try {
      const client = await import('@/api/client');
      const fetch = mockFetch(200, {});
      await expect(client.request('/api/admin/auth/me')).rejects.toMatchObject({ status: 0 });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('allows a same-origin path prefix', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '/prefix/');
    vi.resetModules();
    try {
      const client = await import('@/api/client');
      expect(client.buildUrl('/api/admin/auth/me')).toBe('/prefix/api/admin/auth/me');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
