import { PassThrough, Readable } from 'node:stream';

import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runCli, type CliDeps, type CliInput, type CliIO } from '../src/admin-cli.js';
import { ConfigError } from '../src/config.js';
import { usernameKey } from '../src/identity.js';
import { PasswordHasher } from '../src/password.js';
import { AccountManager, type Db } from '../src/store.js';
import { asRole, createDatabase, failingOn, FAST_ARGON2, resetData } from './helpers.js';

const PASSWORD = 'a long and unguessable passphrase';
const NEW_PASSWORD = 'a different long passphrase';
const passwords = new PasswordHasher(FAST_ARGON2);

let db: PGlite;

beforeAll(async () => {
  db = await createDatabase();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetData(db);
});

function output() {
  let text = '';
  return { write: (chunk: string) => ((text += chunk), true), text: () => text };
}

function managerDeps(wrap: (db: Db) => Db = (d) => d): CliDeps {
  return {
    passwords,
    actor: 'operator',
    now: () => new Date('2026-10-22T09:00:00Z'),
    // Runs as the manager role, exactly as in production.
    openManager: async () => ({
      manager: new AccountManager(wrap(asRole(db, 'ats_admin_auth_manager'))),
      close: async () => {},
    }),
  };
}

async function cli(argv: string[], stdin: CliInput = Readable.from([]), deps: CliDeps = managerDeps()) {
  const stdout = output();
  const stderr = output();
  const io: CliIO = { stdin, stdout, stderr };
  const code = await runCli(argv, io, deps);
  return { code, out: stdout.text(), err: stderr.text() };
}

const piped = (text: string) => Readable.from([text]);

async function account(username: string) {
  const { rows } = await db.query<{
    id: string;
    password_hash: string;
    role: string;
    disabled_at: Date | null;
    credential_version: number;
  }>('select id, password_hash, role, disabled_at, credential_version from admin_auth.accounts where username = $1', [
    username,
  ]);
  return rows[0];
}

async function auditEvents() {
  const { rows } = await db.query<{ event: string }>('select event from admin_auth.audit_log order by id');
  return rows.map((r) => r.event);
}

/** Alice with one live session and an active lockout, set up directly in the database. */
async function aliceWithSessionAndLock() {
  expect((await cli(['create', 'alice'], piped(`${PASSWORD}\n`))).code).toBe(0);
  const key = usernameKey('alice');
  await db.exec(`
    insert into admin_auth.sessions (token_hash, account_id, credential_version, created_at, last_seen_at, expires_at)
      select '${'a'.repeat(64)}', id, 1, now(), now(), now() + interval '1 hour' from admin_auth.accounts;
    insert into admin_auth.login_failures (username_key, failed_at) values ('${key}', now());
    insert into admin_auth.lockouts (username_key, locked_until) values ('${key}', now() + interval '15 minutes');
  `);
  return async () => {
    const { rows } = await db.query<{ sessions: number; locks: number; failures: number }>(
      `select (select count(*)::int from admin_auth.sessions) as sessions,
              (select count(*)::int from admin_auth.lockouts) as locks,
              (select count(*)::int from admin_auth.login_failures) as failures`,
    );
    return rows[0];
  };
}

