import type { PaymentRow, ScanRow, Snapshot, TransactionRow, UserRow } from './source.js';
import type {
  CreditSummary,
  CreditTransaction,
  CreditTransactionType,
  DailyPoint,
  Overview,
  Page,
  PaymentRecord,
  PaymentStatus,
  PaymentSummary,
  RangeKey,
  ScanRecord,
  ScanSummary,
  UserDetail,
  UserSummary,
} from './types.js';

/**
 * Turns database rows into the dashboard's response shapes. Pure: the same
 * snapshot and clock always give the same answer. Definitions follow
 * docs/admin-api.md, matching src/api/mock.ts.
 */

const DAY = 86_400_000;
export const ACTIVE_WINDOW_DAYS = 30;
export const RANGE_DAYS: Record<RangeKey, number> = { '7d': 7, '30d': 30, '90d': 90 };

const time = (iso: string | null) => (iso ? Date.parse(iso) : NaN);
const iso = (value: string) => new Date(value).toISOString();
const isoOrNull = (value: string | null) => (value ? iso(value) : null);
const num = (value: number | string | null) => (value === null ? null : Number(value));

/* ------------------------------------------------------- row mapping ------ */

/** Stored as 'Completed' by the customer backend; anything else did not finish. */
const scanStatus = (row: ScanRow) => (row.status?.toLowerCase() === 'completed' ? 'completed' : 'failed');

const TRANSACTION_TYPES: Record<string, CreditTransactionType> = {
  purchase: 'purchase',
  scan: 'scan',
  resume_rewrite: 'rewrite',
  rewrite: 'rewrite',
  refund: 'refund',
};

const PAYMENT_STATUSES: ReadonlySet<string> = new Set<PaymentStatus>(['created', 'paid', 'failed', 'refunded']);

function mapped(snapshot: Snapshot) {
  const emails = new Map(snapshot.users.map((u) => [u.id, u.email]));
  const packages = new Map(snapshot.packages.map((p) => [p.id, p.name]));
  const emailOf = (userId: string) => emails.get(userId) ?? '';

  // Last activity: a scan, a rewrite or a sign-in.
  const lastActive = new Map<string, number>();
  const touch = (userId: string | undefined, at: string) => {
    const t = time(at);
    if (!userId || Number.isNaN(t)) return;
    if (t > (lastActive.get(userId) ?? -Infinity)) lastActive.set(userId, t);
  };
  for (const s of snapshot.scans) touch(s.user_id, s.created_at);
  for (const t of snapshot.transactions) if (t.type === 'resume_rewrite') touch(t.user_id, t.created_at);
  const idByEmail = new Map(snapshot.users.map((u) => [u.email.trim().toLowerCase(), u.id]));
  for (const s of snapshot.signIns) touch(idByEmail.get(s.email.trim().toLowerCase()), s.created_at);

  const user = (row: UserRow): UserSummary => {
    const active = lastActive.get(row.id);
    return {
      id: row.id,
      name: row.name ?? '',
      email: row.email,
      // No status column yet: every account is active.
      status: 'active',
      credits: row.credits ?? 0,
      totalScans: row.total_scans ?? 0,
      avgScore: Math.round(num(row.avg_score) ?? 0),
      createdAt: iso(row.created_at),
      lastActiveAt: active === undefined ? null : new Date(active).toISOString(),
    };
  };

  const scan = (row: ScanRow): ScanRecord => {
    const status = scanStatus(row);
    return {
      id: row.id,
      userId: row.user_id,
      userEmail: emailOf(row.user_id),
      filename: row.filename ?? '',
      score: status === 'completed' ? num(row.score) : null,
      status,
      type: row.type,
      jobRole: row.job_role,
      creditUsed: row.credit_used ?? 0,
      // Failure reasons are not stored by the customer backend.
      failureReason: null,
      createdAt: iso(row.created_at),
    };
  };

  const transaction = (row: TransactionRow): CreditTransaction => ({
    id: row.id,
    userId: row.user_id,
    userEmail: emailOf(row.user_id),
    type: TRANSACTION_TYPES[row.type] ?? 'adjustment',
    credits: row.credits,
    description: row.description,
    paymentId: row.payment_id,
    scanId: row.scan_id,
    createdAt: iso(row.created_at),
  });

  const payment = (row: PaymentRow): PaymentRecord => {
    const provider = row.payment_gateway ?? 'razorpay';
    return {
      id: row.id,
      userId: row.user_id,
      userEmail: emailOf(row.user_id),
      provider,
      providerOrderId: (provider === 'cashfree' ? row.cashfree_order_id : row.razorpay_order_id) ?? '',
      providerPaymentId: provider === 'cashfree' ? null : row.razorpay_payment_id,
      packageName: row.package_id ? (packages.get(row.package_id) ?? null) : null,
      amountInr: row.amount_inr,
      credits: row.credits,
      status: PAYMENT_STATUSES.has(row.status) ? (row.status as PaymentStatus) : 'created',
      createdAt: iso(row.created_at),
      verifiedAt: isoOrNull(row.verified_at),
    };
  };

  const newestFirst = (a: { createdAt: string }, b: { createdAt: string }) => b.createdAt.localeCompare(a.createdAt);

  return {
    users: snapshot.users.map(user).sort(newestFirst),
    scans: snapshot.scans.map(scan).sort(newestFirst),
    transactions: snapshot.transactions.map(transaction).sort(newestFirst),
    payments: snapshot.payments.map(payment).sort(newestFirst),
  };
}

