import { createHash } from 'node:crypto';

import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { BACKGROUND_HEADER, buildApp, LOGGER_OPTIONS, SESSION_COOKIE, type AppDeps } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { PasswordHasher } from '../src/password.js';
import { AccountManager, AuthStore, type Db } from '../src/store.js';
import {
  asRole,
  createDatabase,
  dumpAll,
  failingOn,
  FAST_ARGON2,
  HOST,
  logSink,
  MINUTE,
  ORIGIN,
  resetData,
  TestClock,
} from './helpers.js';

const PASSWORD = 'correct horse battery staple 42';
const WRONG = 'definitely not the password';
/** Production listens on this socket; loadConfig only validates the path, nothing is created. */
const SOCKET_ENV = { ADMIN_AUTH_SOCKET: '/run/ats-admin-auth/auth.sock' };

type Context = {
  app: FastifyInstance;
  clock: TestClock;
  manager: AccountManager;
  logs: ReturnType<typeof logSink>;
  aliceId: string;
};

let db: PGlite;
let ctx: Context | undefined;

beforeAll(async () => {
  db = await createDatabase();
});
afterAll(async () => {
  await db.close();
});
afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

type SetupOptions = Partial<Pick<AppDeps, 'protectedRoutes'>> & {
  env?: Record<string, string>;
  /** Wraps the service's database handle, e.g. for fault injection. */
  wrapDb?: (db: Db) => Db;
};

async function setup(options: SetupOptions = {}): Promise<Context> {
  await resetData(db);
  const clock = new TestClock();
  const passwords = new PasswordHasher(FAST_ARGON2);
  const manager = new AccountManager(asRole(db, 'ats_admin_auth_manager'));
  const appDb = asRole(db, 'ats_admin_auth_app');
  const logs = logSink();
  const app = await buildApp({
    config: loadConfig({ ADMIN_AUTH_ALLOWED_ORIGINS: ORIGIN, ...options.env }),
    store: new AuthStore(options.wrapDb ? options.wrapDb(appDb) : appDb),
    passwords,
    now: clock.now,
    logger: { ...LOGGER_OPTIONS, level: 'debug', stream: logs.stream },
    ...(options.protectedRoutes ? { protectedRoutes: options.protectedRoutes } : {}),
  });
  const aliceId = await manager.createAccount('alice', await passwords.hash(PASSWORD), 'owner', operator(clock));
  ctx = { app, clock, manager, logs, aliceId };
  return ctx;
}

function operator(clock: TestClock) {
  return { at: clock.now(), actor: 'operator' };
}

/** The context of the test that is running; setup() must have been called. */
function current(): Context {
  if (!ctx) throw new Error('setup() was not called');
  return ctx;
}

function login(
  app: FastifyInstance,
  username = 'alice',
  password = PASSWORD,
  headers: Record<string, string> = {},
  remoteAddress?: string,
) {
  return app.inject({
    method: 'POST',
    url: '/api/admin/auth/login',
    headers: { host: HOST, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers },
    payload: JSON.stringify({ username, password }),
    ...(remoteAddress ? { remoteAddress } : {}),
  });
}

function get(app: FastifyInstance, url: string, token?: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'GET',
    url,
    headers: { host: HOST, ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}), ...headers },
  });
}

function logout(app: FastifyInstance, token?: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/admin/auth/logout',
    headers: { host: HOST, origin: ORIGIN, ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}), ...headers },
  });
}

function setCookie(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie'];
  const value = Array.isArray(header) ? header.find((h) => h.startsWith(`${SESSION_COOKIE}=`)) : header;
  if (!value) throw new Error('no session cookie set');
  return value;
}

function tokenOf(res: LightMyRequestResponse): string {
  const token = /^__Host-ats_admin=([^;]*)/.exec(setCookie(res))?.[1];
  if (!token) throw new Error('empty session cookie');
  return token;
}

async function signedIn() {
  const res = await login(current().app);
  expect(res.statusCode).toBe(200);
  return tokenOf(res);
}

