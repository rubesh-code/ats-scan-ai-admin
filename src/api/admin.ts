import { request } from '@/api/client';
import type {
  AdminSession,
  CreditSummary,
  CreditTransaction,
  CreditTransactionType,
  ListQuery,
  Overview,
  Page,
  PaymentRecord,
  PaymentStatus,
  PaymentSummary,
  RangeKey,
  ScanRecord,
  ScanStatus,
  ScanSummary,
  SystemHealth,
  UserDetail,
  UserSummary,
  AccountStatus,
} from '@/api/types';

/** For calls that run automatically rather than because the admin did something. */
export type CallOptions = { background?: boolean };

/**
 * Every call the dashboard makes. Pages import `adminApi` and never call
 * `fetch` themselves, so the mock implementation can stand in for all of it.
 *
 * The three auth calls are the auth service's actual contract
 * (auth-service/src/app.ts). The data calls are specified in
 * docs/admin-api.md and are not implemented by any backend yet.
 */
export type AdminApi = {
  /** POST /api/admin/auth/login. Sets the HttpOnly session cookie. */
  login(username: string, password: string): Promise<AdminSession>;
  /**
   * GET /api/admin/auth/me. `startup` marks the initial check, where a 401
   * just means "not signed in" rather than "session expired".
   */
  me(options?: CallOptions & { startup?: boolean }): Promise<AdminSession>;
  /** POST /api/admin/auth/logout. Deletes the session and clears the cookie. */
  logout(): Promise<void>;

  overview(range: RangeKey): Promise<Overview>;
  users(query: ListQuery & { status?: AccountStatus }): Promise<Page<UserSummary>>;
  user(id: string): Promise<UserDetail>;
  scans(query: ListQuery & { status?: ScanStatus }): Promise<Page<ScanRecord>>;
  scanSummary(range: RangeKey): Promise<ScanSummary>;
  creditTransactions(
    query: ListQuery & { type?: CreditTransactionType },
  ): Promise<Page<CreditTransaction>>;
  creditSummary(range: RangeKey): Promise<CreditSummary>;
  payments(query: ListQuery & { status?: PaymentStatus }): Promise<Page<PaymentRecord>>;
  paymentSummary(range: RangeKey): Promise<PaymentSummary>;
  health(options?: CallOptions): Promise<SystemHealth>;
};

export const httpAdminApi: AdminApi = {
  login(username, password) {
    // A 401 here is a wrong password, not an expired session.
    return request('/api/admin/auth/login', {
      method: 'POST',
      body: { username, password },
      signOutOn401: false,
    });
  },
  me({ background = false, startup = false } = {}) {
    return request('/api/admin/auth/me', { background, signOutOn401: !startup });
  },
  async logout() {
    await request('/api/admin/auth/logout', { method: 'POST', signOutOn401: false });
  },

  overview(range) {
    return request('/api/admin/overview', { query: { range } });
  },
  users(query) {
    return request('/api/admin/users', { query });
  },
  user(id) {
    return request(`/api/admin/users/${encodeURIComponent(id)}`);
  },
  scans(query) {
    return request('/api/admin/scans', { query });
  },
  scanSummary(range) {
    return request('/api/admin/scans/summary', { query: { range } });
  },
  creditTransactions(query) {
    return request('/api/admin/credits/transactions', { query });
  },
  creditSummary(range) {
    return request('/api/admin/credits/summary', { query: { range } });
  },
  payments(query) {
    return request('/api/admin/payments', { query });
  },
  paymentSummary(range) {
    return request('/api/admin/payments/summary', { query: { range } });
  },
  health({ background = false } = {}) {
    return request('/api/admin/health', { background });
  },
};
