# ATS Scan AI Admin

Internal admin dashboard for ATS Scan AI: users, scans, credits, verified
revenue and system health. A separate React app; it shares the existing
ATS Scan AI backend and database through dedicated `/api/admin` endpoints and
duplicates no data.

**Status:** the dashboard is built and runs against generated mock data. The
backend admin endpoints it needs are specified in
[`docs/admin-api.md`](docs/admin-api.md) and do not exist yet.

## Stack

React 19 · TypeScript · Vite · React Router · TanStack Query · Vitest.
Charts are hand-built SVG (no chart library).

## Run it

Requires Node 22 (pinned in `.prototools`).

```bash
npm install
npm run dev:mock      # sample data, sign in with any email and code 123456
npm run dev           # real backend: proxies /api to ADMIN_API_PROXY_TARGET
```

Both serve on <http://127.0.0.1:5070>. (Not 5060: browsers block that port.)
Copy `.env.example` to `.env.local` to change the API target or port.

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

- The UI is not the security boundary. The backend authorises every
  `/api/admin` request against an admin allowlist (see `docs/admin-api.md`).
- Admins sign in with an emailed one-time code and get a short-lived admin
  token, stored in `sessionStorage` (per tab, cleared on close) and dropped on
  any `401`/`403` or at expiry.
- Only `VITE_API_BASE_URL` is compiled into the bundle. No Supabase, Razorpay
  or other keys are ever used here; `check:bundle` enforces it.
- Mock data is development-only and stripped from production builds.
- Production access goes through Cloudflare Access on
  `admin.atsscanai.com`; see [`docs/deployment.md`](docs/deployment.md).

## Layout

```
src/
  api/        typed client, admin endpoints, mock implementation
  auth/       session storage, auth provider, login, route guard
  components/ layout, tables, filters, stat tiles, trend chart, badges
  lib/        formatting, URL-backed filter state
  pages/      one file per dashboard page
docs/         admin API contract, deployment and rollback
auth-service/ separate admin authentication service (Node 22, Fastify);
              built and tested locally, not deployed or wired to the UI yet.
              See auth-service/README.md
```