describe('create', () => {
  it('creates an account from a password piped on stdin, with its audit row', async () => {
    const result = await cli(['create', 'Alice', '--role', 'owner'], piped(`${PASSWORD}\nignored second line\n`));
    expect(result).toMatchObject({ code: 0, out: 'Created owner account "alice".\n' });

    const row = await account('alice');
    expect(row?.role).toBe('owner');
    expect(row?.password_hash).toMatch(/^\$argon2id\$/);
    expect(await passwords.verify(row!.password_hash, PASSWORD)).toBe(true);

    const audit = await db.query('select event, detail from admin_auth.audit_log');
    expect(audit.rows).toEqual([{ event: 'account_created', detail: { actor: 'operator', role: 'owner' } }]);
    expect(result.out + result.err).not.toContain(PASSWORD);
  });

  it.each([['--password', PASSWORD], [`--password=${PASSWORD}`], ['-p', PASSWORD], ['--pass', PASSWORD]])(
    'refuses a password given as an argument (%s)',
    async (...flag) => {
      const result = await cli(['create', 'alice', ...flag], piped(`${PASSWORD}\n`));
      expect(result.code).toBe(2);
      expect(result.err).toContain('never accepted as arguments');
      expect(result.err).not.toContain(PASSWORD);
      expect(await account('alice')).toBeUndefined();
    },
  );

  it.each([
    ['too short', 'short-pass'],
    ['contains the username', 'my name is alice and that is long'],
    ['repetitive', 'aaaaaaaaaaaaaaaaaaaa'],
  ])('refuses a weak password (%s)', async (_label, weak) => {
    const result = await cli(['create', 'alice'], piped(`${weak}\n`));
    expect(result.code).toBe(1);
    expect(result.err).not.toContain(weak);
    expect(await account('alice')).toBeUndefined();
  });

  it('refuses an invalid username or role', async () => {
    expect((await cli(['create', 'a b'], piped(`${PASSWORD}\n`))).code).toBe(2);
    expect((await cli(['create', 'al\u0000ice'], piped(`${PASSWORD}\n`))).code).toBe(2);
    expect((await cli(['create', 'alice', '--role', 'root'], piped(`${PASSWORD}\n`))).code).toBe(2);
  });

  it('refuses to overwrite an existing account', async () => {
    await cli(['create', 'alice'], piped(`${PASSWORD}\n`));
    const again = await cli(['create', 'alice'], piped(`${NEW_PASSWORD}\n`));
    expect(again.code).toBe(1);
    expect(again.err).toContain('already exists');
    expect(await auditEvents()).toEqual(['account_created']);
  });

  it('creates nothing if the audit row cannot be written', async () => {
    const result = await cli(
      ['create', 'alice'],
      piped(`${PASSWORD}\n`),
      managerDeps((d) => failingOn(d, /insert into admin_auth\.audit_log/)),
    );
    expect(result.code).toBe(1);
    expect(await account('alice')).toBeUndefined();
  });
});

describe('terminal prompt', () => {
  function fakeTerminal(answers: string[]) {
    const stdin = new PassThrough() as PassThrough & CliInput;
    const rawModes: boolean[] = [];
    stdin.isTTY = true;
    stdin.setRawMode = (mode: boolean) => rawModes.push(mode);
    const stderr = output();
    const prompts = {
      write: (text: string) => {
        stderr.write(text);
        if (text.endsWith('password: ')) stdin.write(`${answers.shift()}\r`);
        return true;
      },
    };
    return { stdin, prompts, stderr, rawModes };
  }

  it('reads the password twice with echo off and never prints it', async () => {
    const term = fakeTerminal([PASSWORD, PASSWORD]);
    const stdout = output();
    const code = await runCli(['create', 'alice'], { stdin: term.stdin, stdout, stderr: term.prompts }, managerDeps());
    expect(code).toBe(0);
    expect(term.rawModes).toEqual([true, false, true, false]);
    expect(term.stderr.text()).toBe('New password: \nRepeat password: \n');
    expect(stdout.text()).not.toContain(PASSWORD);
  });

  it('refuses when the two entries differ', async () => {
    const term = fakeTerminal([PASSWORD, `${PASSWORD}!`]);
    const code = await runCli(['create', 'alice'], { stdin: term.stdin, stdout: output(), stderr: term.prompts }, {
      ...managerDeps(),
      openManager: async () => {
        throw new Error('must not connect');
      },
    });
    expect(code).toBe(1);
    expect(term.stderr.text()).toContain('Passwords do not match.');
  });

  it('warns against echo/printf in the usage text', async () => {
    const result = await cli([]);
    expect(result.err).toContain('never from echo/printf');
  });
});

describe('reset-password', () => {
  it('replaces the hash, ends sessions, clears the lock and audits, together', async () => {
    const counts = await aliceWithSessionAndLock();
    const result = await cli(['reset-password', 'alice'], piped(`${NEW_PASSWORD}\n`));
    expect(result).toMatchObject({ code: 0, out: 'Password reset for "alice"; ended 1 session(s).\n' });

    const row = await account('alice');
    expect(await passwords.verify(row!.password_hash, NEW_PASSWORD)).toBe(true);
    expect(await passwords.verify(row!.password_hash, PASSWORD)).toBe(false);
    expect(row?.credential_version).toBe(2);
    expect(await counts()).toEqual({ sessions: 0, locks: 0, failures: 0 });

    const audit = await db.query(`select detail from admin_auth.audit_log where event = 'password_reset'`);
    expect(audit.rows).toEqual([{ detail: { actor: 'operator', sessions_ended: 1 } }]);
  });

  it.each([
    ['session deletion', /delete from admin_auth\.sessions/],
    ['lockout clearing', /delete from admin_auth\.lockouts/],
    ['audit insert', /insert into admin_auth\.audit_log/],
  ])('changes nothing if the %s fails', async (_label, pattern) => {
    const counts = await aliceWithSessionAndLock();
    const before = await account('alice');
    const result = await cli(['reset-password', 'alice'], piped(`${NEW_PASSWORD}\n`), managerDeps((d) => failingOn(d, pattern)));

    expect(result.code).toBe(1);
    const after = await account('alice');
    expect(after?.password_hash).toBe(before?.password_hash);
    expect(after?.credential_version).toBe(before?.credential_version);
    expect(await counts()).toEqual({ sessions: 1, locks: 1, failures: 1 });
    expect(await auditEvents()).toEqual(['account_created']);
  });

  it('shows only a generic message and the error code, never driver details', async () => {
    await aliceWithSessionAndLock();
    const result = await cli(
      ['reset-password', 'alice'],
      piped(`${NEW_PASSWORD}\n`),
      managerDeps((d) => failingOn(d, /delete from admin_auth\.sessions/)),
    );
    expect(result.err).toBe('Failed: the database operation did not complete (code 57P01). The change was not applied.\n');
    expect(result.err).not.toContain('secret-detail');
    expect(result.err).not.toContain('db.internal');
    expect(result.err).not.toContain(NEW_PASSWORD);
  });
});

