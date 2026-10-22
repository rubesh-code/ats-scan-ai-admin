# ats-admin-auth

Authentication service for the ATS Scan AI admin dashboard. A separate Node 22
package: it shares no code, process, credentials or database role with the
customer backend.

**Status: built and tested locally only.** Not deployed, not connected to any
database, and the dashboard frontend does not use it yet (it still has its
mock OTP login). It serves no dashboard data.

**Not ready for public exposure.** Mandatory before then: TOTP/MFA, role
enforcement, request auditing for data endpoints, and lockout/limits that
cannot be used to lock other admins out (see *Open items*).

## Endpoints

All responses are JSON with `Cache-Control: no-store`. Errors are
`{ "error": "<generic message>" }`.

| Method & path | Session | Result |
|---|---|---|
| `POST /api/admin/auth/login` `{ username, password }` | not needed | `200` session + cookie · `401` invalid · `429` locked or rate-limited |
| `POST /api/admin/auth/logout` | not needed | `204`, session deleted, cookie cleared |
| `GET /api/admin/auth/me` | required | `200` `{ admin: { id, username, role }, expiresAt, idleExpiresAt }` |
| anything else | required | `401` without a valid session; `404` with one (nothing else exists yet) |

Routing is deny-by-default: every request needs a session unless its route is
one of the two above. A route registered anywhere, at any time, is protected
without opting in, and marking any other route `public` fails at startup.

## Security controls

| Control | Implementation |
|---|---|
| Network | Production: a Unix socket (`ADMIN_AUTH_SOCKET`), mode 0660 in a 0750 directory, reachable only by the service user and nginx. The service refuses a socket directory other users can enter. Development: TCP on a loopback address only. |
| Client address | `X-Forwarded-For` is believed only on the Unix socket, where only nginx can connect (nginx overwrites it with one address; anything else is filed as `unknown`). On TCP the header is ignored, so no local process can forge addresses or dodge per-address limits. |
| Passwords | Argon2id, 64 MiB, t=3, p=1. Unknown, malformed and disabled usernames are verified against a dummy hash. Policy (CLI): 15–1024 characters, no username, not repetitive. |
| Accounts | No registration endpoint. Created, reset, disabled, unlocked only by the operator CLI. |
| Sessions | 256-bit random token in the cookie; only its SHA-256 is stored. 30-minute idle and 8-hour absolute expiry, enforced in SQL on every request. New token on every login (the old one deleted). Each session is bound to the account's `credential_version`, which every password reset increments, so no session outlives a reset even if deleting it failed. Disabling an account ends access on the next request. |
| Cookie | `__Host-ats_admin`; `HttpOnly; Secure; SameSite=Strict; Path=/`; no `Domain`; `Max-Age` = 8 h. Identical attributes when cleared. |
| CSRF | Every method except `GET/HEAD/OPTIONS` needs an `Origin` exactly equal to an allowed origin, and `Sec-Fetch-Site` (when sent) of `same-origin`. JSON bodies only. No CORS headers are ever sent. |
| Host | The raw `Host` must exactly match an allowed origin's host (`421` otherwise). `X-Forwarded-Host` is ignored. |
| Lockout | 5 failures in 15 minutes lock that username for 15 minutes. Each attempt is reserved under a per-username advisory lock *before* the password check, so parallel requests cannot exceed 5. Applies identically to non-existent and malformed usernames (no enumeration, no bypass), keyed by a hash of the username, not extended by attempts during the lock, does not end existing sessions. Operators can `unlock`. |
| Malformed usernames | NUL, control characters, non-ASCII, wrong length: never sent to the database as a value; answered with the normal `401` and counted toward lockout. |
| Rate limit | Login: 10/min per client address and 30/min overall (in-process). Behind the SSH tunnel every client is the same address, so the overall limit and lockout are what apply there. |
| Atomicity | A successful login (session + failure reset + audit), a failed login (lock + audit), logout (delete + audit) and every CLI change (change + audit) each run in one transaction. If the audit row cannot be written, the change does not happen. |
| Audit | `admin_auth.audit_log`: login success/failure/locked/rate-limited, logout, and every CLI change with the operator's name. Never passwords, tokens, token hashes, cookies, or usernames that do not exist. The service and CLI roles can only insert. |
| Logs | Method, path (no query), status, peer address. Never headers, bodies or cookies. Error logs keep the message, stack and SQLSTATE but drop PostgreSQL's `detail`/`where`/`internalQuery`, which can quote row values. |
| Database URL | Read only from a file or systemd credential, never an environment variable. A file named by an environment variable must be mode 0600 or stricter (POSIX). Parsed into discrete fields; pg never sees a connection string, and every query parameter except `sslmode` is refused (`host`, `max`, timeouts, `options`, `ssl*`...). Non-local databases always use certificate- and hostname-verified TLS. |
| CLI errors | Configuration problems are shown as is (they name variables, never values). Database failures show only a generic message and the error code. |
| Policy | Session and lockout values are constants, not environment settings. |

