import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { asRole, createDatabase, DOWN_SQL, MIGRATION_SQL, resetData, ROLES_SQL, type DbRole } from './helpers.js';

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
  // Stand-in for the customer data, to prove neither role can reach it.
  await db.exec(`
    create table public.users (id serial primary key, email text);
    insert into public.users (email) values ('customer@example.invalid');
  `);
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetData(db);
  await db.exec(`
    insert into admin_auth.accounts (id, username, password_hash)
    values ('00000000-0000-4000-8000-000000000001', 'alice', '$argon2id$v=19$m=4096,t=1,p=1$c2FsdA$aGFzaA');
    insert into admin_auth.audit_log (occurred_at, event) values (now(), 'login_success');
  `);
});

async function attempt(role: DbRole, sql: string) {
  return asRole(db, role).query(sql);
}

describe('least privilege', () => {
  const denied: Array<[DbRole, string]> = [
    // The service cannot create admins, change passwords or re-enable accounts...
    ['ats_admin_auth_app', `insert into admin_auth.accounts (username, password_hash) values ('eve', '$argon2id$x')`],
    ['ats_admin_auth_app', `update admin_auth.accounts set password_hash = '$argon2id$x'`],
    ['ats_admin_auth_app', `update admin_auth.accounts set disabled_at = null`],
    ['ats_admin_auth_app', `update admin_auth.accounts set role = 'owner'`],
    // ...cannot undo a password reset by winding the credential version back...
    ['ats_admin_auth_app', `update admin_auth.accounts set credential_version = 1`],
    ['ats_admin_auth_app', `update admin_auth.sessions set credential_version = 2`],
    ['ats_admin_auth_app', `delete from admin_auth.accounts`],
    // ...cannot read, rewrite or erase the audit trail...
    ['ats_admin_auth_app', `select * from admin_auth.audit_log`],
    ['ats_admin_auth_app', `update admin_auth.audit_log set event = 'logout'`],
    ['ats_admin_auth_app', `delete from admin_auth.audit_log`],
    ['ats_admin_auth_app', `truncate admin_auth.audit_log`],
    // ...cannot move a session's expiry...
    ['ats_admin_auth_app', `update admin_auth.sessions set expires_at = now() + interval '1 year'`],
    // ...cannot change the schema...
    ['ats_admin_auth_app', `create table admin_auth.extra (id int)`],
    ['ats_admin_auth_app', `drop table admin_auth.sessions`],
    // ...and cannot touch customer data.
    ['ats_admin_auth_app', `select * from public.users`],
    ['ats_admin_auth_app', `delete from public.users`],
    // The operator CLI cannot read or alter the audit trail either.
    ['ats_admin_auth_manager', `select * from admin_auth.audit_log`],
    ['ats_admin_auth_manager', `delete from admin_auth.audit_log`],
    ['ats_admin_auth_manager', `delete from admin_auth.accounts`],
    ['ats_admin_auth_manager', `update admin_auth.sessions set expires_at = now()`],
    ['ats_admin_auth_manager', `select * from public.users`],
    ['ats_admin_auth_manager', `create table admin_auth.extra (id int)`],
  ];

  it.each(denied)('%s is refused: %s', async (role, sql) => {
    await expect(attempt(role, sql)).rejects.toThrow(/permission denied|must be owner/);
  });

  it('gives an unrelated role no access to the schema at all', async () => {
    await db.exec(`create role someone_else nologin`);
    await expect(
      db.transaction(async (tx) => {
        await tx.exec('set local role someone_else');
        return tx.query('select * from admin_auth.accounts');
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it('lets the service read only the account columns it needs', async () => {
    const { rows } = await attempt('ats_admin_auth_app', `select id, username, role, disabled_at from admin_auth.accounts`);
    expect(rows).toHaveLength(1);
    await expect(attempt('ats_admin_auth_app', `select created_at from admin_auth.accounts`)).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('schema constraints', () => {
  it('refuses a password hash that is not Argon2id', async () => {
    await expect(
      db.exec(`insert into admin_auth.accounts (username, password_hash) values ('bob', '$2b$12$bcrypt')`),
    ).rejects.toThrow(/check constraint/);
  });

  it('refuses a raw token where a token hash belongs', async () => {
    await expect(
      db.exec(`insert into admin_auth.sessions (token_hash, account_id, credential_version, created_at, last_seen_at, expires_at)
               values ('${'A'.repeat(43)}', '00000000-0000-4000-8000-000000000001', 1, now(), now(), now() + interval '1 hour')`),
    ).rejects.toThrow(/check constraint/);
  });

  it('refuses usernames outside the allowed pattern', async () => {
    for (const name of ['Alice', 'a', 'has space', '-dash']) {
      await expect(
        db.query(`insert into admin_auth.accounts (username, password_hash) values ($1, '$argon2id$x')`, [name]),
      ).rejects.toThrow(/check constraint/);
    }
  });
});

describe('migration lifecycle', () => {
  it('can be re-applied safely', async () => {
    await db.exec(ROLES_SQL);
    await db.exec(MIGRATION_SQL);
    const { rows } = await db.query('select count(*)::int as n from admin_auth.accounts');
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('rolls back cleanly without touching anything outside admin_auth', async () => {
    await db.exec(DOWN_SQL);
    const schemas = await db.query(`select 1 from information_schema.schemata where schema_name = 'admin_auth'`);
    expect(schemas.rows).toHaveLength(0);
    const customers = await db.query('select count(*)::int as n from public.users');
    expect(customers.rows).toEqual([{ n: 1 }]);
    // Restore for any later test in this file.
    await db.exec(MIGRATION_SQL);
  });
});
