import { usernameKey, type AdminRole } from './identity.js';

/** One SQL statement at a time. A pg Pool fits it, and so does the in-process PGlite used by the tests. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Adds all-or-nothing transactions: `work` runs on one connection between BEGIN and COMMIT, and any throw rolls back. */
export interface Db extends Queryable {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
}

async function rows<T>(db: Queryable, text: string, params: unknown[]): Promise<T[]> {
  return (await db.query(text, params)).rows as T[];
}

export type Account = {
  id: string;
  username: string;
  passwordHash: string;
  role: AdminRole;
  disabledAt: Date | null;
  /** Bumped by every password reset; a session is valid only for the version it was created under. */
  credentialVersion: number;
};

export type Session = {
  accountId: string;
  username: string;
  role: AdminRole;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
};

export type AuditEvent =
  | 'login_success'
  | 'login_failure'
  | 'login_locked'
  | 'login_rate_limited'
  | 'logout'
  | 'account_created'
  | 'password_reset'
  | 'account_disabled'
  | 'account_enabled'
  | 'account_unlocked'
  | 'sessions_revoked';

/** Callers must never put a password, token, token hash or cookie in `detail`. */
export type AuditEntry = {
  event: AuditEvent;
  at: Date;
  accountId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: Record<string, string | number | boolean | null>;
};

