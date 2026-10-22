-- Admin authentication schema. Requires db/roles.sql to have run first.
--
-- Everything lives in its own schema; nothing in public (the customer data) is
-- read, altered or referenced. Safe to re-run: every statement is idempotent.
-- Rollback: migrations/001_admin_auth.down.sql.
--
-- On Supabase, do NOT add admin_auth to the API's "Exposed schemas": it must
-- never be reachable through PostgREST.

begin;

create schema if not exists admin_auth;

create table if not exists admin_auth.accounts (
  id                  uuid primary key default gen_random_uuid(),
  username            text not null unique
                      check (username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  password_hash       text not null check (password_hash like '$argon2id$%'),
  role                text not null default 'admin'
                      check (role in ('owner', 'admin', 'viewer')),
  created_at          timestamptz not null default now(),
  password_changed_at timestamptz not null default now(),
  -- Bumped by every password reset. A session is valid only while its own
  -- copy matches, so no session outlives a reset even if deleting it failed.
  credential_version  integer not null default 1 check (credential_version > 0),
  last_login_at       timestamptz,
  disabled_at         timestamptz
);

-- Only the SHA-256 of the session token is stored. The token itself exists
-- only in the admin's cookie.
create table if not exists admin_auth.sessions (
  token_hash   text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  account_id   uuid not null references admin_auth.accounts(id) on delete cascade,
  credential_version integer not null check (credential_version > 0),
  created_at   timestamptz not null,
  last_seen_at timestamptz not null,
  expires_at   timestamptz not null,
  ip           text check (char_length(ip) <= 64),
  user_agent   text check (char_length(user_agent) <= 256),
  check (expires_at > created_at),
  check (last_seen_at >= created_at)
);
create index if not exists sessions_account_id_idx on admin_auth.sessions (account_id);
create index if not exists sessions_expires_at_idx on admin_auth.sessions (expires_at);

-- Keyed by a hash of the normalised username, whether or not the account
-- exists, so lockout behaviour reveals nothing about which usernames are real
-- and nothing typed into the username box is stored in clear.
create table if not exists admin_auth.login_failures (
  id           bigint generated always as identity primary key,
  username_key text not null check (username_key ~ '^[0-9a-f]{64}$'),
  failed_at    timestamptz not null
);
create index if not exists login_failures_key_time_idx
  on admin_auth.login_failures (username_key, failed_at);

create table if not exists admin_auth.lockouts (
  username_key text primary key check (username_key ~ '^[0-9a-f]{64}$'),
  locked_until timestamptz not null
);

-- Append-only from both runtime roles. Never holds passwords, tokens, token
-- hashes or cookies.
create table if not exists admin_auth.audit_log (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null,
  event       text not null check (event in (
                'login_success', 'login_failure', 'login_locked', 'login_rate_limited',
                'logout', 'account_created', 'password_reset', 'account_disabled',
                'account_enabled', 'account_unlocked', 'sessions_revoked')),
  account_id  uuid references admin_auth.accounts(id) on delete set null,
  ip          text check (char_length(ip) <= 64),
  user_agent  text check (char_length(user_agent) <= 256),
  detail      jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object')
);
create index if not exists audit_log_occurred_at_idx on admin_auth.audit_log (occurred_at);
create index if not exists audit_log_account_id_idx on admin_auth.audit_log (account_id);

-- Privileges: nothing by default, then exactly what each role needs.
revoke all on schema admin_auth from public;
revoke all on all tables in schema admin_auth from public;
revoke all on all sequences in schema admin_auth from public;

grant usage on schema admin_auth to ats_admin_auth_app, ats_admin_auth_manager;

-- Service.
grant select (id, username, password_hash, role, disabled_at, credential_version) on admin_auth.accounts to ats_admin_auth_app;
grant update (last_login_at) on admin_auth.accounts to ats_admin_auth_app;
grant select, insert, delete on admin_auth.sessions to ats_admin_auth_app;
grant update (last_seen_at) on admin_auth.sessions to ats_admin_auth_app;
grant select, insert, delete on admin_auth.login_failures to ats_admin_auth_app;
grant select, insert, update, delete on admin_auth.lockouts to ats_admin_auth_app;
grant insert on admin_auth.audit_log to ats_admin_auth_app;

-- Operator CLI.
grant select, insert, update on admin_auth.accounts to ats_admin_auth_manager;
grant select, delete on admin_auth.sessions to ats_admin_auth_manager;
grant select, delete on admin_auth.login_failures to ats_admin_auth_manager;
grant select, delete on admin_auth.lockouts to ats_admin_auth_manager;
grant insert on admin_auth.audit_log to ats_admin_auth_manager;

commit;
