import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { httpAdminApi } from '@/api/admin';
import { ApiError } from '@/api/client';
import type { Page, UserSummary } from '@/api/types';
import { loadSession } from '@/auth/session';
import { fakeApi, renderApp, testSession } from '@/test/renderApp';

const emptyUsers: Page<UserSummary> = { items: [], page: 1, pageSize: 25, total: 0 };

describe('auth flow', () => {
  it('sends signed-out visitors to the login page', async () => {
    const { router } = renderApp('/revenue');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('signs in with an emailed code and returns to the requested page', async () => {
    const api = fakeApi({
      sendOtp: vi.fn(async () => undefined),
      verifyOtp: vi.fn(async () => testSession),
      users: vi.fn(async () => emptyUsers),
    });
    const { router } = renderApp('/users', { api });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Email'), ' Owner@Example.com ');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(api.sendOtp).toHaveBeenCalledWith('owner@example.com');

    await user.type(await screen.findByLabelText('Code'), '654321');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(api.verifyOtp).toHaveBeenCalledWith('owner@example.com', '654321');
    await waitFor(() => expect(router.state.location.pathname).toBe('/users'));
    expect(loadSession()?.token).toBe(testSession.token);
  });

  it('shows the server error for a wrong code and stays signed out', async () => {
    const api = fakeApi({
      sendOtp: vi.fn(async () => undefined),
      verifyOtp: vi.fn(async () => {
        throw new ApiError(401, 'Incorrect or expired code.');
      }),
    });
    renderApp('/', { api });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Email'), 'owner@example.com');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByLabelText('Code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect or expired code.');
    expect(loadSession()).toBeNull();
  });

  it('ignores a return path that points off-site', async () => {
    const api = fakeApi({
      sendOtp: vi.fn(async () => undefined),
      verifyOtp: vi.fn(async () => testSession),
      overview: vi.fn(() => new Promise<never>(() => {})),
    });
    const { router } = renderApp('/login', { api });
    await router.navigate('/login', { state: { from: '//evil.example.com' } });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Email'), 'owner@example.com');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByLabelText('Code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('signs out and explains when the API says the account is not an admin', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })),
    );
    const { router } = renderApp('/users', { api: httpAdminApi, signedIn: true });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('This account does not have admin access.');
    expect(router.state.location.pathname).toBe('/login');
    expect(loadSession()).toBeNull();
    vi.unstubAllGlobals();
  });
});
