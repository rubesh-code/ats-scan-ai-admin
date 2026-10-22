import { describe, expect, it } from 'vitest';

import { isValidUsername, normalizeUsername, usernameKey } from '../src/identity.js';
import { PasswordHasher, passwordProblem, PRODUCTION_ARGON2 } from '../src/password.js';
import { FixedWindowLimiter } from '../src/rate-limit.js';
import { hashToken, isWellFormedToken, newSessionToken } from '../src/tokens.js';
import { FAST_ARGON2 } from './helpers.js';

describe('password hashing', () => {
  it('uses Argon2id with the production parameters', async () => {
    const encoded = await new PasswordHasher(PRODUCTION_ARGON2).hash('a long and unguessable passphrase');
    expect(encoded).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  });

  it('salts every hash and verifies only the right password', async () => {
    const hasher = new PasswordHasher(FAST_ARGON2);
    const [a, b] = await Promise.all([hasher.hash('same password'), hasher.hash('same password')]);
    expect(a).not.toBe(b);
    expect(await hasher.verify(a, 'same password')).toBe(true);
    expect(await hasher.verify(a, 'Same password')).toBe(false);
  });

  it('treats a malformed stored hash as a failed verification', async () => {
    expect(await new PasswordHasher(FAST_ARGON2).verify('not-a-hash', 'x')).toBe(false);
  });

  it.each([
    ['short', 'Password must be at least 15 characters.'],
    [' leading space passphrase', 'Password must not start or end with whitespace.'],
    ['abababababababababab', 'Password is too repetitive.'],
    ['alice-is-my-long-password', 'Password must not contain the username.'],
    ['a long and unguessable passphrase', null],
  ])('policy for %j', (password, problem) => {
    expect(passwordProblem(password, 'alice')).toBe(problem);
  });
});

describe('session tokens', () => {
  it('are 256-bit, URL-safe and unique', () => {
    const tokens = new Set(Array.from({ length: 1000 }, newSessionToken));
    expect(tokens.size).toBe(1000);
    for (const token of tokens) expect(isWellFormedToken(token)).toBe(true);
  });

  it('hash to 64 hex characters', () => {
    expect(hashToken(newSessionToken())).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([undefined, '', 'short', `${'A'.repeat(42)}=`, 'A'.repeat(44), `${'A'.repeat(42)};`])(
    'rejects %j before any database lookup',
    (value) => {
      expect(isWellFormedToken(value)).toBe(false);
    },
  );
});

describe('usernames', () => {
  it('normalises case, width and surrounding space', () => {
    expect(normalizeUsername('  ＡＬＩＣＥ ')).toBe('alice');
  });

  it('validates the stored form', () => {
    expect(isValidUsername('ops.admin-1')).toBe(true);
    expect(isValidUsername('ab')).toBe(false);
    expect(isValidUsername('.alice')).toBe(false);
  });

  it('keys lockouts by a hash, never the typed text', () => {
    expect(usernameKey('alice')).toMatch(/^[0-9a-f]{64}$/);
    expect(usernameKey('alice')).toBe(usernameKey('alice'));
    expect(usernameKey('alice')).not.toBe(usernameKey('bob'));
  });
});

describe('fixed-window limiter', () => {
  it('allows the limit, refuses beyond it, and resets with the window', () => {
    const limiter = new FixedWindowLimiter(3, 1000);
    const counts = [0, 1, 2, 3].map(() => limiter.hit('k', 0));
    expect(counts.map((c) => limiter.isOver(c))).toEqual([false, false, false, true]);
    expect(limiter.isFirstRefusal(counts[3]!)).toBe(true);
    expect(limiter.isFirstRefusal(limiter.hit('k', 10))).toBe(false);
    expect(limiter.isOver(limiter.hit('k', 1000))).toBe(false);
  });

  it('keeps keys independent', () => {
    const limiter = new FixedWindowLimiter(1, 1000);
    limiter.hit('a', 0);
    expect(limiter.isOver(limiter.hit('b', 0))).toBe(false);
  });

  it('stays bounded in memory', () => {
    const limiter = new FixedWindowLimiter(1, 1000, 100);
    for (let i = 0; i < 1000; i += 1) limiter.hit(`ip${i}`, 0);
    expect((limiter as unknown as { buckets: Map<string, unknown> }).buckets.size).toBeLessThanOrEqual(100);
  });
});
