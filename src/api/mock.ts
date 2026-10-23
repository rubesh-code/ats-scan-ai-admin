import type { AdminApi } from '@/api/admin';
import { ApiError } from '@/api/client';
import type {
  AccountStatus,
  CreditTransaction,
  DailyPoint,
  Page,
  PaymentRecord,
  RangeKey,
  ScanRecord,
  UserSummary,
} from '@/api/types';

/**
 * Development-only sample data, generated from a fixed seed so every reload
 * shows the same numbers. Loaded only when `npm run dev:mock` is used; see
 * src/api/index.ts. Sign in with any username and the password below.
 *
 * Auth follows the auth service's contract. The "cookie" is a module-level
 * flag: nothing is written to storage, and a reload signs you out.
 */

export const MOCK_PASSWORD = 'mock-password';
const MOCK_SESSION_MS = 8 * 3_600_000;
const MOCK_IDLE_MS = 30 * 60_000;

let mockSignedInAs: string | null = null;
let mockSessionStartedAt = 0;

function mockSession(username: string) {
  const now = Date.now();
  const expiresAt = mockSessionStartedAt + MOCK_SESSION_MS;
  return {
    admin: { id: 'adm_mock', username, role: 'owner' as const },
    expiresAt: new Date(expiresAt).toISOString(),
    idleExpiresAt: new Date(Math.min(now + MOCK_IDLE_MS, expiresAt)).toISOString(),
  };
}
const DAY = 86_400_000;
const HISTORY_DAYS = 180;

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261021);
const pick = <T,>(items: readonly T[]) => items[Math.floor(rand() * items.length)] as T;
const id = (prefix: string, n: number) => `${prefix}_${n.toString(36).padStart(6, '0')}`;

const FIRST = ['Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Ananya', 'Ishaan', 'Saanvi', 'Vihaan', 'Priya', 'Arjun', 'Nisha'];
const LAST = ['Sharma', 'Iyer', 'Khan', 'Patel', 'Reddy', 'Nair', 'Gupta', 'Das', 'Menon', 'Singh'];
const ROLES = ['DevOps Engineer', 'Frontend Developer', 'Data Analyst', 'Product Manager', 'QA Engineer', null];
const FAILURES = ['Could not read text from the PDF', 'AI analysis timed out', 'File too large'];
const PACKAGES = [
  { name: 'Starter · 10 credits', amountInr: 99, credits: 10 },
  { name: 'Pro · 30 credits', amountInr: 249, credits: 30 },
];

const now = Date.UTC(2026, 9, 21, 12);
const startOfDay = (t: number) => t - (t % DAY);

const users: UserSummary[] = [];
const scans: ScanRecord[] = [];
const payments: PaymentRecord[] = [];
const transactions: CreditTransaction[] = [];

for (let i = 0; i < 260; i += 1) {
  // More recent signups than old ones, so the trend line has a shape.
  const age = Math.floor(HISTORY_DAYS * rand() ** 1.6);
  const createdAt = now - age * DAY - Math.floor(rand() * DAY);
  const first = pick(FIRST);
  const last = pick(LAST);
  users.push({
    id: id('usr', i + 1),
    name: `${first} ${last}`,
    email: `${first}.${last}${i}@example.com`.toLowerCase(),
    status: rand() < 0.03 ? 'suspended' : 'active',
    credits: 0,
    totalScans: 0,
    avgScore: 0,
    createdAt: new Date(createdAt).toISOString(),
    lastActiveAt: null,
  });
}

let scanN = 0;
let payN = 0;
let txN = 0;

