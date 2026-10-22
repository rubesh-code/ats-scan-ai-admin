import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';

import { PGlite } from '@electric-sql/pglite';

import type { Argon2Params } from '../src/password.js';
import type { Db, Queryable } from '../src/store.js';

/**
 * Tests run against PGlite: the real PostgreSQL engine compiled to
 * WebAssembly, in-process and in memory. No server, no network, no Docker, and
 * nothing outside this process is ever touched.
 */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
export const ROLES_SQL = read('db/roles.sql');
export const MIGRATION_SQL = read('db/migrations/001_admin_auth.sql');
export const DOWN_SQL = read('db/migrations/001_admin_auth.down.sql');

export async function createDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ROLES_SQL);
  await db.exec(MIGRATION_SQL);
  return db;
}

export type DbRole = 'ats_admin_auth_app' | 'ats_admin_auth_manager';

/**
 * Runs everything as `role` (SET LOCAL ROLE inside a transaction), so every
 * test exercising the service or CLI also proves the grants in the migration
 * are sufficient. Single queries get their own transaction; `transaction()`
 * gives a real one, rolled back if the work throws.
 *
 * Limit: PGlite has one connection and runs transactions one at a time. Tests
 * prove the application never lets parallel requests act on stale state, but
 * not how PostgreSQL's advisory locks behave across separate connections.
 */
export function asRole(db: PGlite, role: DbRole): Db {
  const run = <T>(work: (tx: Queryable) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.exec(`set local role ${role}`);
      return work({ query: (text, params) => tx.query(text, params as unknown[] | undefined) });
    });
  return { query: (text, params) => run((tx) => tx.query(text, params)), transaction: run };
}

/** Fault injection: any statement matching `pattern` throws, inside or outside a transaction. */
export function failingOn(db: Db, pattern: RegExp, error: Error = new FakeDbError()): Db {
  const guard =
    (target: Queryable): Queryable['query'] =>
    (text, params) => {
      if (pattern.test(text)) return Promise.reject(error);
      return target.query(text, params);
    };
  return {
    query: guard(db),
    transaction: (work) => db.transaction((tx) => work({ query: guard(tx) })),
  };
}

/**
 * Looks like a pg error: a SQLSTATE code, a message naming server details that
 * operators must not be shown, and a `detail` quoting row values that must not
 * reach any log.
 */
export class FakeDbError extends Error {
  code = '57P01';
  detail = 'Key (token_hash)=(secret-detail) already exists.';
  constructor() {
    super('terminating connection: server at "db.internal" (10.0.0.5) closed it');
  }
}

export async function resetData(db: PGlite) {
  await db.exec(
    `truncate admin_auth.audit_log, admin_auth.sessions, admin_auth.login_failures,
              admin_auth.lockouts, admin_auth.accounts restart identity cascade`,
  );
}

/** Everything the service stored, as one string, for "no secret leaked" assertions. */
export async function dumpAll(db: PGlite): Promise<string> {
  const tables = ['accounts', 'sessions', 'login_failures', 'lockouts', 'audit_log'];
  const parts = await Promise.all(tables.map((t) => db.query(`select * from admin_auth.${t}`)));
  return JSON.stringify(parts.map((p) => p.rows));
}

/** Cheap parameters so the suite stays fast; production parameters are tested separately. */
export const FAST_ARGON2: Argon2Params = { memoryCost: 4096, timeCost: 1, parallelism: 1 };

export const ORIGIN = 'http://ats-admin.localhost:5070';
export const HOST = 'ats-admin.localhost:5070';

export class TestClock {
  constructor(public time = Date.parse('2026-10-22T09:00:00Z')) {}
  now = () => new Date(this.time);
  advance(ms: number) {
    this.time += ms;
  }
}

export function logSink() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return { lines, stream, text: () => lines.join('') };
}

export const MINUTE = 60_000;