**Not yet enforced:** roles. `owner`, `admin` and `viewer` are stored and
returned, but every route treats them alike. Role checks must exist before any
data endpoint is added.

## Database

Everything lives in schema `admin_auth`. Nothing in `public` is read,
changed or referenced.

1. `db/roles.sql`: creates `ats_admin_auth_app` (service) and
   `ats_admin_auth_manager` (CLI), both `NOLOGIN`. Logins and passwords are
   set by hand afterwards (`\password`, `alter role ... login`).
2. `db/migrations/001_admin_auth.sql`: the tables and the grants. Idempotent.
   (Never applied anywhere, so it was amended in place rather than followed by a 002.)
3. Rollback: `db/migrations/001_admin_auth.down.sql` drops the schema; the
   file notes how to drop the roles.

| Table | Service (`_app`) | CLI (`_manager`) |
|---|---|---|
| `accounts` | select (id, username, password_hash, role, disabled_at, credential_version); update (last_login_at) | select, insert, update |
| `sessions` | select, insert, delete; update (last_seen_at) | select, delete |
| `login_failures` | select, insert, delete | select, delete |
| `lockouts` | select, insert, update, delete | select, delete |
| `audit_log` | insert | insert |

Neither role can read or alter the audit log, change the schema, wind a
credential version back, or touch anything in `public`. The tests prove each
of these refusals. Advisory locks need no grant.

On Supabase, never add `admin_auth` to the API's *Exposed schemas*.

**Not applied anywhere.** Apply only to an approved staging database first.

## Operator CLI

Connects as `ats_admin_auth_manager` using its own secret. Run it on the
server as the unprivileged service user, with a terminal so the password is
prompted with echo off (verify this command on the server before relying on
it):

```bash
sudo systemd-run --pty --wait --collect --quiet \
  --uid=ats-admin --gid=ats-admin \
  -p LoadCredential=manager-db-url:/etc/ats-admin-auth/manager-db-url \
  -p LoadCredential=db-ca:/etc/ats-admin-auth/db-ca \
  -E SUDO_USER="$USER" \
  /usr/bin/node /opt/ats-admin-auth/current/dist/cli.js create alice --role owner
# also: reset-password, disable, enable, unlock, revoke-sessions <username>
```

