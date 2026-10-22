import { createHash, randomBytes } from 'node:crypto';

/** 256 bits from the OS CSPRNG, base64url: always 43 characters. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Rejects anything that could not have come from newSessionToken before touching the database. */
export function isWellFormedToken(value: string | undefined): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/**
 * Only this hash is stored. The token has 256 bits of entropy, so a plain
 * SHA-256 (no salt, no slow hash) is enough: a leaked sessions table cannot be
 * turned back into usable cookies.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