type Mapped = ReturnType<typeof mapped>;

/* ----------------------------------------------------------- windows ------ */

type Window = { start: number; end: number; days: number };

/** The selected range ends at the close of today (UTC); offset 1 is the period before it. */
function period(range: RangeKey, now: number, offset = 0): Window {
  const days = RANGE_DAYS[range];
  const end = now - (now % DAY) + DAY - offset * days * DAY;
  return { start: end - days * DAY, end, days };
}

const inWindow = (at: string | null, w: Window) => {
  const t = time(at);
  return t >= w.start && t < w.end;
};

function daily<T>(items: T[], w: Window, when: (item: T) => string | null, amount: (item: T) => number = () => 1): DailyPoint[] {
  const buckets = new Array<number>(w.days).fill(0);
  for (const item of items) {
    const at = when(item);
    if (!inWindow(at, w)) continue;
    const index = Math.floor((time(at) - w.start) / DAY);
    buckets[index] = (buckets[index] ?? 0) + amount(item);
  }
  return buckets.map((value, i) => ({ date: new Date(w.start + i * DAY).toISOString().slice(0, 10), value }));
}

function total<T>(items: T[], w: Window, when: (item: T) => string | null, amount: (item: T) => number = () => 1) {
  return items.reduce((n, item) => (inWindow(when(item), w) ? n + amount(item) : n), 0);
}

const consumed = (t: CreditTransaction) => (t.credits < 0 ? -t.credits : 0);
const purchased = (t: CreditTransaction) => (t.type === 'purchase' ? t.credits : 0);
const revenue = (p: PaymentRecord) => (p.status === 'paid' ? p.amountInr : 0);

/* ----------------------------------------------------------- reports ------ */

export type ListQuery = { page: number; pageSize: number; search: string | null };

function paginate<T>(items: T[], query: ListQuery): Page<T> {
  const start = (query.page - 1) * query.pageSize;
  return {
    items: items.slice(start, start + query.pageSize),
    page: query.page,
    pageSize: query.pageSize,
    total: items.length,
  };
}

function matches(search: string | null, ...haystack: (string | null)[]) {
  if (!search) return true;
  const needle = search.toLowerCase();
  return haystack.some((h) => h?.toLowerCase().includes(needle));
}

