import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

import cookie from '@fastify/cookie';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';

import type { AuthConfig } from './config.js';
import { isValidUsername, normalizeUsername, usernameKey } from './identity.js';
import { PASSWORD_MAX_LENGTH, type PasswordHasher } from './password.js';
import { FixedWindowLimiter } from './rate-limit.js';
import type { AuthStore, Session } from './store.js';
import { hashToken, isWellFormedToken, newSessionToken } from './tokens.js';

/**
 * `__Host-` makes the browser enforce Secure, Path=/ and no Domain attribute,
 * so the cookie is bound to exactly the host that set it (ats-admin.localhost
 * in the tunnel preview) and is never sent to another *.localhost app.
 */
export const SESSION_COOKIE = '__Host-ats_admin';

/**
 * Requests carrying this header (value "1") are authenticated but do not count
 * as activity, so background refetches cannot keep an idle session alive.
 */
export const BACKGROUND_HEADER = 'x-ats-admin-background';

/** Methods that must never change state. Every other method needs a same-origin Origin header. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The only routes reachable without a session. Every other route, including
 * ones registered later anywhere in the app, requires one. Marking any other
 * route `public` fails at startup.
 */
const PUBLIC_ROUTES = new Set(['POST /api/admin/auth/login', 'POST /api/admin/auth/logout']);

declare module 'fastify' {
  interface FastifyRequest {
    adminSession: Session | null;
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
}

export type AppDeps = {
  config: AuthConfig;
  store: AuthStore;
  passwords: PasswordHasher;
  now?: () => Date;
  /** Fastify logger options; `false` disables logging. Defaults to JSON logs on stdout. */
  logger?: FastifyServerOptions['logger'];
  /** Admin API routes. Like every non-public route, they run only after the session check. */
  protectedRoutes?: (scope: FastifyInstance) => void | Promise<void>;
};

/**
 * Logs carry method, path, status and peer address only: never headers,
 * bodies or cookies. The redact list is a second line of defence in case a
 * future log call passes a whole request or body.
 */
export const LOGGER_OPTIONS = {
  level: 'info',
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      'headers.cookie',
      'body.password',
      'password',
      '*.password',
      'token',
      '*.token',
    ],
    censor: '[redacted]',
  },
  serializers: {
    req: (req: { method?: string; url?: string; ip?: string }) => ({
      method: req.method,
      // Query strings are dropped: nothing sensitive is expected there, and nothing ever will be logged from one.
      url: req.url?.split('?')[0],
      ip: req.ip,
    }),
    res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    // PostgreSQL errors carry `detail`/`where`/`internalQuery`, which can quote
    // row values. Only structural fields are kept.
    err: (err: Error & { code?: unknown; constraint?: unknown; table?: unknown; column?: unknown; routine?: unknown }) => ({
      type: err.constructor?.name ?? 'Error',
      message: err.message,
      stack: err.stack ?? '',
      code: err.code,
      constraint: err.constraint,
      table: err.table,
      column: err.column,
      routine: err.routine,
    }),
  },
} satisfies FastifyServerOptions['logger'];

/**
 * The username is only bounded here. Whether it is well formed is decided in
 * the handler, so malformed names go through the same failure accounting as
 * any other wrong username instead of escaping it with a 400.
 */
const LOGIN_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['username', 'password'],
  properties: {
    username: { type: 'string', minLength: 1, maxLength: 128 },
    password: { type: 'string', minLength: 1, maxLength: PASSWORD_MAX_LENGTH },
  },
} as const;

const CLIENT_ERRORS: Record<number, string> = {
  400: 'Invalid request.',
  404: 'Not found.',
  405: 'Method not allowed.',
  413: 'Request too large.',
  415: 'Unsupported content type.',
};

function setSessionCookie(reply: FastifyReply, token: string, maxAgeSeconds: number) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: maxAgeSeconds,
  });
}

function clearSessionCookie(reply: FastifyReply) {
  reply.setCookie(SESSION_COOKIE, '', {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 0,
    expires: new Date(0),
  });
}

