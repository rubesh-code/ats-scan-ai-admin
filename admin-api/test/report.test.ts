import { describe, expect, it } from 'vitest';

import { reports } from '../src/report.js';
import { NOW, snapshot } from './fixtures.js';

const r = () => reports(snapshot(), NOW);
const list = { page: 1, pageSize: 25, search: null };

describe('overview', () => {
  // 7d = 20–26 Oct (UTC); the previous period = 13–19 Oct.
  it('counts the selected range and the period before it', () => {
    const o = r().overview('7d');
    expect(o.totals).toEqual({ users: 3, activeUsers: 3, scans: 3, creditsConsumed: 3, verifiedRevenueInr: 249 });
    expect(o.current).toEqual({ newUsers: 1 });
    expect(o.previous).toEqual({ newUsers: 1, scans: 1, creditsConsumed: 1, verifiedRevenueInr: 0 });
    expect(o.activeWindowDays).toBe(30);
  });

  it('gives one zero-filled point per UTC day, oldest first', () => {
    const { scans, verifiedRevenueInr } = r().overview('7d').trends;
    expect(scans.map((p) => p.date)).toEqual([
      '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26',
    ]);
    expect(scans.map((p) => p.value)).toEqual([0, 0, 0, 0, 1, 2, 0]);
    // Revenue is bucketed by verification time, and only paid orders count.
    expect(verifiedRevenueInr.map((p) => p.value)).toEqual([0, 0, 249, 0, 0, 0, 0]);
    expect(r().overview('90d').trends.signups).toHaveLength(90);
  });
});

describe('users', () => {
  it('lists newest first with last activity from scans, rewrites and sign-ins', () => {
    const page = r().users({ ...list, status: null });
    expect(page.total).toBe(3);
    expect(page.items.map((u) => [u.id, u.lastActiveAt])).toEqual([
      ['u2', '2026-10-25T11:00:00.000Z'], // a scan
      ['u3', '2026-10-21T10:00:00.000Z'], // a sign-in, matched case-insensitively by email
      ['u1', '2026-10-26T09:00:00.000Z'], // a rewrite
    ]);
    expect(page.items[2]).toMatchObject({ name: 'Asha', status: 'active', credits: 4, totalScans: 2, avgScore: 72 });
    expect(page.items[1]!.name).toBe('');
  });

  it('searches name, email and id, case-insensitively, and paginates', () => {
    expect(r().users({ ...list, search: 'RAVI', status: null }).items.map((u) => u.id)).toEqual(['u2']);
    expect(r().users({ ...list, status: 'suspended' }).total).toBe(0);
    const second = r().users({ page: 2, pageSize: 2, search: null, status: null });
    expect(second).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(second.items.map((u) => u.id)).toEqual(['u1']);
  });

  it('returns one user with their recent activity, or null', () => {
    const detail = r().user('u1')!;
    expect(detail.recentScans.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(detail.recentTransactions.map((t) => t.id)).toEqual(['t5', 't2', 't3', 't1']);
    expect(detail.recentPayments.map((p) => p.id)).toEqual(['p1']);
    expect(r().user('missing')).toBeNull();
  });
});

describe('scans', () => {
  it("maps the stored 'Completed' status, and gives failures no score", () => {
    const items = r().scans({ ...list, status: null }).items;
    expect(items.find((s) => s.id === 's1')).toMatchObject({ status: 'completed', score: 80, userEmail: 'asha@example.com' });
    expect(items.find((s) => s.id === 's4')).toMatchObject({ status: 'failed', score: null, failureReason: null });
    expect(r().scans({ ...list, status: 'failed' }).items.map((s) => s.id)).toEqual(['s4']);
    expect(r().scans({ ...list, search: 'devops', status: null }).items.map((s) => s.id)).toEqual(['s2']);
  });

  it('summarises a range', () => {
    expect(r().scanSummary('7d')).toMatchObject({ total: 3, completed: 2, failed: 1, avgScore: 70 });
  });
});

describe('credits', () => {
  it("maps 'resume_rewrite' to rewrite", () => {
    const page = r().creditTransactions({ ...list, type: 'rewrite' });
    expect(page.items.map((t) => [t.id, t.credits])).toEqual([['t5', -1]]);
  });

  it('summarises consumption, purchases and the outstanding balance', () => {
    expect(r().creditSummary('7d')).toMatchObject({ outstandingBalance: 7, consumed: 3, purchased: 0 });
    expect(r().creditSummary('30d')).toMatchObject({ consumed: 4, purchased: 5 });
  });
});

describe('payments', () => {
  it('reads Cashfree and Razorpay orders', () => {
    const items = r().payments({ ...list, status: null }).items;
    expect(items.find((p) => p.id === 'p1')).toMatchObject({
      provider: 'cashfree',
      providerOrderId: 'cf_order_1',
      providerPaymentId: null,
      packageName: 'Starter · 5 credits',
    });
    expect(items.find((p) => p.id === 'p3')).toMatchObject({
      provider: 'razorpay',
      providerOrderId: 'order_3',
      providerPaymentId: 'pay_3',
      packageName: null,
    });
    expect(items.find((p) => p.id === 'p2')).toMatchObject({ provider: 'cashfree', providerOrderId: 'order_cf2' });
    expect(r().payments({ ...list, search: 'order_cf2', status: null }).items.map((p) => p.id)).toEqual(['p2']);
  });

  it('summarises a range; refunds stay "not tracked"', () => {
    expect(r().paymentSummary('7d')).toMatchObject({
      verifiedRevenueInr: 249,
      verifiedCount: 1,
      failedCount: 0,
      pendingCount: 1,
      refundedCount: null,
      refundedInr: null,
    });
  });
});
