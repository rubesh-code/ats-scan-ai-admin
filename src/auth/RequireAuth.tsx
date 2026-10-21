import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';

import { useAuth } from '@/auth/AuthProvider';

/**
 * Keeps signed-out visitors off dashboard routes. This is a convenience, not
 * the security boundary: every /api/admin request is authorised server-side.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const location = useLocation();

  if (!session) {
    const from = `${location.pathname}${location.search}`;
    return <Navigate to="/login" replace state={{ from }} />;
  }
  return children;
}
