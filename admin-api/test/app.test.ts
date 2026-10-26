import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccessVerifier } from '../src/access.js';
import { buildApp } from '../src/app.js';
import { SourceError, type Source } from '../src/source.js';
import { NOW, snapshot } from './fixtures.js';

/** Token "good" is an admin, "customer" is a valid Access user who is not; anything else is invalid. */
const verify: AccessVerifier = async (token) =>
  token === 'good'
    ? { ok: true, email: 'owner@example.com' }
    : token === 'customer'
      ? { ok: false, status: 403 }
      : { ok: false, status: 401 };

const ROUTES = [
  '/api/admin/overview',
  '/api/admin/users',
  '/api/admin/users/u1',
  '/api/admin/scans',
  '/api/admin/scans/summary',
  '/api/admin/credits/transactions',
  '/api/admin/credits/summary',
  '/api/admin/payments',
  '/api/admin/payments/summary',
  '/api/admin/health',
];

let app: FastifyInstance;
afterEach(() => app?.close());

async function start(source: Partial<Source> = {}, fetchImpl?: typeof fetch) {
  const full: Source = { snapshot: async () => snapshot(), ping: async () => {}, ...source };
  app = await buildApp({ source: full, verify, customerHealthUrl: 'http://127.0.0.1:5050/api/health', now: () => NOW, fetchImpl, logger: false });
  return app;
}

const as = (token?: string) => (token ? { 'cf-access-jwt-assertion': token } : {});

describe('access', () => {
  it.each(ROUTES)('%s refuses a request without a Cloudflare Access token, before reading data', async (url) => {
    const read = vi.fn(async () => snapshot());
    await start({ snapshot: read });
    const response = await app.inject({ url });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Authentication required.' });
    expect(read).not.toHaveBeenCalled();
  });

  it('answers 403 to a signed-in person who is not an admin', async () => {
    await start();
    const response = await app.inject({ url: '/api/admin/overview', headers: as('customer') });
    expect(response.statusCode).toBe(403);
  });

  it('does not reveal which paths exist to an outsider', async () => {
    await start();
    expect((await app.inject({ url: '/api/admin/nope' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/admin/nope', headers: as('good') })).statusCode).toBe(404);
  });

  it('serves only GET', async () => {
    await start();
    const response = await app.inject({ method: 'POST', url: '/api/admin/users', headers: as('good') });
    expect(response.statusCode).toBe(404);
  });
});

describe('data', () => {
  it.each(ROUTES)('%s answers an admin with uncached JSON', async (url) => {
    await start();
    const response = await app.inject({ url, headers: as('good') });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('passes the range and filters through', async () => {
    await start();
    const overview = (await app.inject({ url: '/api/admin/overview?range=7d', headers: as('good') })).json();
    expect(overview.range).toBe('7d');
    expect(overview.totals.scans).toBe(3);
    const failed = (await app.inject({ url: '/api/admin/scans?status=failed', headers: as('good') })).json();
    expect(failed.items.map((s: { id: string }) => s.id)).toEqual(['s4']);
  });

  it('caps the page size at 100', async () => {
    await start();
    const page = (await app.inject({ url: '/api/admin/users?pageSize=5000', headers: as('good') })).json();
    expect(page.pageSize).toBe(100);
  });

  it.each([
    '/api/admin/overview?range=1y',
    '/api/admin/users?page=0',
    '/api/admin/users?pageSize=abc',
    '/api/admin/users?status=deleted',
    '/api/admin/credits/transactions?type=gift',
    `/api/admin/users?search=${'x'.repeat(101)}`,
  ])('rejects bad input: %s', async (url) => {
    await start();
    const response = await app.inject({ url, headers: as('good') });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toEqual(expect.any(String));
  });

  it('answers 404 for an unknown user', async () => {
    await start();
    const response = await app.inject({ url: '/api/admin/users/missing', headers: as('good') });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'User not found.' });
  });

  it('answers 503 with a generic message when the database fails', async () => {
    await start({ snapshot: async () => Promise.reject(new SourceError('users: HTTP 500 secret detail')) });
    const response = await app.inject({ url: '/api/admin/overview', headers: as('good') });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('secret');
  });

  it('never sends a column it did not map', async () => {
    const leaky = snapshot();
    Object.assign(leaky.users[0]!, { otp_hash: 'HASH' });
    Object.assign(leaky.payments[0]!, { razorpay_signature: 'SIG', cashfree_response: { token: 'TOK' } });
    await start({ snapshot: async () => leaky });
    for (const url of ['/api/admin/users', '/api/admin/users/u1', '/api/admin/payments']) {
      const body = (await app.inject({ url, headers: as('good') })).body;
      expect(body).not.toMatch(/HASH|SIG|TOK|otp_hash|signature|cashfree_response/);
    }
  });
});

describe('health', () => {
  it('reports the database and the customer backend', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await start({}, fetchImpl as unknown as typeof fetch);
    const health = (await app.inject({ url: '/api/admin/health', headers: as('good') })).json();
    expect(health.checks.map((c: { name: string; status: string }) => [c.name, c.status])).toEqual([
      ['Admin API', 'ok'],
      ['Database', 'ok'],
      ['Customer API', 'ok'],
    ]);
    expect(health.recentErrors).toBeNull();
  });

  it('marks a failing dependency down without failing the request', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 502 }));
    await start({ ping: async () => Promise.reject(new Error('boom')) }, fetchImpl as unknown as typeof fetch);
    const response = await app.inject({ url: '/api/admin/health', headers: as('good') });
    expect(response.statusCode).toBe(200);
    const checks = response.json().checks;
    expect(checks[1]).toEqual({ name: 'Database', status: 'down', latencyMs: null, detail: 'Did not answer' });
    expect(checks[2].status).toBe('down');
  });
});
