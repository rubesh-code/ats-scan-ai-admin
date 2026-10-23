import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';

import { setAdminApiForTests } from '@/api';
import type { AdminApi } from '@/api/admin';
import { buildRoutes, createQueryClient } from '@/App';

const notStubbed = (name: string) => () => Promise.reject(new Error(`adminApi.${name} not stubbed`));

/** An AdminApi where every call fails unless the test provides it. */
export function fakeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  const base = Object.fromEntries(
    (
      [
        'login', 'me', 'logout', 'overview', 'users', 'user', 'scans', 'scanSummary',
        'creditTransactions', 'creditSummary', 'payments', 'paymentSummary', 'health',
      ] as const
    ).map((name) => [name, vi.fn(notStubbed(name))]),
  ) as unknown as AdminApi;
  return { ...base, ...overrides };
}

/** Renders the app at `path`, as opening (or refreshing) that URL would. */
export function renderApp(path: string, { api = fakeApi() } = {}) {
  setAdminApiForTests(api);
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 0 } });
  const router = createMemoryRouter(buildRoutes(queryClient), { initialEntries: [path] });
  return { ...render(<RouterProvider router={router} />), router, api, queryClient };
}