export function reports(snapshot: Snapshot, now: number) {
  const data: Mapped = mapped(snapshot);

  return {
    overview(range: RangeKey): Overview {
      const w = period(range, now);
      const prev = period(range, now, 1);
      const activeSince = now - ACTIVE_WINDOW_DAYS * DAY;
      const signups = daily(data.users, w, (u) => u.createdAt);
      const scans = daily(data.scans, w, (s) => s.createdAt);
      const credits = daily(data.transactions, w, (t) => t.createdAt, consumed);
      const money = daily(data.payments, w, (p) => p.verifiedAt, revenue);
      const sum = (points: DailyPoint[]) => points.reduce((n, p) => n + p.value, 0);
      return {
        range,
        activeWindowDays: ACTIVE_WINDOW_DAYS,
        totals: {
          users: data.users.filter((u) => time(u.createdAt) < w.end).length,
          activeUsers: data.users.filter((u) => u.lastActiveAt && time(u.lastActiveAt) >= activeSince).length,
          scans: sum(scans),
          creditsConsumed: sum(credits),
          verifiedRevenueInr: sum(money),
        },
        current: { newUsers: sum(signups) },
        previous: {
          newUsers: total(data.users, prev, (u) => u.createdAt),
          scans: total(data.scans, prev, (s) => s.createdAt),
          creditsConsumed: total(data.transactions, prev, (t) => t.createdAt, consumed),
          verifiedRevenueInr: total(data.payments, prev, (p) => p.verifiedAt, revenue),
        },
        trends: { signups, scans, creditsConsumed: credits, verifiedRevenueInr: money },
      };
    },

    users(query: ListQuery & { status: UserSummary['status'] | null }): Page<UserSummary> {
      return paginate(
        data.users.filter(
          (u) => matches(query.search, u.name, u.email, u.id) && (!query.status || u.status === query.status),
        ),
        query,
      );
    },

    user(id: string): UserDetail | null {
      const user = data.users.find((u) => u.id === id);
      if (!user) return null;
      return {
        user,
        recentScans: data.scans.filter((s) => s.userId === id).slice(0, 10),
        recentTransactions: data.transactions.filter((t) => t.userId === id).slice(0, 10),
        recentPayments: data.payments.filter((p) => p.userId === id).slice(0, 10),
      };
    },

    scans(query: ListQuery & { status: ScanRecord['status'] | null }): Page<ScanRecord> {
      return paginate(
        data.scans.filter(
          (s) =>
            matches(query.search, s.userEmail, s.filename, s.jobRole, s.id) &&
            (!query.status || s.status === query.status),
        ),
        query,
      );
    },

    scanSummary(range: RangeKey): ScanSummary {
      const w = period(range, now);
      const inRange = data.scans.filter((s) => inWindow(s.createdAt, w));
      const done = inRange.filter((s) => s.status === 'completed');
      return {
        range,
        total: inRange.length,
        completed: done.length,
        failed: inRange.length - done.length,
        avgScore: done.length ? Math.round(done.reduce((n, s) => n + (s.score ?? 0), 0) / done.length) : null,
        trend: daily(data.scans, w, (s) => s.createdAt),
      };
    },

    creditTransactions(query: ListQuery & { type: CreditTransactionType | null }): Page<CreditTransaction> {
      return paginate(
        data.transactions.filter(
          (t) => matches(query.search, t.userEmail, t.description, t.id) && (!query.type || t.type === query.type),
        ),
        query,
      );
    },

    creditSummary(range: RangeKey): CreditSummary {
      const w = period(range, now);
      return {
        range,
        outstandingBalance: data.users.reduce((n, u) => n + u.credits, 0),
        consumed: total(data.transactions, w, (t) => t.createdAt, consumed),
        purchased: total(data.transactions, w, (t) => t.createdAt, purchased),
        trend: daily(data.transactions, w, (t) => t.createdAt, consumed),
      };
    },

    payments(query: ListQuery & { status: PaymentStatus | null }): Page<PaymentRecord> {
      return paginate(
        data.payments.filter(
          (p) =>
            matches(query.search, p.userEmail, p.providerOrderId, p.providerPaymentId, p.id) &&
            (!query.status || p.status === query.status),
        ),
        query,
      );
    },

    paymentSummary(range: RangeKey): PaymentSummary {
      const w = period(range, now);
      const inRange = data.payments.filter((p) => inWindow(p.createdAt, w));
      const paid = inRange.filter((p) => p.status === 'paid');
      return {
        range,
        verifiedRevenueInr: paid.reduce((n, p) => n + p.amountInr, 0),
        verifiedCount: paid.length,
        failedCount: inRange.filter((p) => p.status === 'failed').length,
        pendingCount: inRange.filter((p) => p.status === 'created').length,
        // Not recorded until a refund webhook exists; the UI says "not tracked".
        refundedCount: null,
        refundedInr: null,
        trend: daily(data.payments, w, (p) => p.verifiedAt, revenue),
      };
    },
  };
}
