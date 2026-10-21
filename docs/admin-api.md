# Admin API contract

The dashboard calls only the endpoints below. **None of them exist yet.** They
belong in the ATS Scan AI backend (`rubesh-code/ats-scan-ai`, `server/`), next to
the existing user API, and reuse its Supabase service-role client. The browser
never talks to Supabase directly and never holds a database key.

The TypeScript source of truth is [`src/api/types.ts`](../src/api/types.ts).
Until the backend is ready, `npm run dev:mock` serves the same shapes from
[`src/api/mock.ts`](../src/api/mock.ts).

Conventions: JSON bodies, amounts in whole rupees, timestamps ISO-8601 UTC,
daily series zero-filled per UTC day and oldest first. Errors are
`{ "error": "<safe, human-readable message>" }` with a matching HTTP status.

## Security requirements (backend)

Hiding a page in the UI is not access control. Every rule here is enforced
server-side.

1. **Admin allowlist.** A new table, written only by migration or SQL:

   ```sql
   create table public.admin_users (
     user_id     uuid primary key references public.users(id) on delete cascade,
     role        text not null check (role in ('owner', 'admin', 'viewer')),
     created_at  timestamptz not null default now(),
     disabled_at timestamptz
   );
   alter table public.admin_users enable row level security; -- no policies: service role only
   ```

2. **Separate admin token.** `verify-otp` issues a JWT with `aud: "ats-admin"`,
   lifetime of at most 8 hours, and a `jti`. User tokens (no audience, 7 days)
   must be rejected by every `/api/admin` route, and admin tokens rejected by
   user routes.
3. **`requireAdmin` middleware** on every route except `send-otp`/`verify-otp`:
   verify signature, audience and expiry, then look the user up in
   `admin_users` **on every request** (`disabled_at is null`), so removing an
   admin takes effect immediately. Respond `401` for a missing/invalid/expired
   token and `403` for a valid token that is not (or no longer) an admin.
4. **No account enumeration.** `send-otp` always answers `200 { "status": "ok" }`
   and only actually emails addresses present in `admin_users`.
5. **Rate limits.** Stricter than the user login: e.g. 5 OTP sends per email per
   hour and 10 verify attempts per IP per 15 minutes.
6. **Audit log.** Record every admin request (who, route, query, status, IP,
   time) in `admin_audit_log`. Required before any write endpoint exists.
7. **Logout revokes.** `POST /api/admin/auth/logout` stores the token's `jti` in
   a deny-list until it expires.
8. **Pagination is capped** server-side (`pageSize` at most 100) and `search`
   is length-limited and parameterised, never interpolated into SQL.
9. **Responses never include** OTP hashes, provider signatures, raw resume text
   or file paths, or any environment value. Error messages are generic.
10. **No CORS for admin.** In production the dashboard and `/api/admin` share the
    `admin.atsscanai.com` origin through nginx, so admin routes need no CORS
    allowance. Do not add the admin origin to `CORS_ORIGIN`.

## Data gaps found in the current schema

| Dashboard need | Current state | Needed |
|---|---|---|
| Account status | `users` has no status column | `users.status text not null default 'active'` and `authMiddleware` refusing suspended users |
| Active users / last active | No last-activity column | Derive from latest scan, rewrite or verified OTP; or add `users.last_active_at` |
| Failed scans | Credits are only spent on success; failures are probably not stored | Record failed analyses (status, short reason) without charging |
| Refunds | No Razorpay webhook; `payments.status` is `created`/`paid`/`failed` | Webhook (signature-verified) setting `refunded`; until then return `null` |
| Backend errors | Only `console.error` | An errors table or log sink the health endpoint can read; until then return `null` |

The schema file in the backend repo notes that production has drifted from
`schema.sql`; confirm real column names against the production database
before writing these queries.

## Endpoints

### Auth

| Method & path | Body | Response |
|---|---|---|
| `POST /api/admin/auth/send-otp` | `{ email }` | `200 { status: "ok" }` (always) |
| `POST /api/admin/auth/verify-otp` | `{ email, otp }` | `200 AdminSession` or `401 { error }` |
| `GET /api/admin/me` | — | `AdminUser` |
| `POST /api/admin/auth/logout` | — | `204` |

`AdminSession = { token, expiresAt, admin: { id, email, role } }`

### Read-only data

| Method & path | Query | Response type |
|---|---|---|
| `GET /api/admin/overview` | `range=7d\|30d\|90d` | `Overview` |
| `GET /api/admin/users` | `page, pageSize, search, status` | `Page<UserSummary>` |
| `GET /api/admin/users/:id` | — | `UserDetail` (last 10 scans, transactions, payments) |
| `GET /api/admin/scans` | `page, pageSize, search, status` | `Page<ScanRecord>` |
| `GET /api/admin/scans/summary` | `range` | `ScanSummary` |
| `GET /api/admin/credits/transactions` | `page, pageSize, search, type` | `Page<CreditTransaction>` |
| `GET /api/admin/credits/summary` | `range` | `CreditSummary` |
| `GET /api/admin/payments` | `page, pageSize, search, status` | `Page<PaymentRecord>` |
| `GET /api/admin/payments/summary` | `range` | `PaymentSummary` |
| `GET /api/admin/health` | — | `SystemHealth` |

`Page<T> = { items: T[], page, pageSize, total }`

Definitions the backend must apply consistently:

- **Verified revenue**: sum of `payments.amount_inr` where `status = 'paid'`,
  bucketed by `verified_at`. Nothing else counts as revenue.
- **Credits consumed**: the absolute sum of negative `credit_transactions.credits`.
- **Active users**: users with a scan, rewrite or verified login in the last
  `activeWindowDays` (30) days; the response states the window it used.
- **Previous period**: the window of equal length immediately before the
  selected range, used for the percentage deltas.

## Acceptance checks for the backend work

- A user (mobile/web) token gets `401` on every `/api/admin/*` route.
- An admin token gets `401` on user routes.
- Removing a row from `admin_users` makes the next admin request `403`.
- An expired or logged-out admin token gets `401`.
- `send-otp` for a non-admin email returns `200` and sends nothing.
- Every endpoint's totals match a direct SQL query over the same window.
- Admin responses contain no field outside the types in `src/api/types.ts`.
