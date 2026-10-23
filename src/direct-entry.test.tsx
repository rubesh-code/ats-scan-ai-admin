import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { httpAdminApi } from '@/api/admin';
import type { Page, UserSummary } from '@/api/types';
import { fakeApi, renderApp } from '@/test/renderApp';

const emptyUsers: Page<UserSummary> = { items: [], page: 1, pageSize: 25, total: 0 };
const pending = () => new Promise<never>(() => {});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** fetch replaced by a fixed answer per path; records every call. */
function stubFetch(answer: (path: string) => Response) {
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => answer(url.split('?')[0]!));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('direct entry (no sign-in page)', () => {
  it('opens the dashboard at / without a sign-in page or session check', async () => {
    const api = fakeApi({ overview: vi.fn(pending) });
    const { router } = renderApp('/', { api });

    expect(await screen.findByRole('heading', { name: 'Overview', level: 1 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull();
    expect(screen.queryByLabelText(/username|password/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
    expect(api.overview).toHaveBeenCalled();
    expect(api.me).not.toHaveBeenCalled();
    expect(api.login).not.toHaveBeenCalled();
  });

  it('sends old /login links to the dashboard', async () => {
    const { router } = renderApp('/login', { api: fakeApi({ overview: vi.fn(pending) }) });
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(await screen.findByRole('heading', { name: 'Overview', level: 1 })).toBeInTheDocument();
  });

  it.each([
    ['/users', 'Users'],
    ['/scans', 'Scans'],
    ['/credits', 'Credits'],
    ['/revenue', 'Revenue'],
    ['/health', 'System health'],
  ])('loads %s directly, as a refresh would', async (path, title) => {
    const api = fakeApi(
      Object.fromEntries(
        ['users', 'scans', 'scanSummary', 'creditTransactions', 'creditSummary', 'payments', 'paymentSummary', 'health'].map(
          (name) => [name, vi.fn(pending)],
        ),
      ),
    );
    const { router } = renderApp(path, { api });
    expect(await screen.findByRole('heading', { name: title, level: 1 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(path);
  });

  it('loads a user detail URL directly', async () => {
    const user = vi.fn(pending);
    renderApp('/users/usr_42', { api: fakeApi({ user }) });
    await waitFor(() => expect(user).toHaveBeenCalledWith('usr_42'));
  });

  it('navigates between pages from the sidebar', async () => {
    const api = fakeApi({ overview: vi.fn(pending), users: vi.fn(async () => emptyUsers), health: vi.fn(pending) });
    const { router } = renderApp('/', { api });
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const user = userEvent.setup();

    await user.click(within(nav).getByRole('link', { name: 'Users' }));
    expect(await screen.findByRole('table', { name: 'Users' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/users');

    await user.click(within(nav).getByRole('link', { name: 'System health' }));
    expect(await screen.findByRole('heading', { name: 'System health', level: 1 })).toBeInTheDocument();

    await user.click(within(nav).getByRole('link', { name: 'Overview' }));
    expect(router.state.location.pathname).toBe('/');
  });

  it('shows unknown paths inside the dashboard as not found', async () => {
    renderApp('/nope');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  });
});

describe('server refusals are reported, never replaced with data (real HTTP client)', () => {
  it('explains a 401 from the admin API and stays on the page', async () => {
    const fetch = stubFetch(() => json(401, { error: 'Authentication required.' }));
    const { router } = renderApp('/users', { api: httpAdminApi });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The admin API refused this request');
    expect(alert).toHaveTextContent('No data is shown.');
    expect(screen.queryByRole('table')).toBeNull();
    expect(router.state.location.pathname).toBe('/users');
    // Only the page's own data call: no session check, no sign-in, no retry loop.
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/admin/users?page=1&pageSize=25']);
  });

  it('sends no Authorization header or stored token, only same-origin credentials', async () => {
    const fetch = stubFetch(() => json(401, { error: 'Authentication required.' }));
    renderApp('/users', { api: httpAdminApi });
    await screen.findByRole('alert');

    const init = fetch.mock.calls[0]![1]!;
    expect(init.credentials).toBe('same-origin');
    expect(Object.keys(init.headers as Record<string, string>).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it('explains a 403 with the server message', async () => {
    stubFetch(() => json(403, { error: 'Your admin role does not allow this.' }));
    renderApp('/revenue', { api: httpAdminApi });
    const alerts = await screen.findAllByRole('alert');
    expect(alerts[0]).toHaveTextContent('The admin API refused this request (403): Your admin role does not allow this.');
  });

  it('reports a web page where data was expected (no API deployed) instead of failing silently', async () => {
    stubFetch(
      () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    );
    renderApp('/', { api: httpAdminApi });
    expect(await screen.findByRole('alert')).toHaveTextContent('No admin API answered at this address');
  });

  it('reports an endpoint that is not built yet', async () => {
    stubFetch(() => json(404, { error: 'Not found.' }));
    renderApp('/scans', { api: httpAdminApi });
    const alerts = await screen.findAllByRole('alert');
    expect(alerts[0]).toHaveTextContent('This admin endpoint is not available on the backend yet.');
  });

  it('reports a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    renderApp('/', { api: httpAdminApi });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the admin API.');
  });
});
