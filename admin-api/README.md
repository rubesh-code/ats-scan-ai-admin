# ats-admin-api

The read-only data API behind the admin dashboard: the ten `GET /api/admin/*`
endpoints in [`docs/admin-api.md`](../docs/admin-api.md), with the response
shapes in [`src/types.ts`](src/types.ts) (a checked copy of the dashboard's
`src/api/types.ts`).

## Who gets in

The dashboard has no sign-in page. **Cloudflare Access** guards
`admin.atsscanai.com`: it asks for an email and a one-time code before the site
loads, and adds a signed token (`Cf-Access-Jwt-Assertion`) to every request it
lets through. This service checks that token on every request:

- no token, a bad signature, the wrong application (AUD) or team, or expired → `401`
- a valid token for an email not in `ADMIN_EMAILS` → `403`

The server's address is public, so requests that skip Cloudflare reach nginx
too. They carry no valid token and get `401`, before any data is read.

## Data

Read through Supabase's REST API with the service-role key, requesting only
the columns the dashboard shows: no OTP hashes, payment signatures, provider
responses, resume text, file paths or scan results. All figures come from one
snapshot of those rows, reused for 30 seconds. That suits the current size
(tens to thousands of rows); revisit past ~100k rows per table.

How production data is read:

| Dashboard | Stored as |
|---|---|
| scan `completed` / `failed` | `scans.status = 'Completed'` / anything else |
| credit type `rewrite` | `credit_transactions.type = 'resume_rewrite'` |
| payment provider and ids | `payments.payment_gateway`; ids from `razorpay_order_id` / `razorpay_payment_id`, which Cashfree orders use too (`cashfree_order_id` is preferred if ever filled) |
| last active | latest scan, rewrite or verified OTP sign-in |
| account `status` | always `active` (no column yet) |
| failure reason, refunds, backend errors | `null` (not recorded yet) |

Each request writes one audit line to the journal: admin email, method, URL,
status, client IP and time taken. Never the response body.

## Develop

```bash
npm ci
npm run typecheck   # includes the contract check against the dashboard's types
npm test
npm run build
```

## Deploy

See [`deploy/`](deploy/): the systemd unit, `env.example` for
`/etc/ats-admin-api/env`, and the nginx `location` to add to the
`admin.atsscanai.com` server block. Releases live in
`/opt/ats-admin-api/releases/<sha>` with `current` pointing at one; roll back
by pointing it at the previous release and restarting the service.
