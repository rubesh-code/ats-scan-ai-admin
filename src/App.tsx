import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { createBrowserRouter, Outlet, RouterProvider, type RouteObject } from 'react-router';

import { ApiError } from '@/api/client';
import { AuthProvider } from '@/auth/AuthProvider';
import { LoginPage } from '@/auth/LoginPage';
import { RequireAuth } from '@/auth/RequireAuth';
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
        refetchOnWindowFocus: false,
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
      <AuthProvider>
        <Outlet />
      </AuthProvider>
    </QueryClientProvider>
  );
}

export function buildRoutes(queryClient: QueryClient): RouteObject[] {
  return [
    {
      element: <Root queryClient={queryClient} />,
      children: [
        { path: '/login', element: <LoginPage /> },
        {
          element: (
            <RequireAuth>
              <Layout />
            </RequireAuth>
          ),
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