Passwords are never accepted as arguments or environment variables. **Do not
pipe a password from `echo` or `printf`**: the command line, password included,
is saved in your shell history and is visible in the process list while it
runs. Use the interactive prompt. If you must use standard input, feed it from
a password manager's CLI or a private file (`< file` with mode 0600, deleted
afterwards), never from a literal typed on the command line.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `ADMIN_AUTH_SOCKET` | — | Production. Absolute path, e.g. `/run/ats-admin-auth/auth.sock`. Linux only. Excludes the two below. |
| `ADMIN_AUTH_HOST` | `127.0.0.1` | Development only. Must be a loopback IP literal |
| `ADMIN_AUTH_PORT` | `5071` | Development only |
| `ADMIN_AUTH_ALLOWED_ORIGINS` | — (required) | Comma-separated exact origins, e.g. `http://ats-admin.localhost:5070`. `http` only for `*.localhost` |
| credential `db-url` / `ADMIN_AUTH_DATABASE_URL_FILE` | — (required) | Service DB URL, as a 0600 file. Only `?sslmode=verify-full` (or `disable` for a local DB) is accepted |
| credential `manager-db-url` / `ADMIN_AUTH_MANAGER_DATABASE_URL_FILE` | — | CLI DB URL, as a 0600 file |
| credential `db-ca` / `ADMIN_AUTH_DB_CA_FILE` | — | CA bundle for the DB (Supabase's CA for a Supabase database) |

## Development

Node 22 (`.prototools`). From this directory:

```bash
npm ci
npm run typecheck
npm test        # ~3-4 s
npm run build   # dist/
```

The tests need no database server. They run the real migration and role SQL in
[PGlite](https://pglite.dev) (PostgreSQL compiled to WebAssembly, in-process
and in memory) and execute every service query as `ats_admin_auth_app` and
every CLI query as `ats_admin_auth_manager`, so they also prove the grants.
Fault injection (`failingOn` in `test/helpers.ts`) proves each transaction
rolls back completely.

**Limits of the test database.** PGlite has one connection and runs
transactions one at a time. The parallel-login test proves the application
never acts on stale lockout state (it fails against the old check-then-act
code), but not how PostgreSQL's advisory locks behave across separate pooled
connections. Tests marked POSIX-only (real Unix socket, 0600 checks) are
skipped on Windows and must run on Linux.

**Still needs a real PostgreSQL server** (staging) before deployment:
- the `pg` driver path: pooling, transactions on pooled clients, TLS with
  certificate verification against Supabase's CA, `statement_timeout`;
- concurrent logins across real connections (advisory-lock serialisation);
- `roles.sql` and the migration run by Supabase's non-superuser `postgres`
  role, and Supabase's default privileges (check that `anon`, `authenticated`
  and `service_role` have no access to `admin_auth`);
- the Supabase pooler (Supavisor) with these custom roles;
- the compiled `dist/server.js` end to end on a Unix socket under systemd.

## Testing the cookie in a browser

`__Host-` cookies require `Secure`. Browsers treat `http://localhost` and
`http://*.localhost` as secure contexts, and Chromium (Chrome, Edge) accepts
`Secure` cookies there, so the tunnel URL `http://ats-admin.localhost:5070` is
expected to work unchanged. Verify this in the browser you will use
(DevTools → Application → Cookies) before relying on it.

If a browser refuses the cookie over http, **do not weaken the cookie**. Use
HTTPS instead:

- On your PC, run a local TLS proxy (e.g. Caddy) with a certificate for
  `ats-admin.localhost` from a local CA trusted only by your PC (e.g.
  `mkcert`), forwarding to the SSH tunnel on `127.0.0.1:5070`.
- Browse `https://ats-admin.localhost:5443` and add that exact origin to
  `ADMIN_AUTH_ALLOWED_ORIGINS`.

## Frontend integration (not done yet)

The dashboard still uses its mock OTP flow and a bearer token in
`sessionStorage`. Switching it to this service means:

- a username/password login page;
- `fetch(..., { credentials: 'same-origin' })` with no `Authorization` header
  and no token storage;
- `GET /api/admin/auth/me` on load;
- sending `x-ats-admin-background: 1` on automatic refetches so they do not
  extend the idle timeout;
- the Vite dev proxy sending `/api/admin` to 127.0.0.1:5071.

## Open items

Before staging: the real-PostgreSQL checks above, and a browser check of the cookie.

Before public exposure (mandatory):
1. **TOTP/MFA.**
2. Cloudflare Access in front; the real client IP from Cloudflare; lockout and
   limits that cannot be used to lock other admins out (per username + client,
   device cookies); a non-global nginx zone.
3. Role enforcement and per-request audit records, before any data endpoint.
4. HSTS on the HTTPS host, COOP, an API CSP; audit-log retention and
   append-only storage; bucket eviction in the rate limiter.
5. An independent security review.

## Deployment (pending, not performed)

Drafts for review are in [`deploy/`](deploy/): a hardened systemd unit (Unix
socket, `RuntimeDirectory`, credentials) and an nginx preview server block
(upstream over the socket). Both must be reconciled with the server's existing
configuration before use.
