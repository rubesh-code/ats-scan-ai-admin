import { request } from '@/api/client';
import type {
  AdminSession,
  AdminUser,
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

/**
 * Every call the dashboard makes. Pages import `adminApi` and never call
 * `fetch` themselves, so the mock implementation can stand in for all of it.
 */
export type AdminApi = {
  sendOtp(email: string): Promise<void>;
  verifyOtp(email: string, otp: string): Promise<AdminSession>;
  me(): Promise<AdminUser>;
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
  health(): Promise<SystemHealth>;
};

export const httpAdminApi: AdminApi = {
  async sendOtp(email) {
    await request('/api/admin/auth/send-otp', { method: 'POST', body: { email }, auth: false });
  },
  verifyOtp(email, otp) {
    return request('/api/admin/auth/verify-otp', {
      method: 'POST',
      body: { email, otp },
      auth: false,
    });
  },
  me() {
    return request('/api/admin/me');
  },
  async logout() {
    await request('/api/admin/auth/logout', { method: 'POST' });
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
  health() {
    return request('/api/admin/health');
  },
};
