-- Prerequisite for migrations/001_admin_auth.sql. Run once per database, as a
-- role allowed to create roles, on a STAGING or local database only until a
-- production rollout is separately approved.
--
-- Two runtime roles, neither of which can read or write anything outside the
-- admin_auth schema:
--
--   ats_admin_auth_app      the service. Can read accounts, manage sessions,
--                           record failures and lockouts, append audit rows.
--                           Cannot create accounts, change password hashes,
--                           or read/alter the audit log.
--   ats_admin_auth_manager  the operator CLI. Can create accounts, reset
--                           passwords, disable/enable, unlock, revoke
--                           sessions, append audit rows.
--
-- Both are created NOLOGIN. Enabling login is a separate, deliberate step so
-- that no password ever appears in this file or in shell history:
--
--   psql> \password ats_admin_auth_app
--   psql> alter role ats_admin_auth_app login;
--
-- Neither role is a superuser, owns objects, or inherits the Supabase
-- service_role, anon or authenticated roles.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ats_admin_auth_app') then
    create role ats_admin_auth_app nologin nosuperuser nocreatedb nocreaterole noinherit noreplication;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'ats_admin_auth_manager') then
    create role ats_admin_auth_manager nologin nosuperuser nocreatedb nocreaterole noinherit noreplication;
  end if;
end
$$;

-- Keep statements short-lived even if a connection string omits it.
alter role ats_admin_auth_app set statement_timeout = '5s';
alter role ats_admin_auth_manager set statement_timeout = '15s';