async function count(sql: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) as q`);
  return rows[0]!.n;
}

describe('login', () => {
  it('sets a __Host- cookie that is HttpOnly, Secure, SameSite=Strict, Path=/ and host-only', async () => {
    await setup();
    const res = await login(current().app);
    expect(res.statusCode).toBe(200);

    const attributes = setCookie(res).split('; ');
    expect(attributes[0]).toMatch(/^__Host-ats_admin=[A-Za-z0-9_-]{43}$/);
    expect(attributes).toEqual(
      expect.arrayContaining(['Max-Age=28800', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']),
    );
    expect(attributes.some((a) => /^domain=/i.test(a))).toBe(false);

    expect(res.json()).toEqual({
      admin: { id: current().aliceId, username: 'alice', role: 'owner' },
      expiresAt: '2026-10-22T17:00:00.000Z',
      idleExpiresAt: '2026-10-22T09:30:00.000Z',
    });
  });

  it('stores only the SHA-256 of the session token', async () => {
    await setup();
    const token = tokenOf(await login(current().app));
    const { rows } = await db.query<{ token_hash: string }>('select token_hash from admin_auth.sessions');
    expect(rows).toEqual([{ token_hash: createHash('sha256').update(token).digest('hex') }]);
    expect(await dumpAll(db)).not.toContain(token);
  });

  it('accepts the username case-insensitively', async () => {
    await setup();
    expect((await login(current().app, '  Alice ')).statusCode).toBe(200);
  });

  it('gives identical answers for a wrong password and an unknown user', async () => {
    await setup();
    const wrong = await login(current().app, 'alice', WRONG);
    const unknown = await login(current().app, 'mallory', WRONG);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
    expect(wrong.json()).toEqual({ error: 'Invalid username or password.' });
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a disabled account even with the right password', async () => {
    await setup();
    await current().manager.setDisabled('alice', true, operator(current().clock));
    expect((await login(current().app)).statusCode).toBe(401);
  });

  it('rejects malformed bodies with a generic 400', async () => {
    await setup();
    for (const payload of [
      { username: 'alice' },
      { username: 'alice', password: PASSWORD, admin: true },
      { username: 'alice', password: 'x'.repeat(1025) },
      { username: 42, password: PASSWORD },
      { username: ['alice'], password: PASSWORD },
      { username: '', password: PASSWORD },
    ]) {
      const res = await current().app.inject({
        method: 'POST',
        url: '/api/admin/auth/login',
        headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'Invalid request.' });
    }
  });

  it('refuses bodies over 8 KiB', async () => {
    await setup();
    const res = await login(current().app, 'alice', 'x'.repeat(9000));
    expect(res.statusCode).toBe(413);
  });

  it('ends any session the browser already had (session fixation)', async () => {
    await setup();
    const first = await signedIn();
    const second = tokenOf(await login(current().app, 'alice', PASSWORD, { cookie: `${SESSION_COOKIE}=${first}` }));
    expect(second).not.toBe(first);
    expect((await get(current().app, '/api/admin/auth/me', first)).statusCode).toBe(401);
    expect((await get(current().app, '/api/admin/auth/me', second)).statusCode).toBe(200);
  });

  it('creates no session and sets no cookie if any part of a successful login fails', async () => {
    await setup({ wrapDb: (appDb) => failingOn(appDb, /insert into admin_auth\.audit_log/) });
    const res = await login(current().app);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal error.' });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await count('select 1 from admin_auth.sessions')).toBe(0);
    expect(current().logs.text()).not.toContain('secret-detail');
  });
});

describe('malformed usernames', () => {
  it.each([
    ['NUL', 'alice\u0000'],
    ['leading NUL', '\u0000alice'],
    ['bell', 'al\u0007ice'],
    ['escape sequence', '\u001b[31malice'],
    ['interior newline', 'ali\nce'],
    ['DEL', 'alice\u007f'],
    ['too long', 'a'.repeat(65)],
    ['non-ASCII', 'alïce'],
  ])('answers %s with a normal 401, counted and audited', async (_label, username) => {
    await setup();
    const res = await login(current().app, username, PASSWORD);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Invalid username or password.' });
    expect(await count('select 1 from admin_auth.login_failures')).toBe(1);
    const { rows } = await db.query('select event, account_id, detail from admin_auth.audit_log where event = $1', [
      'login_failure',
    ]);
    expect(rows).toEqual([{ event: 'login_failure', account_id: null, detail: { reason: 'invalid_username', locked: false } }]);
  });

  it('locks a malformed username like any other after 5 failures', async () => {
    await setup();
    for (let i = 0; i < 5; i += 1) expect((await login(current().app, 'x\u0000', WRONG)).statusCode).toBe(401);
    expect((await login(current().app, 'x\u0000', WRONG)).statusCode).toBe(429);
  });

  it('treats a NUL in the password as a wrong password', async () => {
    await setup();
    expect((await login(current().app, 'alice', `${PASSWORD}\u0000`)).statusCode).toBe(401);
  });
});

describe('origin and CSRF protection', () => {
  const badOrigins = [
    'http://evil.example',
    'https://ats-admin.localhost:5070',
    'http://ats-admin.localhost:5071',
    'http://localhost:5070',
    `${ORIGIN}/`,
    'null',
  ];

  it.each(badOrigins)('refuses login from Origin %s', async (origin) => {
    await setup();
    const res = await login(current().app, 'alice', PASSWORD, { origin });
    expect(res.statusCode).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuses state-changing requests without an Origin header', async () => {
    await setup();
    const res = await current().app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      headers: { host: HOST, 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'alice', password: PASSWORD }),
    });
    expect(res.statusCode).toBe(403);
  });

  it.each(['PUT', 'PATCH', 'DELETE'] as const)('requires the Origin check for %s too', async (method) => {
    await setup();
    const token = await signedIn();
    const res = await current().app.inject({
      method,
      url: '/api/admin/anything',
      headers: { host: HOST, origin: 'http://evil.example', cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it.each(['cross-site', 'same-site', 'none'])('refuses Sec-Fetch-Site: %s', async (site) => {
    await setup();
    expect((await login(current().app, 'alice', PASSWORD, { 'sec-fetch-site': site })).statusCode).toBe(403);
  });

  it('protects logout too, so another site cannot sign an admin out', async () => {
    await setup();
    const token = await signedIn();
    expect((await logout(current().app, token, { origin: 'http://evil.example' })).statusCode).toBe(403);
    expect((await get(current().app, '/api/admin/auth/me', token)).statusCode).toBe(200);
  });

  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'])(
    'refuses %s bodies (what a cross-site form can send without preflight)',
    async (type) => {
      await setup();
      const res = await login(current().app, 'alice', PASSWORD, { 'content-type': type });
      expect(res.statusCode).toBe(415);
    },
  );

  it('answers only the configured Host, and ignores X-Forwarded-Host', async () => {
    await setup();
    const app = current().app;
    expect((await get(app, '/api/admin/auth/me', undefined, { host: 'evil.example' })).statusCode).toBe(421);
    expect((await get(app, '/api/admin/auth/me', undefined, { host: 'localhost:5070' })).statusCode).toBe(421);
    expect(
      (await get(app, '/api/admin/auth/me', undefined, { host: '127.0.0.1:5071', 'x-forwarded-host': HOST })).statusCode,
    ).toBe(421);
  });

  it('never sends CORS headers', async () => {
    await setup();
    const preflight = await current().app.inject({
      method: 'OPTIONS',
      url: '/api/admin/auth/login',
      headers: { host: HOST, origin: 'http://evil.example', 'access-control-request-method': 'POST' },
    });
    const ok = await login(current().app);
    for (const res of [preflight, ok]) {
      expect(Object.keys(res.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
    }
  });
});

describe('session checks', () => {
  it('returns the current admin for a valid cookie', async () => {
    await setup();
    const token = await signedIn();
    const res = await get(current().app, '/api/admin/auth/me', token);
    expect(res.statusCode).toBe(200);
    expect(res.json().admin).toEqual({ id: current().aliceId, username: 'alice', role: 'owner' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects a missing, malformed or unknown cookie, and clears a bad one', async () => {
    await setup();
    expect((await get(current().app, '/api/admin/auth/me')).statusCode).toBe(401);
    for (const bad of ['short', 'A'.repeat(43)]) {
      const res = await get(current().app, '/api/admin/auth/me', bad);
      expect(res.statusCode).toBe(401);
      expect(setCookie(res)).toContain('Max-Age=0');
    }
  });

  it('expires after 30 minutes without activity', async () => {
    await setup();
    const token = await signedIn();
    const { app, clock } = current();
    clock.advance(29 * MINUTE);
    expect((await get(app, '/api/admin/auth/me', token)).statusCode).toBe(200);
    clock.advance(29 * MINUTE);
    expect((await get(app, '/api/admin/auth/me', token)).statusCode).toBe(200);
    clock.advance(30 * MINUTE + 1);
    expect((await get(app, '/api/admin/auth/me', token)).statusCode).toBe(401);
  });

  it('does not let background requests extend the idle window', async () => {
    await setup();
    const token = await signedIn();
    const { app, clock } = current();
    clock.advance(20 * MINUTE);
    expect((await get(app, '/api/admin/auth/me', token, { [BACKGROUND_HEADER]: '1' })).statusCode).toBe(200);
    clock.advance(10 * MINUTE + 1);
    expect((await get(app, '/api/admin/auth/me', token, { [BACKGROUND_HEADER]: '1' })).statusCode).toBe(401);
  });

  it('expires 8 hours after login however active the admin is', async () => {
    await setup();
    const token = await signedIn();
    const { app, clock } = current();
    for (let elapsed = 25; elapsed < 480; elapsed += 25) {
      clock.advance(25 * MINUTE);
      expect((await get(app, '/api/admin/auth/me', token)).statusCode).toBe(200);
    }
    clock.advance(25 * MINUTE);
    expect((await get(app, '/api/admin/auth/me', token)).statusCode).toBe(401);
  });

  it('ends existing sessions when the account is disabled', async () => {
    await setup();
    const token = await signedIn();
    await current().manager.setDisabled('alice', true, operator(current().clock));
    expect((await get(current().app, '/api/admin/auth/me', token)).statusCode).toBe(401);
  });

  it('ends existing sessions when the password is reset', async () => {
    await setup();
    const token = await signedIn();
    const hash = await new PasswordHasher(FAST_ARGON2).hash('a brand new long passphrase');
    await current().manager.resetPassword('alice', hash, operator(current().clock));
    expect((await get(current().app, '/api/admin/auth/me', token)).statusCode).toBe(401);
  });

  it('rejects a session from before a password reset even if deleting it never happened', async () => {
    await setup();
    const token = await signedIn();
    // Simulates a reset whose session deletion was lost: only the version moves.
    await db.exec(`update admin_auth.accounts set credential_version = credential_version + 1 where username = 'alice'`);
    expect(await count('select 1 from admin_auth.sessions')).toBe(1);
    expect((await get(current().app, '/api/admin/auth/me', token)).statusCode).toBe(401);
  });
});

describe('logout', () => {
  it('deletes the session server-side and clears the cookie', async () => {
    await setup();
    const token = await signedIn();
    const res = await logout(current().app, token);
    expect(res.statusCode).toBe(204);
    const cleared = setCookie(res).split('; ');
    expect(cleared[0]).toBe('__Host-ats_admin=');
    expect(cleared).toEqual(expect.arrayContaining(['Max-Age=0', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']));
    expect(await count('select 1 from admin_auth.sessions')).toBe(0);
    expect((await get(current().app, '/api/admin/auth/me', token)).statusCode).toBe(401);
  });

  it('succeeds without a session', async () => {
    await setup();
    expect((await logout(current().app)).statusCode).toBe(204);
  });

  it('keeps the session if the logout cannot be audited, so nothing happens unrecorded', async () => {
    await setup({ wrapDb: (appDb) => failingOn(appDb, /insert into admin_auth\.audit_log/) });
    await db.exec(`insert into admin_auth.sessions (token_hash, account_id, credential_version, created_at, last_seen_at, expires_at)
                   select '${createHash('sha256').update('T'.repeat(43)).digest('hex')}', id, 1, now(), now(), now() + interval '1 hour'
                     from admin_auth.accounts`);
    expect((await logout(current().app, 'T'.repeat(43))).statusCode).toBe(500);
    expect(await count('select 1 from admin_auth.sessions')).toBe(1);
  });
});

describe('deny-by-default routing', () => {
  it('answers 401 for any path without a session, including ones not built yet', async () => {
    await setup();
    const app = current().app;
    for (const url of ['/api/admin/overview', '/api/admin/users?page=1', '/api/admin/auth/login', '/api/admin/', '/', '/api/user']) {
      expect((await get(app, url)).statusCode).toBe(401);
    }
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('answers 401 for unauthenticated %s', async (method) => {
    await setup();
    const res = await current().app.inject({
      method,
      url: '/api/admin/users',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(401);
  });

  it('answers HEAD without a session with 401', async () => {
    await setup();
    const res = await current().app.inject({ method: 'HEAD', url: '/api/admin/auth/me', headers: { host: HOST } });
    expect(res.statusCode).toBe(401);
  });

  it('answers 404 for unbuilt paths once signed in (no dashboard data is served)', async () => {
    await setup();
    const token = await signedIn();
    expect((await get(current().app, '/api/admin/overview', token)).statusCode).toBe(404);
  });

  it('protects routes passed as protectedRoutes', async () => {
    let calls = 0;
    await setup({
      protectedRoutes: (scope) => {
        scope.get('/api/admin/example', async (request) => {
          calls += 1;
          return { username: request.adminSession?.username };
        });
      },
    });
    expect((await get(current().app, '/api/admin/example')).statusCode).toBe(401);
    expect(calls).toBe(0);
    const token = await signedIn();
    expect((await get(current().app, '/api/admin/example', token)).json()).toEqual({ username: 'alice' });
    expect(calls).toBe(1);
  });

  it('protects a route added directly to the app later, outside protectedRoutes', async () => {
    await setup();
    let calls = 0;
    current().app.get('/api/admin/added-later', async () => {
      calls += 1;
      return { ok: true };
    });
    expect((await get(current().app, '/api/admin/added-later')).statusCode).toBe(401);
    expect(calls).toBe(0);
    const token = await signedIn();
    expect((await get(current().app, '/api/admin/added-later', token)).statusCode).toBe(200);
  });

  it('refuses to start if any other route is marked public', async () => {
    await resetData(db);
    await expect(
      buildApp({
        config: loadConfig({ ADMIN_AUTH_ALLOWED_ORIGINS: ORIGIN }),
        store: new AuthStore(asRole(db, 'ats_admin_auth_app')),
        passwords: new PasswordHasher(FAST_ARGON2),
        logger: false,
        protectedRoutes: (scope) => {
          scope.get('/api/admin/overview', { config: { public: true } }, async () => ({}));
        },
      }),
    ).rejects.toThrow(/may not be public/);
  });
});

describe('account lockout', () => {
  it('locks the username for 15 minutes after 5 failures in 15 minutes', async () => {
    await setup();
    const { app, clock } = current();
    for (let i = 0; i < 5; i += 1) {
      expect((await login(app, 'alice', WRONG)).statusCode).toBe(401);
    }
    const locked = await login(app);
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toEqual({ error: 'Too many attempts. Try again later.' });
    expect(await count('select 1 from admin_auth.lockouts')).toBe(1);

    clock.advance(14 * MINUTE);
    expect((await login(app)).statusCode).toBe(429);
    clock.advance(MINUTE + 1);
    expect((await login(app)).statusCode).toBe(200);
    expect(await count('select 1 from admin_auth.login_failures')).toBe(0);
  });

  it('lets parallel attempts use at most 5 failures, then locks', async () => {
    await setup();
    const { app, clock } = current();
    // 10 at once: the per-address rate limit allows exactly 10 a minute.
    const results = await Promise.all(Array.from({ length: 10 }, () => login(app, 'alice', WRONG)));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(5);
    expect(await count('select 1 from admin_auth.login_failures')).toBe(5);

    clock.advance(MINUTE); // past the rate-limit window, inside the lock
    expect((await login(app)).statusCode).toBe(429);
    expect(await count('select 1 from admin_auth.lockouts')).toBe(1);
  });

  it('counts only failures inside the 15-minute window', async () => {
    await setup();
    const { app, clock } = current();
    for (let i = 0; i < 4; i += 1) await login(app, 'alice', WRONG);
    clock.advance(16 * MINUTE);
    for (let i = 0; i < 4; i += 1) await login(app, 'alice', WRONG);
    expect((await login(app)).statusCode).toBe(200);
  });

  it('locks unknown usernames the same way, so lockout reveals nothing', async () => {
    await setup();
    const { app, clock } = current();
    for (let i = 0; i < 5; i += 1) await login(app, 'mallory', WRONG);
    const unknown = await login(app, 'mallory', WRONG);
    clock.advance(MINUTE); // past the rate-limit window, still inside both locks
    for (let i = 0; i < 5; i += 1) await login(app, 'alice', WRONG);
    const known = await login(app, 'alice', WRONG);
    expect(unknown.statusCode).toBe(429);
    expect(known.statusCode).toBe(429);
    expect(unknown.json()).toEqual(known.json());
    expect(await count('select 1 from admin_auth.lockouts')).toBe(2);
    expect(await count(`select 1 from admin_auth.audit_log where event = 'login_rate_limited'`)).toBe(0);
  });

  it('does not sign out an admin who is already signed in', async () => {
    await setup();
    const token = await signedIn();
    for (let i = 0; i < 6; i += 1) await login(current().app, 'alice', WRONG);
    expect((await get(current().app, '/api/admin/auth/me', token)).statusCode).toBe(200);
  });

  it('does not extend the lock with attempts made while locked', async () => {
    await setup();
    const { app, clock } = current();
    for (let i = 0; i < 5; i += 1) await login(app, 'alice', WRONG);
    clock.advance(10 * MINUTE);
    for (let i = 0; i < 3; i += 1) await login(app, 'alice', WRONG);
    clock.advance(5 * MINUTE + 1);
    expect((await login(app)).statusCode).toBe(200);
  });

  it('is lifted by an operator unlock', async () => {
    await setup();
    const { app, clock, manager } = current();
    for (let i = 0; i < 5; i += 1) await login(app, 'alice', WRONG);
    expect((await login(app)).statusCode).toBe(429);
    await manager.unlock('alice', operator(clock));
    expect((await login(app)).statusCode).toBe(200);
  });
});

describe('login rate limiting and client addresses', () => {
  const xff = (ip: string) => ({ 'x-forwarded-for': ip });

  describe('on TCP (development): X-Forwarded-For is never believed', () => {
    it('limits by the connection address however the header varies', async () => {
      await setup();
      for (let i = 0; i < 10; i += 1) await login(current().app, `user${i}`, WRONG, xff(`198.51.100.${i}`));
      expect((await login(current().app, 'alice', PASSWORD, xff('192.0.2.200'))).statusCode).toBe(429);
    });

    it('records the connection address in the audit log, not the claimed one', async () => {
      await setup();
      await login(current().app, 'alice', WRONG, xff('203.0.113.77'));
      const { rows } = await db.query(`select ip from admin_auth.audit_log where event = 'login_failure'`);
      expect(rows).toEqual([{ ip: '127.0.0.1' }]);
    });
  });

  describe('on the Unix socket (production): nginx sets X-Forwarded-For', () => {
    it('limits each client address to 10 attempts a minute', async () => {
      await setup({ env: SOCKET_ENV });
      const { app, clock } = current();
      for (let i = 0; i < 10; i += 1) {
        expect((await login(app, `user${i}`, WRONG, xff('203.0.113.5'))).statusCode).toBe(401);
      }
      expect((await login(app, 'alice', PASSWORD, xff('203.0.113.5'))).statusCode).toBe(429);
      expect((await login(app, 'alice', PASSWORD, xff('203.0.113.6'))).statusCode).toBe(200);
      clock.advance(MINUTE);
      expect((await login(app, 'alice', PASSWORD, xff('203.0.113.5'))).statusCode).toBe(200);
    });

    it('caps all clients together at 30 attempts a minute', async () => {
      await setup({ env: SOCKET_ENV });
      for (let i = 0; i < 30; i += 1) await login(current().app, `user${i}`, WRONG, xff(`198.51.100.${i}`));
      expect((await login(current().app, 'alice', PASSWORD, xff('192.0.2.1'))).statusCode).toBe(429);
    });

    it.each([['missing', undefined], ['a list', '1.2.3.4, 5.6.7.8'], ['not an address', 'nginx'], ['padded', ' 1.2.3.4']])(
      'files a %s header under one shared "unknown" bucket',
      async (_label, value) => {
        await setup({ env: SOCKET_ENV });
        await login(current().app, 'alice', WRONG, value === undefined ? {} : xff(value));
        const { rows } = await db.query(`select ip from admin_auth.audit_log where event = 'login_failure'`);
        expect(rows).toEqual([{ ip: 'unknown' }]);
      },
    );

    it('writes one audit row per limited window, not one per request', async () => {
      await setup({ env: SOCKET_ENV });
      for (let i = 0; i < 25; i += 1) await login(current().app, `user${i}`, WRONG, xff('203.0.113.9'));
      expect(await count(`select 1 from admin_auth.audit_log where event = 'login_rate_limited'`)).toBe(1);
    });
  });
});

describe('audit log and logs', () => {
  it('records each step and never stores or logs a password, token or cookie', async () => {
    await setup();
    const app = current().app;
    await login(app, 'alice', WRONG);
    await login(app, 'ghost', WRONG);
    const token = tokenOf(await login(app));
    await get(app, '/api/admin/auth/me', token);
    await logout(app, token);

    const { rows } = await db.query<{ event: string; account_id: string | null; ip: string; detail: unknown }>(
      'select event, account_id, ip, detail from admin_auth.audit_log order by id',
    );
    const alice = current().aliceId;
    expect(rows).toEqual([
      { event: 'account_created', account_id: alice, ip: null, detail: { actor: 'operator', role: 'owner' } },
      { event: 'login_failure', account_id: alice, ip: '127.0.0.1', detail: { reason: 'bad_password', locked: false } },
      { event: 'login_failure', account_id: null, ip: '127.0.0.1', detail: { reason: 'unknown_account', locked: false } },
      { event: 'login_success', account_id: alice, ip: '127.0.0.1', detail: {} },
      { event: 'logout', account_id: alice, ip: '127.0.0.1', detail: {} },
    ]);

    const stored = await dumpAll(db);
    const logs = current().logs.text();
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [PASSWORD, WRONG, token, createHash('sha256').update(token).digest('hex')]) {
      expect(logs).not.toContain(secret);
    }
    for (const secret of [PASSWORD, WRONG, token, 'ghost']) {
      expect(stored).not.toContain(secret);
    }
    expect(logs.toLowerCase()).not.toContain('cookie');
  });

  it('answers database failures with a generic 500', async () => {
    await setup({ wrapDb: (appDb) => failingOn(appDb, /./) });
    const res = await login(current().app);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal error.' });
    expect(current().logs.text()).not.toContain(PASSWORD);
  });
});
