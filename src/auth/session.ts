import type { AdminSession } from '@/api/types';

/**
 * The admin token lives in sessionStorage, not localStorage: it is scoped to
 * this tab and gone when the tab closes, so a forgotten browser does not stay
 * signed in. The backend still enforces expiry and admin membership on every
 * request; this file only decides what the UI shows.
 */
const KEY = 'ats-admin.session';

/** Sign out slightly before the server would reject the token. */
const EXPIRY_SKEW_MS = 30_000;

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isSession(value: unknown): value is AdminSession {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const admin = v.admin as Record<string, unknown> | undefined;
  return (
    typeof v.token === 'string' &&
    v.token.length > 0 &&
    typeof v.expiresAt === 'string' &&
    !Number.isNaN(Date.parse(v.expiresAt)) &&
    !!admin &&
    typeof admin.id === 'string' &&
    typeof admin.email === 'string'
  );
}

export function isExpired(session: AdminSession, now = Date.now()) {
  return Date.parse(session.expiresAt) - EXPIRY_SKEW_MS <= now;
}

export function loadSession(now = Date.now()): AdminSession | null {
  const raw = storage()?.getItem(KEY);
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (isSession(parsed) && !isExpired(parsed, now)) return parsed;
  } catch {
    // Corrupt entry: fall through and clear it.
  }
  clearSession();
  return null;
}

export function saveSession(session: AdminSession) {
  storage()?.setItem(KEY, JSON.stringify(session));
}

export function clearSession() {
  storage()?.removeItem(KEY);
}
