import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, type RouteObject } from 'react-router';

import { ApiError } from '@/api/client';
import { Layout } from '@/components/Layout';
import { CreditsPage } from '@/pages/CreditsPage';
import { HealthPage } from '@/pages/HealthPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { OverviewPage } from '@/pages/OverviewPage';
import { RevenuePage } from '@/pages/RevenuePage';
import { ScansPage } from '@/pages/ScansPage';
import { UserDetailPage } from '@/pages/UserDetailPage';
import { UsersPage } from '@/pages/UsersPage';

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        // No refetches the admin did not ask for: they would count as
        // activity and keep an idle session alive. (Polling that is wanted,
        // like the health page, marks its requests as background instead.)
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        // A 4xx will not fix itself; only retry network and server errors.
        retry: (count, error) =>
          count < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
      },
    },
  });
}

function Root({ queryClient }: { queryClient: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
    </QueryClientProvider>
  );
}

/**
 * The dashboard opens directly, with no sign-in page and no client-side
 * route guard. That was never the security boundary: every /api/admin
 * request is authorised (or refused) by the server, and a refused request is
 * shown as an error on the page, never replaced with other data.
 */
export function buildRoutes(queryClient: QueryClient): RouteObject[] {
  return [
    {
      element: <Root queryClient={queryClient} />,
      children: [
        // Old bookmarks of the removed sign-in page.
        { path: '/login', element: <Navigate to="/" replace /> },
        {
          element: <Layout />,
          children: [
            { index: true, element: <OverviewPage /> },
            { path: 'users', element: <UsersPage /> },
            { path: 'users/:id', element: <UserDetailPage /> },
            { path: 'scans', element: <ScansPage /> },
            { path: 'credits', element: <CreditsPage /> },
            { path: 'revenue', element: <RevenuePage /> },
            { path: 'health', element: <HealthPage /> },
            { path: '*', element: <NotFoundPage /> },
          ],
        },
      ],
    },
  ];
}

export function App() {
  const [router] = useState(() => createBrowserRouter(buildRoutes(createQueryClient())));
  return <RouterProvider router={router} />;
}