async function insertAudit(db: Queryable, entry: AuditEntry) {
  await db.query(
    `insert into admin_auth.audit_log (occurred_at, event, account_id, ip, user_agent, detail)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      entry.at,
      entry.event,
      entry.accountId ?? null,
      entry.ip?.slice(0, 64) ?? null,
      entry.userAgent?.slice(0, 256) ?? null,
      JSON.stringify(entry.detail ?? {}),
    ],
  );
}

/**
 * First key of the two-key advisory lock, so these locks cannot collide with
 * any other application's advisory locks in the same database. ("ADMN")
 */
const LOCK_NAMESPACE = 0x41444d4e;

/** Serialises login accounting for one username until the transaction ends. Other usernames are not blocked. */
async function lockUsername(tx: Queryable, key: string) {
  await tx.query(`select 1 as locked from (select pg_advisory_xact_lock($2::int, hashtext($1::text))) as l`, [
    key,
    LOCK_NAMESPACE,
  ]);
}

async function clearFailuresFor(tx: Queryable, key: string) {
  await tx.query(`delete from admin_auth.login_failures where username_key = $1`, [key]);
  await tx.query(`delete from admin_auth.lockouts where username_key = $1`, [key]);
}

type SessionRow = {
  account_id: string;
  username: string;
  role: AdminRole;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
};

function toSession(row: SessionRow): Session {
  return {
    accountId: row.account_id,
    username: row.username,
    role: row.role,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
  };
}

export type LockoutPolicy = { maxFailures: number; windowMs: number; durationMs: number };

/** Used by the service; runs as ats_admin_auth_app. */
export class AuthStore {
  constructor(private readonly db: Db) {}

  async findAccount(username: string): Promise<Account | null> {
    const [row] = await rows<{
      id: string;
      username: string;
      password_hash: string;
      role: AdminRole;
      disabled_at: Date | null;
      credential_version: number;
    }>(
      this.db,
      `select id, username, password_hash, role, disabled_at, credential_version
         from admin_auth.accounts where username = $1`,
      [username],
    );
    return row
      ? {
          id: row.id,
          username: row.username,
          passwordHash: row.password_hash,
          role: row.role,
          disabledAt: row.disabled_at,
          credentialVersion: row.credential_version,
        }
      : null;
  }

  /**
   * Reserves one login attempt for a username before its password is checked.
   *
   * The reservation is recorded as a failure up front and only cleared by a
   * successful login, so attempts still being verified count against the
   * limit. Under the per-username lock, at most `maxFailures` attempts can be
   * reserved per window however many requests arrive at once.
   */
  async beginAttempt(key: string, now: Date, policy: LockoutPolicy): Promise<'allowed' | 'locked'> {
    return this.db.transaction(async (tx) => {
      await lockUsername(tx, key);
      const locked = await rows(
        tx,
        `select 1 as locked from admin_auth.lockouts where username_key = $1 and locked_until > $2`,
        [key, now],
      );
      if (locked.length > 0) return 'locked';

      const [count] = await rows<{ n: number }>(
        tx,
        `select count(*)::int as n from admin_auth.login_failures where username_key = $1 and failed_at > $2`,
        [key, new Date(now.getTime() - policy.windowMs)],
      );
      if ((count?.n ?? 0) >= policy.maxFailures) return 'locked';

      await tx.query(`insert into admin_auth.login_failures (username_key, failed_at) values ($1, $2)`, [key, now]);
      return 'allowed';
    });
  }

  /**
   * Confirms a reserved attempt as failed: locks the username if the window
   * now holds `maxFailures`, and writes the audit row in the same transaction.
   * Returns the lock expiry if the username is now locked.
   */
  async failAttempt(key: string, now: Date, policy: LockoutPolicy, audit: AuditEntry): Promise<Date | null> {
    return this.db.transaction(async (tx) => {
      await lockUsername(tx, key);
      const [row] = await rows<{ locked_until: Date }>(
        tx,
        `insert into admin_auth.lockouts (username_key, locked_until)
         select $1::text, $2::timestamptz
          where (select count(*) from admin_auth.login_failures
                  where username_key = $1::text and failed_at > $3::timestamptz) >= $4::int
         on conflict (username_key) do update set locked_until = excluded.locked_until
         returning locked_until`,
        [key, new Date(now.getTime() + policy.durationMs), new Date(now.getTime() - policy.windowMs), policy.maxFailures],
      );
      await insertAudit(tx, { ...audit, detail: { ...audit.detail, locked: row !== undefined } });
      return row?.locked_until ?? null;
    });
  }

  /**
   * A successful login, all or nothing: ends the browser's previous session,
   * clears the username's failures, creates the session and records the audit
   * row. If any step fails, no session exists and no cookie is issued.
   */
  async completeLogin(login: {
    key: string;
    previousTokenHash: string | null;
    tokenHash: string;
    account: Account;
    createdAt: Date;
    expiresAt: Date;
    ip: string | null;
    userAgent: string | null;
  }) {
    await this.db.transaction(async (tx) => {
      if (login.previousTokenHash) {
        await tx.query(`delete from admin_auth.sessions where token_hash = $1`, [login.previousTokenHash]);
      }
      await clearFailuresFor(tx, login.key);
      await tx.query(
        `insert into admin_auth.sessions
           (token_hash, account_id, credential_version, created_at, last_seen_at, expires_at, ip, user_agent)
         values ($1, $2, $3, $4, $4, $5, $6, $7)`,
        [
          login.tokenHash,
          login.account.id,
          login.account.credentialVersion,
          login.createdAt,
          login.expiresAt,
          login.ip?.slice(0, 64) ?? null,
          login.userAgent?.slice(0, 256) ?? null,
        ],
      );
      await tx.query(`update admin_auth.accounts set last_login_at = $2 where id = $1`, [
        login.account.id,
        login.createdAt,
      ]);
      await insertAudit(tx, {
        event: 'login_success',
        at: login.createdAt,
        accountId: login.account.id,
        ip: login.ip,
        userAgent: login.userAgent,
      });
    });
  }

  /**
   * Returns the session if it is within both the absolute and the idle limit,
   * its account is enabled, and the account's password has not been reset
   * since it was created. With `touch`, also records activity, which is what
   * extends the idle window.
   */
  async findSession(tokenHash: string, now: Date, idleCutoff: Date, touch: boolean): Promise<Session | null> {
    const conditions = `s.token_hash = $1
         and a.id = s.account_id
         and a.disabled_at is null
         and s.credential_version = a.credential_version
         and s.expires_at > $2
         and s.last_seen_at > $3`;
    const [row] = touch
      ? await rows<SessionRow>(
          this.db,
          `update admin_auth.sessions s set last_seen_at = $2
             from admin_auth.accounts a
            where ${conditions}
        returning s.account_id, a.username, a.role, s.created_at, s.last_seen_at, s.expires_at`,
          [tokenHash, now, idleCutoff],
        )
      : await rows<SessionRow>(
          this.db,
          `select s.account_id, a.username, a.role, s.created_at, s.last_seen_at, s.expires_at
             from admin_auth.sessions s, admin_auth.accounts a
            where ${conditions}`,
          [tokenHash, now, idleCutoff],
        );
    return row ? toSession(row) : null;
  }

  /** Deletes the session and records the logout together. Returns the account, or null if there was no such session. */
  async logout(tokenHash: string, at: Date, ip: string | null, userAgent: string | null): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await rows<{ account_id: string }>(
        tx,
        `delete from admin_auth.sessions where token_hash = $1 returning account_id`,
        [tokenHash],
      );
      if (!row) return null;
      await insertAudit(tx, { event: 'logout', at, accountId: row.account_id, ip, userAgent });
      return row.account_id;
    });
  }

  async audit(entry: AuditEntry) {
    await insertAudit(this.db, entry);
  }

  /** Housekeeping: drops dead sessions, stale failure records and expired locks. */
  async prune(now: Date, idleCutoff: Date, failureCutoff: Date) {
    await this.db.query(`delete from admin_auth.sessions where expires_at <= $1 or last_seen_at <= $2`, [now, idleCutoff]);
    await this.db.query(`delete from admin_auth.login_failures where failed_at <= $1`, [failureCutoff]);
    await this.db.query(`delete from admin_auth.lockouts where locked_until <= $1`, [now]);
  }
}

export class AccountExistsError extends Error {
  constructor() {
    super('An admin account with that username already exists.');
    this.name = 'AccountExistsError';
  }
}

/** Who made a change, and when; recorded with it in the audit log. */
export type ChangeContext = { at: Date; actor: string };

function changeAudit(
  ctx: ChangeContext,
  event: AuditEvent,
  accountId: string,
  extra: Record<string, string | number> = {},
): AuditEntry {
  return { event, at: ctx.at, accountId, ip: null, userAgent: 'cli', detail: { actor: ctx.actor, ...extra } };
}

/**
 * Used by the operator CLI; runs as ats_admin_auth_manager. Every change and
 * its audit row commit together or not at all.
 */
export class AccountManager {
  constructor(private readonly db: Db) {}

  async createAccount(username: string, passwordHash: string, role: AdminRole, ctx: ChangeContext): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [row] = await rows<{ id: string }>(
        tx,
        `insert into admin_auth.accounts (username, password_hash, role, created_at, password_changed_at)
         values ($1, $2, $3, $4, $4)
         on conflict (username) do nothing
         returning id`,
        [username, passwordHash, role, ctx.at],
      );
      if (!row) throw new AccountExistsError();
      await insertAudit(tx, changeAudit(ctx, 'account_created', row.id, { role }));
      return row.id;
    });
  }

  /**
   * Replaces the hash, invalidates every session (by bumping the credential
   * version and deleting them), clears any lockout and records the audit row,
   * in one transaction. Returns null if there is no such account.
   */
  async resetPassword(
    username: string,
    passwordHash: string,
    ctx: ChangeContext,
  ): Promise<{ id: string; sessionsEnded: number } | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await rows<{ id: string }>(
        tx,
        `update admin_auth.accounts
            set password_hash = $2, password_changed_at = $3, credential_version = credential_version + 1
          where username = $1
      returning id`,
        [username, passwordHash, ctx.at],
      );
      if (!row) return null;
      const sessionsEnded = await deleteSessions(tx, row.id);
      await clearFailuresFor(tx, usernameKey(username));
      await insertAudit(tx, changeAudit(ctx, 'password_reset', row.id, { sessions_ended: sessionsEnded }));
      return { id: row.id, sessionsEnded };
    });
  }

  /** Disabling also deletes every session, so access ends immediately. */
  async setDisabled(username: string, disabled: boolean, ctx: ChangeContext): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await rows<{ id: string }>(
        tx,
        `update admin_auth.accounts set disabled_at = $2 where username = $1 returning id`,
        [username, disabled ? ctx.at : null],
      );
      if (!row) return null;
      const sessionsEnded = disabled ? await deleteSessions(tx, row.id) : 0;
      await insertAudit(
        tx,
        changeAudit(ctx, disabled ? 'account_disabled' : 'account_enabled', row.id, disabled ? { sessions_ended: sessionsEnded } : {}),
      );
      return row.id;
    });
  }

  async unlock(username: string, ctx: ChangeContext): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      const id = await findAccountId(tx, username);
      if (!id) return null;
      await clearFailuresFor(tx, usernameKey(username));
      await insertAudit(tx, changeAudit(ctx, 'account_unlocked', id));
      return id;
    });
  }

  async revokeSessions(username: string, ctx: ChangeContext): Promise<{ id: string; sessionsEnded: number } | null> {
    return this.db.transaction(async (tx) => {
      const id = await findAccountId(tx, username);
      if (!id) return null;
      const sessionsEnded = await deleteSessions(tx, id);
      await insertAudit(tx, changeAudit(ctx, 'sessions_revoked', id, { count: sessionsEnded }));
      return { id, sessionsEnded };
    });
  }
}

async function findAccountId(tx: Queryable, username: string): Promise<string | null> {
  const [row] = await rows<{ id: string }>(tx, `select id from admin_auth.accounts where username = $1`, [username]);
  return row?.id ?? null;
}

async function deleteSessions(tx: Queryable, accountId: string): Promise<number> {
  const deleted = await rows(tx, `delete from admin_auth.sessions where account_id = $1 returning 1 as deleted`, [
    accountId,
  ]);
  return deleted.length;
}
