-- Rollback for 001_admin_auth.sql. Removes the admin_auth schema and every
-- admin account, session and audit row in it. Touches nothing else.
--
-- To remove the roles as well (after this has run):
--   drop role if exists ats_admin_auth_app;
--   drop role if exists ats_admin_auth_manager;

drop schema if exists admin_auth cascade;