for (const user of users) {
  const joined = Date.parse(user.createdAt);
  let balance = 3; // signup bonus
  transactions.push({
    id: id('ctx', ++txN),
    userId: user.id,
    userEmail: user.email,
    type: 'adjustment',
    credits: 3,
    description: 'Welcome credits',
    paymentId: null,
    scanId: null,
    createdAt: user.createdAt,
  });

  const activity = Math.floor(rand() * 14);
  let scoreSum = 0;
  let completed = 0;
  let lastActive = joined;

  for (let k = 0; k < activity; k += 1) {
    const at = joined + Math.floor(rand() * Math.max(DAY, now - joined));
    if (at > now) continue;

    if (balance <= 0) {
      const pkg = pick(PACKAGES);
      const roll = rand();
      const status = roll < 0.82 ? 'paid' : roll < 0.94 ? 'failed' : 'created';
      const payment: PaymentRecord = {
        id: id('pay', ++payN),
        userId: user.id,
        userEmail: user.email,
        provider: 'razorpay',
        providerOrderId: `order_${(payN * 7919).toString(36)}`,
        providerPaymentId: status === 'created' ? null : `pay_${(payN * 104729).toString(36)}`,
        packageName: pkg.name,
        amountInr: pkg.amountInr,
        credits: pkg.credits,
        status,
        createdAt: new Date(at).toISOString(),
        verifiedAt: status === 'paid' ? new Date(at + 40_000).toISOString() : null,
      };
      payments.push(payment);
      if (status !== 'paid') continue;
      balance += pkg.credits;
      transactions.push({
        id: id('ctx', ++txN),
        userId: user.id,
        userEmail: user.email,
        type: 'purchase',
        credits: pkg.credits,
        description: pkg.name,
        paymentId: payment.id,
        scanId: null,
        createdAt: payment.verifiedAt!,
      });
    }

    const failed = rand() < 0.06;
    const score = failed ? null : Math.round(35 + rand() * 62);
    const scan: ScanRecord = {
      id: id('scn', ++scanN),
      userId: user.id,
      userEmail: user.email,
      filename: `${user.name.replace(' ', '_')}_Resume.pdf`,
      score,
      status: failed ? 'failed' : 'completed',
      type: rand() < 0.4 ? 'job_description' : 'job_role',
      jobRole: pick(ROLES),
      creditUsed: failed ? 0 : 1,
      failureReason: failed ? pick(FAILURES) : null,
      createdAt: new Date(at).toISOString(),
    };
    scans.push(scan);
    lastActive = Math.max(lastActive, at);

    if (!failed) {
      balance -= 1;
      completed += 1;
      scoreSum += score!;
      transactions.push({
        id: id('ctx', ++txN),
        userId: user.id,
        userEmail: user.email,
        type: 'scan',
        credits: -1,
        description: 'Resume scan',
        paymentId: null,
        scanId: scan.id,
        createdAt: scan.createdAt,
      });
    }
  }

  user.credits = Math.max(0, balance);
  user.totalScans = completed;
  user.avgScore = completed ? Math.round(scoreSum / completed) : 0;
  user.lastActiveAt = activity > 0 ? new Date(lastActive).toISOString() : null;
}

const newestFirst = (a: { createdAt: string }, b: { createdAt: string }) =>
  b.createdAt.localeCompare(a.createdAt);
users.sort(newestFirst);
scans.sort(newestFirst);
payments.sort(newestFirst);
transactions.sort(newestFirst);

const RANGE_DAYS: Record<RangeKey, number> = { '7d': 7, '30d': 30, '90d': 90 };

function period(range: RangeKey, offset = 0) {
  const days = RANGE_DAYS[range];
  const end = startOfDay(now) + DAY - offset * days * DAY;
  return { start: end - days * DAY, end, days };
}

const inWindow = (iso: string, w: { start: number; end: number }) => {
  const t = Date.parse(iso);
  return t >= w.start && t < w.end;
};

function daily<T>(
  items: T[],
  range: RangeKey,
  when: (item: T) => string | null,
  amount: (item: T) => number = () => 1,
): DailyPoint[] {
  const w = period(range);
  const buckets = new Array<number>(w.days).fill(0);
  for (const item of items) {
    const at = when(item);
    if (!at || !inWindow(at, w)) continue;
    const index = Math.floor((Date.parse(at) - w.start) / DAY);
    buckets[index] = (buckets[index] ?? 0) + amount(item);
  }
  return buckets.map((value, i) => ({
    date: new Date(w.start + i * DAY).toISOString().slice(0, 10),
    value,
  }));
}

const sum = (points: DailyPoint[]) => points.reduce((total, p) => total + p.value, 0);

function paginate<T>(items: T[], page = 1, pageSize = 25): Page<T> {
  const size = Math.min(Math.max(pageSize, 1), 100);
  const current = Math.max(page, 1);
  return {
    items: items.slice((current - 1) * size, current * size),
    page: current,
    pageSize: size,
    total: items.length,
  };
}

const matches = (needle: string | undefined, ...haystack: (string | null)[]) => {
  if (!needle) return true;
  const n = needle.trim().toLowerCase();
  return haystack.some((h) => h?.toLowerCase().includes(n));
};

const delay = <T,>(value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(structuredClone(value)), 150 + rand() * 250));

const consumed = (t: CreditTransaction) => (t.credits < 0 ? -t.credits : 0);
const purchased = (t: CreditTransaction) => (t.type === 'purchase' ? t.credits : 0);
const revenue = (p: PaymentRecord) => (p.status === 'paid' ? p.amountInr : 0);

