import { createHash } from 'node:crypto';

export const ADMIN_ROLES = ['owner', 'admin', 'viewer'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export function isAdminRole(value: string): value is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(value);
}

/** Matches the CHECK constraint on admin_auth.accounts.username. */
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;

/** Login is case-insensitive: "Alice " and "alice" are the same account. */
export function normalizeUsername(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

export function isValidUsername(normalized: string): boolean {
  return USERNAME_PATTERN.test(normalized);
}

/**
 * Key for failure counting and lockout. Computed for every attempted username,
 * existing or not, so the lockout tables never hold what was typed into the
 * username box (sometimes a password, pasted into the wrong field).
 */
export function usernameKey(normalized: string): string {
  return createHash('sha256').update(`ats-admin-login:${normalized}`, 'utf8').digest('hex');
}