describe('other account maintenance', () => {
  it('disable ends sessions; enable restores the account', async () => {
    const counts = await aliceWithSessionAndLock();
    expect((await cli(['disable', 'alice'])).code).toBe(0);
    expect((await account('alice'))?.disabled_at).toBeInstanceOf(Date);
    expect((await counts())?.sessions).toBe(0);
    expect((await cli(['enable', 'alice'])).code).toBe(0);
    expect((await account('alice'))?.disabled_at).toBeNull();
  });

  it('does not disable an account if the change cannot be audited', async () => {
    const counts = await aliceWithSessionAndLock();
    const result = await cli(['disable', 'alice'], undefined, managerDeps((d) => failingOn(d, /insert into admin_auth\.audit_log/)));
    expect(result.code).toBe(1);
    expect((await account('alice'))?.disabled_at).toBeNull();
    expect((await counts())?.sessions).toBe(1);
  });

  it('unlock clears only the lockout', async () => {
    const counts = await aliceWithSessionAndLock();
    expect((await cli(['unlock', 'alice'])).code).toBe(0);
    expect(await counts()).toEqual({ sessions: 1, locks: 0, failures: 0 });
  });

  it('revoke-sessions ends every session', async () => {
    const counts = await aliceWithSessionAndLock();
    const result = await cli(['revoke-sessions', 'alice']);
    expect(result).toMatchObject({ code: 0, out: 'Ended 1 session(s) for "alice".\n' });
    expect((await counts())?.sessions).toBe(0);
  });

  it('audits every change with the operator name', async () => {
    await aliceWithSessionAndLock();
    await cli(['unlock', 'alice']);
    await cli(['revoke-sessions', 'alice']);
    await cli(['disable', 'alice']);
    expect(await auditEvents()).toEqual(['account_created', 'account_unlocked', 'sessions_revoked', 'account_disabled']);
    const { rows } = await db.query<{ actor: string }>(`select detail->>'actor' as actor from admin_auth.audit_log`);
    expect(new Set(rows.map((r) => r.actor))).toEqual(new Set(['operator']));
  });

  it('reports an unknown account', async () => {
    const result = await cli(['disable', 'nobody']);
    expect(result).toMatchObject({ code: 1, err: 'No admin account "nobody".\n' });
  });

  it('rejects unknown commands', async () => {
    expect((await cli(['delete', 'alice'])).code).toBe(2);
    expect((await cli([])).code).toBe(2);
  });
});

describe('connection failures', () => {
  it('shows configuration problems as they are (they never contain secrets)', async () => {
    const result = await cli(['unlock', 'alice'], undefined, {
      ...managerDeps(),
      openManager: async () => {
        throw new ConfigError('No manager-db-url secret: set ADMIN_AUTH_MANAGER_DATABASE_URL_FILE.');
      },
    });
    expect(result).toMatchObject({ code: 1, err: 'No manager-db-url secret: set ADMIN_AUTH_MANAGER_DATABASE_URL_FILE.\n' });
  });

  it('hides anything else behind a generic message', async () => {
    const result = await cli(['unlock', 'alice'], undefined, {
      ...managerDeps(),
      openManager: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND db.secret-host.internal'), { code: 'ENOTFOUND' });
      },
    });
    expect(result.err).toBe('Failed: the database operation did not complete (code ENOTFOUND). The change was not applied.\n');
  });
});
