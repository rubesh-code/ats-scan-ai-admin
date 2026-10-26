/**
 * Response shapes, copied from the dashboard's src/api/types.ts (the contract).
 * test/contract.test.ts fails the typecheck if the two drift apart.
 */

export type RangeKey = '7d' | '30d' | '90d';

export type Page<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
};

/** One point per UTC day, oldest first, with no gaps (zero-filled). */
export type DailyPoint = { date: string; value: number };

export type Overview = {
  range: RangeKey;
  /** How "active" is defined: any scan, rewrite or login within this window. */
  activeWindowDays: number;
  totals: {
    users: number;
    activeUsers: number;
    scans: number;
    creditsConsumed: number;
    verifiedRevenueInr: number;
  };
  /** Same figures for the previous period of equal length, for deltas. */
  previous: {
    newUsers: number;
    scans: number;
    creditsConsumed: number;
    verifiedRevenueInr: number;
  };
  current: {
    newUsers: number;
  };
  trends: {
    signups: DailyPoint[];
    scans: DailyPoint[];
    creditsConsumed: DailyPoint[];
    verifiedRevenueInr: DailyPoint[];
  };
};

export type AccountStatus = 'active' | 'suspended';

export type UserSummary = {
  id: string;
  name: string;
  email: string;
  status: AccountStatus;
  credits: number;
  totalScans: number;
  avgScore: number;
  createdAt: string;
  lastActiveAt: string | null;
};

export type ScanStatus = 'completed' | 'failed';

export type ScanRecord = {
  id: string;
  userId: string;
  userEmail: string;
  filename: string;
  score: number | null;
  status: ScanStatus;
  /** 'job_description' | 'job_role' as stored by the backend. */
  type: string | null;
  jobRole: string | null;
  creditUsed: number;
  /** Present on failures only; a short, already-sanitised reason. */
  failureReason: string | null;
  createdAt: string;
};

export type ScanSummary = {
  range: RangeKey;
  total: number;
  completed: number;
  failed: number;
  avgScore: number | null;
  trend: DailyPoint[];
};

export type CreditTransactionType = 'purchase' | 'scan' | 'rewrite' | 'adjustment' | 'refund';

export type CreditTransaction = {
  id: string;
  userId: string;
  userEmail: string;
  type: CreditTransactionType;
  /** Signed: purchases positive, consumption negative. */
  credits: number;
  description: string | null;
  paymentId: string | null;
  scanId: string | null;
  createdAt: string;
};

export type CreditSummary = {
  range: RangeKey;
  /** Sum of every user's current balance. */
  outstandingBalance: number;
  consumed: number;
  purchased: number;
  trend: DailyPoint[];
};

export type PaymentStatus = 'created' | 'paid' | 'failed' | 'refunded';

export type PaymentRecord = {
  id: string;
  userId: string;
  userEmail: string;
  provider: string;
  providerOrderId: string;
  providerPaymentId: string | null;
  packageName: string | null;
  amountInr: number;
  credits: number;
  status: PaymentStatus;
  createdAt: string;
  verifiedAt: string | null;
};

export type PaymentSummary = {
  range: RangeKey;
  verifiedRevenueInr: number;
  verifiedCount: number;
  failedCount: number;
  /** Abandoned checkouts: orders created but never paid or failed. */
  pendingCount: number;
  /**
   * Null until refunds are recorded (needs the Razorpay webhook). The UI says
   * "not tracked" rather than showing a misleading zero.
   */
  refundedCount: number | null;
  refundedInr: number | null;
  trend: DailyPoint[];
};

export type UserDetail = {
  user: UserSummary;
  recentScans: ScanRecord[];
  recentTransactions: CreditTransaction[];
  recentPayments: PaymentRecord[];
};

export type HealthState = 'ok' | 'degraded' | 'down';

export type HealthCheck = {
  name: string;
  status: HealthState;
  latencyMs: number | null;
  detail: string | null;
};

export type BackendError = {
  at: string;
  route: string;
  status: number;
  message: string;
};

export type SystemHealth = {
  checkedAt: string;
  checks: HealthCheck[];
  /** Null until the backend records errors somewhere queryable. */
  recentErrors: BackendError[] | null;
};

export type ListQuery = {
  page?: number;
  pageSize?: number;
  search?: string;
};
