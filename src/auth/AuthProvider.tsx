import { useQueryClient } from '@tanstack/react-query';
import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { adminApi } from '@/api';
import { onAuthFailure } from '@/api/client';
import type { AdminSession } from '@/api/types';
import { clearSession, isExpired, loadSession, saveSession } from '@/auth/session';

type AuthContextValue = {
  session: AdminSession | null;
  /** Set when the API refused the token, so the login page can say why. */
  notice: string | null;
  signIn(session: AdminSession): void;
  signOut(): Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<AdminSession | null>(() => loadSession());
  const [notice, setNotice] = useState<string | null>(null);

  const drop = useCallback(
    (message: string | null) => {
      clearSession();
      // Cached admin data must not outlive the session that fetched it.
      queryClient.clear();
      setSession(null);
      setNotice(message);
    },
    [queryClient],
  );

  useEffect(
    () =>
      onAuthFailure((status) =>
        drop(
          status === 403
            ? 'This account does not have admin access.'
            : 'Your session has expired. Sign in again.',
        ),
      ),
    [drop],
  );

  // Sign out on expiry even if the tab sits idle and makes no requests.
  useEffect(() => {
    if (!session) return;
    const check = () => {
      if (isExpired(session)) drop('Your session has expired. Sign in again.');
    };
    const timer = window.setInterval(check, 30_000);
    return () => window.clearInterval(timer);
  }, [session, drop]);

  const signIn = useCallback((next: AdminSession) => {
    saveSession(next);
    setNotice(null);
    setSession(next);
  }, []);

  const signOut = useCallback(async () => {
    try {
      // Lets the backend revoke the token; the UI signs out regardless.
      await adminApi.logout();
    } catch {
      // Already expired or offline: nothing more to do.
    }
    drop(null);
  }, [drop]);

  const value = useMemo(
    () => ({ session, notice, signIn, signOut }),
    [session, notice, signIn, signOut],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth() {
  const value = use(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>.');
  return value;
}
