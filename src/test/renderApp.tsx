import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';

import { setAdminApiForTests } from '@/api';
import type { AdminApi } from '@/api/admin';
import type { AdminSession } from '@/api/types';
import { buildRoutes, createQueryClient } from '@/App';
import { saveSession } from '@/auth/session';

export const testSession: AdminSession = {
  token: 'test-token',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  admin: { id: 'adm_1', email: 'owner@example.com', role: 'owner' },
};

const notStubbed = (name: string) => () => Promise.reject(new Error(`adminApi.${name} not stubbed`));

/** An AdminApi where every call fails unless the test provides it. */
export function fakeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  const base = Object.fromEntries(
    (
      [
        'sendOtp', 'verifyOtp', 'me', 'logout', 'overview', 'users', 'user', 'scans', 'scanSummary',
        'creditTransactions', 'creditSummary', 'payments', 'paymentSummary', 'health',
      ] as const
    ).map((name) => [name, vi.fn(notStubbed(name))]),
  ) as unknown as AdminApi;
  return { ...base, ...overrides };
}

export function renderApp(path: string, { api = fakeApi(), signedIn = false } = {}) {
  setAdminApiForTests(api);
  if (signedIn) saveSession(testSession);

  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 0 } });
  const router = createMemoryRouter(buildRoutes(queryClient), { initialEntries: [path] });
  return { ...render(<RouterProvider router={router} />), router, api };
}
