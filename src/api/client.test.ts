import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, buildUrl, onAuthFailure, request } from '@/api/client';
import { loadSession, saveSession } from '@/auth/session';

function signedIn() {
  saveSession({
    token: 'secret-token',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    admin: { id: 'adm_1', email: 'a@example.com', role: 'admin' },
  });
}

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildUrl', () => {
  it('drops empty query values and keeps the path relative', () => {
    expect(buildUrl('/api/admin/users', { page: 2, search: '', status: undefined, q: 'a b' })).toBe(
      '/api/admin/users?page=2&q=a+b',
    );
  });
});

describe('request', () => {
  it('sends the admin token as a bearer header', async () => {
    signedIn();
    const fetch = mockFetch(200, { ok: true });
    await request('/api/admin/me');

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
    expect(init.credentials).toBe('omit');
  });

  it('does not call the API at all without a session', async () => {
    const fetch = mockFetch(200, {});
    const listener = vi.fn();
    const stop = onAuthFailure(listener);

    await expect(request('/api/admin/me')).rejects.toMatchObject({ status: 401 });
    expect(fetch).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledWith(401);
    stop();
  });

  it.each([401, 403])('clears the session and notifies on %i', async (status) => {
    signedIn();
    mockFetch(status, { error: 'nope' });
    const listener = vi.fn();
    const stop = onAuthFailure(listener);

    await expect(request('/api/admin/users')).rejects.toBeInstanceOf(ApiError);
    expect(loadSession()).toBeNull();
    expect(listener).toHaveBeenCalledWith(status);
    stop();
  });

  it('keeps the session on other errors and surfaces the server message', async () => {
    signedIn();
    mockFetch(500, { error: 'Database unavailable.' });

    await expect(request('/api/admin/users')).rejects.toMatchObject({
      status: 500,
      message: 'Database unavailable.',
    });
    expect(loadSession()).not.toBeNull();
  });

  it('uses a generic message when the error body is not JSON', async () => {
    signedIn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>blocked</html>', { status: 502 })));

    await expect(request('/api/admin/users')).rejects.toMatchObject({ message: 'Request failed (502).' });
  });

  it('login calls do not need or send a token', async () => {
    const fetch = mockFetch(200, {});
    await request('/api/admin/auth/send-otp', { method: 'POST', body: { email: 'a@example.com' }, auth: false });

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
