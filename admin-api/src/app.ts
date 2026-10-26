import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';

import { ACCESS_HEADER, type AccessVerifier } from './access.js';
import { RANGE_DAYS, reports, type ListQuery } from './report.js';
import { SourceError, type Source } from './source.js';
import type {
  AccountStatus,
  CreditTransactionType,
  HealthCheck,
  PaymentStatus,
  RangeKey,
  ScanStatus,
  SystemHealth,
} from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The Cloudflare Access email, set once the access check passes. */
    adminEmail?: string;
  }
}

export type AppDeps = {
  source: Source;
  verify: AccessVerifier;
  /** The customer backend's health URL, or null to leave it out. */
  customerHealthUrl: string | null;
  now?: () => number;
  fetchImpl?: typeof fetch;
  logger?: FastifyServerOptions['logger'];
};

class BadRequest extends Error {}

const SEARCH_MAX = 100;
const PAGE_SIZE_MAX = 100;
const SLOW_MS = 2_000;

type Query = Record<string, string | undefined>;

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], name: string): T | null {
  if (value === undefined || value === '') return null;
  if (!(allowed as readonly string[]).includes(value)) throw new BadRequest(`Unknown ${name}.`);
  return value as T;
}

function range(query: Query): RangeKey {
  return oneOf(query.range, Object.keys(RANGE_DAYS) as RangeKey[], 'range') ?? '30d';
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new BadRequest(`${name} must be a positive whole number.`);
  return n;
}

function list(query: Query): ListQuery {
  const search = query.search?.trim() ?? '';
  if (search.length > SEARCH_MAX) throw new BadRequest(`search is limited to ${SEARCH_MAX} characters.`);
  return {
    page: Math.min(positiveInt(query.page, 1, 'page'), 100_000),
    pageSize: Math.min(positiveInt(query.pageSize, 25, 'pageSize'), PAGE_SIZE_MAX),
    search: search || null,
  };
}

async function timed(name: string, check: () => Promise<void>): Promise<HealthCheck> {
  const started = performance.now();
  try {
    await check();
    const latencyMs = Math.round(performance.now() - started);
    return {
      name,
      status: latencyMs > SLOW_MS ? 'degraded' : 'ok',
      latencyMs,
      detail: latencyMs > SLOW_MS ? 'Slow to respond' : null,
    };
  } catch {
    return { name, status: 'down', latencyMs: null, detail: 'Did not answer' };
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  // Fastify's own per-request lines are off: the audit line below replaces them.
  const app = Fastify({
    logger: deps.logger ?? true,
    logController: new LogController({ disableRequestLogging: true }),
    return503OnClosing: true,
  });

  // Every request, before routing: no valid Cloudflare Access token, no data.
  app.addHook('onRequest', async (request, reply) => {
    const header = request.headers[ACCESS_HEADER];
    const result = await deps.verify(typeof header === 'string' ? header : undefined);
    if (!result.ok) {
      reply
        .code(result.status)
        .send({ error: result.status === 401 ? 'Authentication required.' : 'This account is not an admin.' });
      return reply;
    }
    request.adminEmail = result.email;
  });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  // The audit trail: who asked for what, and the answer. Never the response body.
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        audit: true,
        admin: request.adminEmail ?? null,
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        ip: request.headers['cf-connecting-ip'] ?? request.ip,
        ms: Math.round(reply.elapsedTime),
      },
      'admin request',
    );
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'Not found.' });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof BadRequest) return reply.code(400).send({ error: error.message });
    if (error instanceof SourceError) {
      request.log.error({ err: error }, 'database read failed');
      return reply.code(503).send({ error: 'The database did not answer. Try again shortly.' });
    }
    request.log.error({ err: error }, 'request failed');
    return reply.code(500).send({ error: 'Something went wrong on the server.' });
  });

  const report = async () => reports(await deps.source.snapshot(), now());
  const q = (request: FastifyRequest) => request.query as Query;
  const get = (url: string, handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    app.get(url, handler);

  get('/api/admin/overview', async (request) => (await report()).overview(range(q(request))));

  get('/api/admin/users', async (request) =>
    (await report()).users({
      ...list(q(request)),
      status: oneOf<AccountStatus>(q(request).status, ['active', 'suspended'], 'status'),
    }),
  );

  get('/api/admin/users/:id', async (request, reply) => {
    const detail = (await report()).user((request.params as { id: string }).id);
    return detail ?? reply.code(404).send({ error: 'User not found.' });
  });

  get('/api/admin/scans', async (request) =>
    (await report()).scans({
      ...list(q(request)),
      status: oneOf<ScanStatus>(q(request).status, ['completed', 'failed'], 'status'),
    }),
  );

  get('/api/admin/scans/summary', async (request) => (await report()).scanSummary(range(q(request))));

  get('/api/admin/credits/transactions', async (request) =>
    (await report()).creditTransactions({
      ...list(q(request)),
      type: oneOf<CreditTransactionType>(
        q(request).type,
        ['purchase', 'scan', 'rewrite', 'adjustment', 'refund'],
        'type',
      ),
    }),
  );

  get('/api/admin/credits/summary', async (request) => (await report()).creditSummary(range(q(request))));

  get('/api/admin/payments', async (request) =>
    (await report()).payments({
      ...list(q(request)),
      status: oneOf<PaymentStatus>(q(request).status, ['created', 'paid', 'failed', 'refunded'], 'status'),
    }),
  );

  get('/api/admin/payments/summary', async (request) => (await report()).paymentSummary(range(q(request))));

  get('/api/admin/health', async (): Promise<SystemHealth> => {
    const checks = [timed('Database', () => deps.source.ping())];
    const customer = deps.customerHealthUrl;
    if (customer) {
      checks.push(
        timed('Customer API', async () => {
          const response = await fetchImpl(customer, { signal: AbortSignal.timeout(5_000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
        }),
      );
    }
    return {
      checkedAt: new Date(now()).toISOString(),
      checks: [{ name: 'Admin API', status: 'ok', latencyMs: null, detail: null }, ...(await Promise.all(checks))],
      // Backend errors are not recorded anywhere queryable yet.
      recentErrors: null,
    };
  });

  return app;
}