function sessionBody(session: Session, idleTimeoutMs: number) {
  return {
    admin: { id: session.accountId, username: session.username, role: session.role },
    expiresAt: session.expiresAt.toISOString(),
    idleExpiresAt: new Date(
      Math.min(session.lastSeenAt.getTime() + idleTimeoutMs, session.expiresAt.getTime()),
    ).toISOString(),
  };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, store, passwords } = deps;
  const now = deps.now ?? (() => new Date());

  // Unknown, malformed and disabled usernames are checked against this, so
  // every failed login costs one full Argon2id verification.
  const dummyHash = await passwords.hash(randomBytes(32).toString('base64url'));

  const { perIp, global, windowMs } = config.loginRateLimit;
  const ipLimiter = new FixedWindowLimiter(perIp, windowMs);
  const globalLimiter = new FixedWindowLimiter(global, windowMs);

  /** Per-IP first, then global. A request refused per IP does not use up the global budget. */
  function checkLoginRate(ip: string, at: number): { scope: 'ip' | 'global'; first: boolean } | null {
    const ipCount = ipLimiter.hit(ip, at);
    if (ipLimiter.isOver(ipCount)) return { scope: 'ip', first: ipLimiter.isFirstRefusal(ipCount) };
    const globalCount = globalLimiter.hit('global', at);
    if (globalLimiter.isOver(globalCount)) return { scope: 'global', first: globalLimiter.isFirstRefusal(globalCount) };
    return null;
  }

  /**
   * The client address used for rate limiting and audit. Only on the Unix
   * socket, whose permissions admit nginx alone, is X-Forwarded-For believed
   * (nginx overwrites it with one address). On TCP any local process could
   * connect and claim any address, so the peer address is used and the header
   * is ignored.
   */
  function clientAddress(request: FastifyRequest): string {
    if (config.trustForwardedFor) {
      const forwarded = request.headers['x-forwarded-for'];
      return typeof forwarded === 'string' && isIP(forwarded) !== 0 ? forwarded : 'unknown';
    }
    return request.socket.remoteAddress ?? 'unknown';
  }

  function clientInfo(request: FastifyRequest) {
    const agent = request.headers['user-agent'];
    return { ip: clientAddress(request), userAgent: typeof agent === 'string' ? agent.slice(0, 256) : null };
  }

  const app = Fastify({
    logger: deps.logger ?? LOGGER_OPTIONS,
    // No proxy is trusted by Fastify itself; see clientAddress().
    trustProxy: false,
    bodyLimit: 8 * 1024,
    requestTimeout: 15_000,
    return503OnClosing: true,
    // Fastify's defaults coerce types and silently strip unknown properties;
    // a malformed body should be refused instead.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });

  // JSON bodies only. Fastify also parses text/plain by default, which a
  // cross-site <form> can send without a CORS preflight.
  app.removeContentTypeParser('text/plain');

  await app.register(cookie);
  app.decorateRequest('adminSession', null);

  // Registered before any route, so it sees every route added afterwards.
  app.addHook('onRoute', (route) => {
    if (route.config?.public !== true) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (!PUBLIC_ROUTES.has(`${method} ${route.url}`)) {
        throw new Error(`Route ${method} ${route.url} may not be public; only login and logout are.`);
      }
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    // The raw Host header; X-Forwarded-Host is never consulted.
    const host = request.headers.host?.toLowerCase();
    if (!host || !config.allowedHosts.has(host)) {
      reply.code(421).send({ error: 'Unknown host.' });
      return reply;
    }

    if (!SAFE_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      const fetchSite = request.headers['sec-fetch-site'];
      const sameOrigin =
        typeof origin === 'string' &&
        config.allowedOrigins.has(origin) &&
        (fetchSite === undefined || fetchSite === 'same-origin');
      if (!sameOrigin) {
        request.log.warn({ reason: 'origin' }, 'refused cross-origin state-changing request');
        reply.code(403).send({ error: 'Cross-origin request refused.' });
        return reply;
      }
    }
  });

  async function authenticate(request: FastifyRequest): Promise<Session | null> {
    const token = request.cookies[SESSION_COOKIE];
    if (!isWellFormedToken(token)) return null;
    const at = now();
    const touch = request.headers[BACKGROUND_HEADER] !== '1';
    return store.findSession(hashToken(token), at, new Date(at.getTime() - config.idleTimeoutMs), touch);
  }

  // Deny by default: every request needs a session unless its route is one of
  // PUBLIC_ROUTES. This covers routes registered anywhere, unknown paths
  // (401, not 404) and any method.
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.config.public === true) return;
    const session = await authenticate(request);
    if (!session) {
      if (request.cookies[SESSION_COOKIE] !== undefined) clearSessionCookie(reply);
      reply.code(401).send({ error: 'Authentication required.' });
      return reply;
    }
    request.adminSession = session;
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    return payload;
  });

  app.setErrorHandler((error: { validation?: unknown; statusCode?: number }, request, reply) => {
    if (error.validation) return reply.code(400).send({ error: CLIENT_ERRORS[400] });
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: CLIENT_ERRORS[status] ?? CLIENT_ERRORS[400] });
    }
    request.log.error({ err: error }, 'request failed');
    return reply.code(500).send({ error: 'Internal error.' });
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: CLIENT_ERRORS[404] }));

  /* ---------------------------------------------------------- login ------- */

  const tooMany = (reply: FastifyReply) =>
    reply.code(429).header('Retry-After', '60').send({ error: 'Too many attempts. Try again later.' });

  app.post<{ Body: { username: string; password: string } }>(
    '/api/admin/auth/login',
    { schema: { body: LOGIN_BODY }, config: { public: true } },
    async (request, reply) => {
      const at = now();
      const { ip, userAgent } = clientInfo(request);

      const refusal = checkLoginRate(ip, at.getTime());
      if (refusal) {
        if (refusal.first) {
          await store.audit({ event: 'login_rate_limited', at, ip, userAgent, detail: { scope: refusal.scope } });
        }
        return tooMany(reply);
      }

      const username = normalizeUsername(request.body.username);
      const key = usernameKey(username);
      // A malformed name (control characters, NUL, wrong alphabet or length)
      // can never match an account. It skips the lookup, so it never reaches
      // the database as a value, but is otherwise counted like any wrong
      // username.
      const wellFormed = isValidUsername(username);
      const account = wellFormed ? await store.findAccount(username) : null;

      // Reserved before the slow password check, so parallel requests cannot
      // all get past the limit. Applies to any username, existing or not.
      if ((await store.beginAttempt(key, at, config.lockout)) === 'locked') {
        await store.audit({ event: 'login_locked', at, accountId: account?.id ?? null, ip, userAgent });
        return tooMany(reply);
      }

      const matches = await passwords.verify(account?.passwordHash ?? dummyHash, request.body.password);
      if (!matches || !account || account.disabledAt !== null) {
        const reason = !wellFormed
          ? 'invalid_username'
          : !account
            ? 'unknown_account'
            : account.disabledAt !== null
              ? 'account_disabled'
              : 'bad_password';
        await store.failAttempt(key, at, config.lockout, {
          event: 'login_failure',
          at,
          accountId: account?.id ?? null,
          ip,
          userAgent,
          detail: { reason },
        });
        return reply.code(401).send({ error: 'Invalid username or password.' });
      }

      // A fresh token on every login; any session this browser already had is
      // ended, so a planted cookie can never be upgraded (session fixation).
      const previous = request.cookies[SESSION_COOKIE];
      const token = newSessionToken();
      const expiresAt = new Date(at.getTime() + config.absoluteTimeoutMs);
      await store.completeLogin({
        key,
        previousTokenHash: isWellFormedToken(previous) ? hashToken(previous) : null,
        tokenHash: hashToken(token),
        account,
        createdAt: at,
        expiresAt,
        ip,
        userAgent,
      });

      setSessionCookie(reply, token, Math.floor(config.absoluteTimeoutMs / 1000));
      return reply.code(200).send(
        sessionBody(
          { accountId: account.id, username: account.username, role: account.role, createdAt: at, lastSeenAt: at, expiresAt },
          config.idleTimeoutMs,
        ),
      );
    },
  );

  /* --------------------------------------------------------- logout ------- */

  // Works with or without a valid session: it always clears the cookie.
  app.post('/api/admin/auth/logout', { config: { public: true } }, async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (isWellFormedToken(token)) {
      const { ip, userAgent } = clientInfo(request);
      await store.logout(hashToken(token), now(), ip, userAgent);
    }
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  /* ------------------------------------------------- authenticated ------- */

  app.get('/api/admin/auth/me', async (request) => sessionBody(request.adminSession!, config.idleTimeoutMs));

  if (deps.protectedRoutes) {
    const routes = deps.protectedRoutes;
    await app.register(async (scope) => routes(scope));
  }

  return app;
}