export const mockAdminApi: AdminApi = {
  async login(username, password) {
    await delay(null);
    const name = username.trim().toLowerCase();
    if (!name || password !== MOCK_PASSWORD) {
      throw new ApiError(401, 'Invalid username or password.');
    }
    mockSignedInAs = name;
    mockSessionStartedAt = Date.now();
    return mockSession(name);
  },
  async me() {
    await delay(null);
    if (!mockSignedInAs || Date.now() >= mockSessionStartedAt + MOCK_SESSION_MS) {
      mockSignedInAs = null;
      throw new ApiError(401, 'Authentication required.');
    }
    return mockSession(mockSignedInAs);
  },
  async logout() {
    await delay(null);
    mockSignedInAs = null;
  },

  overview(range) {
    const w = period(range);
    const prev = period(range, 1);
    const activeCutoff = now - 30 * DAY;
    const signups = daily(users, range, (u) => u.createdAt);
    const scanTrend = daily(scans, range, (s) => s.createdAt);
    const creditTrend = daily(transactions, range, (t) => t.createdAt, consumed);
    const revenueTrend = daily(payments, range, (p) => p.verifiedAt, revenue);
    const prevCount = <T,>(items: T[], when: (i: T) => string | null, amount: (i: T) => number = () => 1) =>
      items.reduce((n, i) => {
        const at = when(i);
        return at && inWindow(at, prev) ? n + amount(i) : n;
      }, 0);

    return delay({
      range,
      activeWindowDays: 30,
      totals: {
        users: users.filter((u) => Date.parse(u.createdAt) < w.end).length,
        activeUsers: users.filter((u) => u.lastActiveAt && Date.parse(u.lastActiveAt) >= activeCutoff).length,
        scans: sum(scanTrend),
        creditsConsumed: sum(creditTrend),
        verifiedRevenueInr: sum(revenueTrend),
      },
      current: { newUsers: sum(signups) },
      previous: {
        newUsers: prevCount(users, (u) => u.createdAt),
        scans: prevCount(scans, (s) => s.createdAt),
        creditsConsumed: prevCount(transactions, (t) => t.createdAt, consumed),
        verifiedRevenueInr: prevCount(payments, (p) => p.verifiedAt, revenue),
      },
      trends: {
        signups,
        scans: scanTrend,
        creditsConsumed: creditTrend,
        verifiedRevenueInr: revenueTrend,
      },
    });
  },

  users({ search, status, page, pageSize }) {
    const filtered = users.filter(
      (u) => matches(search, u.name, u.email, u.id) && (!status || u.status === (status as AccountStatus)),
    );
    return delay(paginate(filtered, page, pageSize));
  },
  user(userId) {
    const user = users.find((u) => u.id === userId);
    if (!user) return Promise.reject(new ApiError(404, 'User not found.'));
    return delay({
      user,
      recentScans: scans.filter((s) => s.userId === userId).slice(0, 10),
      recentTransactions: transactions.filter((t) => t.userId === userId).slice(0, 10),
      recentPayments: payments.filter((p) => p.userId === userId).slice(0, 10),
    });
  },

  scans({ search, status, page, pageSize }) {
    const filtered = scans.filter(
      (s) => matches(search, s.userEmail, s.filename, s.jobRole, s.id) && (!status || s.status === status),
    );
    return delay(paginate(filtered, page, pageSize));
  },
  scanSummary(range) {
    const w = period(range);
    const inRange = scans.filter((s) => inWindow(s.createdAt, w));
    const done = inRange.filter((s) => s.status === 'completed');
    return delay({
      range,
      total: inRange.length,
      completed: done.length,
      failed: inRange.length - done.length,
      avgScore: done.length ? Math.round(done.reduce((n, s) => n + (s.score ?? 0), 0) / done.length) : null,
      trend: daily(scans, range, (s) => s.createdAt),
    });
  },

  creditTransactions({ search, type, page, pageSize }) {
    const filtered = transactions.filter(
      (t) => matches(search, t.userEmail, t.description, t.id) && (!type || t.type === type),
    );
    return delay(paginate(filtered, page, pageSize));
  },
  creditSummary(range) {
    const w = period(range);
    const inRange = transactions.filter((t) => inWindow(t.createdAt, w));
    return delay({
      range,
      outstandingBalance: users.reduce((n, u) => n + u.credits, 0),
      consumed: inRange.reduce((n, t) => n + consumed(t), 0),
      purchased: inRange.reduce((n, t) => n + purchased(t), 0),
      trend: daily(transactions, range, (t) => t.createdAt, consumed),
    });
  },

  payments({ search, status, page, pageSize }) {
    const filtered = payments.filter(
      (p) =>
        matches(search, p.userEmail, p.providerOrderId, p.providerPaymentId, p.id) &&
        (!status || p.status === status),
    );
    return delay(paginate(filtered, page, pageSize));
  },
  paymentSummary(range) {
    const w = period(range);
    const inRange = payments.filter((p) => inWindow(p.createdAt, w));
    const paid = inRange.filter((p) => p.status === 'paid');
    return delay({
      range,
      verifiedRevenueInr: paid.reduce((n, p) => n + p.amountInr, 0),
      verifiedCount: paid.length,
      failedCount: inRange.filter((p) => p.status === 'failed').length,
      pendingCount: inRange.filter((p) => p.status === 'created').length,
      refundedCount: null,
      refundedInr: null,
      trend: daily(payments, range, (p) => p.verifiedAt, revenue),
    });
  },

  health() {
    return delay({
      checkedAt: new Date().toISOString(),
      checks: [
        { name: 'API', status: 'ok' as const, latencyMs: 42, detail: null },
        { name: 'Database', status: 'ok' as const, latencyMs: 87, detail: null },
        { name: 'Email (OTP delivery)', status: 'ok' as const, latencyMs: 310, detail: null },
        { name: 'AI analysis', status: 'degraded' as const, latencyMs: 4200, detail: 'Slow responses in the last hour' },
      ],
      recentErrors: null,
    });
  },
};
