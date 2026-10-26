import type { Snapshot } from '../src/source.js';

/** 2026-10-26 12:00 UTC. */
export const NOW = Date.UTC(2026, 9, 26, 12);
const daysAgo = (n: number, hour = 10) => new Date(Date.UTC(2026, 9, 26 - n, hour)).toISOString();

/**
 * Small, hand-checkable data in the shapes production actually stores:
 * 'Completed' scans, 'resume_rewrite' transactions, Cashfree payments.
 */
export function snapshot(): Snapshot {
  return {
    users: [
      { id: 'u1', name: 'Asha', email: 'asha@example.com', credits: 4, total_scans: 2, avg_score: '71.50', created_at: daysAgo(40) },
      { id: 'u2', name: 'Ravi', email: 'ravi@example.com', credits: 0, total_scans: 1, avg_score: 60, created_at: daysAgo(3) },
      { id: 'u3', name: null, email: 'quiet@example.com', credits: 3, total_scans: 0, avg_score: null, created_at: daysAgo(10) },
    ],
    scans: [
      { id: 's1', user_id: 'u1', filename: 'asha.pdf', score: '80', status: 'Completed', type: 'job_description', job_role: null, credit_used: 1, created_at: daysAgo(2) },
      { id: 's2', user_id: 'u1', filename: 'asha2.pdf', score: 63, status: 'Completed', type: 'job_role', job_role: 'DevOps Engineer', credit_used: 1, created_at: daysAgo(12) },
      { id: 's3', user_id: 'u2', filename: 'ravi.pdf', score: 60, status: 'Completed', type: 'job_description', job_role: null, credit_used: 1, created_at: daysAgo(1) },
      { id: 's4', user_id: 'u2', filename: 'broken.pdf', score: 0, status: 'Failed', type: 'job_description', job_role: null, credit_used: 0, created_at: daysAgo(1, 11) },
    ],
    transactions: [
      { id: 't1', user_id: 'u1', payment_id: 'p1', scan_id: null, type: 'purchase', credits: 5, description: 'Starter', created_at: daysAgo(20) },
      { id: 't2', user_id: 'u1', payment_id: null, scan_id: 's1', type: 'scan', credits: -1, description: 'Resume scan', created_at: daysAgo(2) },
      { id: 't3', user_id: 'u1', payment_id: null, scan_id: 's2', type: 'scan', credits: -1, description: 'Resume scan', created_at: daysAgo(12) },
      { id: 't4', user_id: 'u2', payment_id: null, scan_id: 's3', type: 'scan', credits: -1, description: 'Resume scan', created_at: daysAgo(1) },
      { id: 't5', user_id: 'u1', payment_id: null, scan_id: null, type: 'resume_rewrite', credits: -1, description: 'Rewrite', created_at: daysAgo(0, 9) },
    ],
    payments: [
      { id: 'p1', user_id: 'u1', package_id: 'k1', payment_gateway: 'cashfree', razorpay_order_id: null, razorpay_payment_id: null, cashfree_order_id: 'cf_order_1', amount_inr: 99, credits: 5, status: 'paid', created_at: daysAgo(20), verified_at: daysAgo(20, 11) },
      // As production stores most Cashfree orders: the id in razorpay_order_id.
      { id: 'p2', user_id: 'u2', package_id: 'k1', payment_gateway: 'cashfree', razorpay_order_id: 'order_cf2', razorpay_payment_id: null, cashfree_order_id: null, amount_inr: 99, credits: 5, status: 'created', created_at: daysAgo(2), verified_at: null },
      { id: 'p3', user_id: 'u2', package_id: 'gone', payment_gateway: null, razorpay_order_id: 'order_3', razorpay_payment_id: 'pay_3', cashfree_order_id: null, amount_inr: 249, credits: 30, status: 'paid', created_at: daysAgo(4), verified_at: daysAgo(4, 11) },
    ],
    packages: [{ id: 'k1', name: 'Starter · 5 credits' }],
    signIns: [
      { email: 'QUIET@example.com', created_at: daysAgo(5) },
      { email: 'nobody@example.com', created_at: daysAgo(1) },
    ],
  };
}
