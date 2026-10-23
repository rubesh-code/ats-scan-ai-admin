# ATS Scan AI Admin

Internal admin dashboard for ATS Scan AI: users, scans, credits, verified
revenue and system health. A separate React app; it shares the existing
ATS Scan AI backend and database through dedicated `/api/admin` endpoints and
duplicates no data.

**Status:** the dashboard opens directly at `/`, with no sign-in page. Access
control is entirely server-side: the admin auth service
([`auth-service/`](auth-service/README.md)) refuses every `/api/admin` request
without an admin session, and the dashboard shows that refusal as an error on
the page. No data is shown until a server-side access method (for example
Cloudflare Access) and the data endpoints exist. The ten data endpoints behind the
pages are specified in [`docs/admin-api.md`](docs/admin-api.md) but **do not
exist yet** (where they will be served from is still to be decided), so
outside mock mode every data page shows "not available on the backend yet".

## Stack

React 19 · TypeScript · Vite · React Router · TanStack Query · Vitest.
Charts are hand-built SVG (no chart library).

## Run it

Requires Node 22 (pinned in `.prototools`).

```bash
npm install
npm run dev:mock      # generated sample data
npm run dev           # proxies /api/admin to the local admin auth service
```

Open the dashboard at **<http://ats-admin.localhost:5070>**, not
`127.0.0.1`: the auth service accepts plain-http origins only on
`*.localhost`, and its session cookie is bound to that host. The dev server
listens on 127.0.0.1 only and refuses to start if its port is taken (for
example by an SSH tunnel to the preview); set `ADMIN_PORT` to another port
then, and use the matching origin. (Not 5060: browsers block that port.)

`npm run dev` forwards only `/api/admin` to `ADMIN_AUTH_PROXY_TARGET`
(default `http://127.0.0.1:5071`, the auth service's development address).
The auth service must list the exact dashboard origin, e.g.
`ADMIN_AUTH_ALLOWED_ORIGINS=http://ats-admin.localhost:5070`. Any other `/api`
path gets 404 from the dev server and is never forwarded, so nothing reaches
the customer backend. Copy `.env.example` to `.env.local` to change the
target or port.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` / `dev:mock` | Dev server on 127.0.0.1, live or mock data |
| `npm test` | Unit and component tests |
| `npm run typecheck` | TypeScript only |
| `npm run build` | Type-check and build `dist/` |
| `npm run check:bundle` | Fail if a secret-looking string or mock data reached `dist/` |

## Pages

| Page | Shows |
|---|---|
| Overview | Revenue, users, active users, scans, credits consumed, with trends and deltas |
| Users | Searchable list with status, credits, activity; per-user detail |
| Scans | Volume, outcomes, failure rate, history |
| Credits | Outstanding balance, consumption, purchases, ledger |
| Revenue | Verified revenue, failed payments, abandoned checkouts, refunds |
| System health | Backend service checks and recent errors |

## Security model

- The UI is not the security boundary. The admin auth service refuses every
  `/api/admin` request without a valid session (deny by default).
- There is no sign-in page and no client-side route guard. The dashboard
  never sees or stores a token (nothing in `sessionStorage` or
  `localStorage`) and sends no `Authorization` header; any session is the auth
  service's HttpOnly `__Host-ats_admin` cookie.
- Requests are same-origin with `credentials: 'same-origin'`.
- A `401` or `403` is shown on the page as a refusal, with no data; a `404` as
  "not available on the backend yet"; a web page returned where data was
  expected as "No admin API answered at this address". Nothing is ever
  replaced with other data.
- Automatic requests (health polling) send `x-ats-admin-background: 1` so they
  never keep an idle session alive.
- Only `VITE_API_BASE_URL` is compiled into the bundle. No Supabase, Razorpay
  or other keys are ever used here; `check:bundle` enforces it.
- Mock data is development-only and stripped from production builds.
- Cloudflare Access on `admin.atsscanai.com` is planned but **not in place**
  (checked 2026-10-23); see [`docs/deployment.md`](docs/deployment.md).

## Layout

```
src/
  api/        typed client, admin endpoints, mock implementation
  components/ layout, tables, filters, stat tiles, trend chart, badges
  lib/        formatting, URL-backed filter state
  pages/      one file per dashboard page
docs/         admin API contract, deployment and rollback
auth-service/ separate admin authentication service (Node 22, Fastify);
              built and tested locally, not deployed or wired to the UI yet.
              See auth-service/README.md
```
