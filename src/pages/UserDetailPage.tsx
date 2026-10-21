import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';

import { adminApi } from '@/api';
import type { CreditTransaction, PaymentRecord, ScanRecord } from '@/api/types';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/Layout';
import { QueryState } from '@/components/QueryState';
import { StatTile } from '@/components/StatTile';
import { StateBadge } from '@/components/StatusBadge';
import { formatDate, formatDateTime, formatInr, formatNumber } from '@/lib/format';

const scanColumns: Column<ScanRecord>[] = [
  { key: 'date', header: 'Date', render: (s) => formatDateTime(s.createdAt) },
  { key: 'file', header: 'File', render: (s) => s.filename },
  { key: 'role', header: 'Target', render: (s) => s.jobRole ?? (s.type === 'job_description' ? 'Job description' : '—') },
  { key: 'status', header: 'Outcome', render: (s) => <StateBadge state={s.status} /> },
  { key: 'score', header: 'Score', numeric: true, render: (s) => s.score ?? '—' },
];

const txColumns: Column<CreditTransaction>[] = [
  { key: 'date', header: 'Date', render: (t) => formatDateTime(t.createdAt) },
  { key: 'type', header: 'Type', render: (t) => t.type },
  { key: 'desc', header: 'Description', render: (t) => t.description ?? '—' },
  { key: 'credits', header: 'Credits', numeric: true, render: (t) => (t.credits > 0 ? `+${t.credits}` : t.credits) },
];

const paymentColumns: Column<PaymentRecord>[] = [
  { key: 'date', header: 'Date', render: (p) => formatDateTime(p.createdAt) },
  { key: 'package', header: 'Package', render: (p) => p.packageName ?? '—' },
  { key: 'status', header: 'Status', render: (p) => <StateBadge state={p.status} /> },
  { key: 'amount', header: 'Amount', numeric: true, render: (p) => formatInr(p.amountInr) },
];

export function UserDetailPage() {
  const { id = '' } = useParams();
  const query = useQuery({ queryKey: ['user', id], queryFn: () => adminApi.user(id) });
  const detail = query.data;

  return (
    <>
      <p className="crumb">
        <Link to="/users">← Users</Link>
      </p>
      <QueryState isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
        {detail && (
          <div className="stack">
            <PageHeader title={detail.user.name} description={detail.user.email} />
            <section className="stats" aria-label="Account">
              <div className="stat">
                <span className="stat-label">Status</span>
                <span className="stat-value stat-value-sm">
                  <StateBadge state={detail.user.status} />
                </span>
              </div>
              <StatTile label="Credit balance" value={formatNumber(detail.user.credits)} />
              <StatTile label="Completed scans" value={formatNumber(detail.user.totalScans)} />
              <StatTile
                label="Average score"
                value={detail.user.totalScans ? String(detail.user.avgScore) : '—'}
              />
              <StatTile label="Registered" value={formatDate(detail.user.createdAt)} />
              <StatTile label="Last active" value={formatDate(detail.user.lastActiveAt)} />
            </section>

            <section className="panel" aria-labelledby="recent-scans">
              <h2 id="recent-scans">Recent scans</h2>
              <DataTable caption="Recent scans" columns={scanColumns} rows={detail.recentScans} rowKey={(s) => s.id} empty="No scans yet." />
            </section>
            <section className="panel" aria-labelledby="recent-credits">
              <h2 id="recent-credits">Recent credit activity</h2>
              <DataTable caption="Recent credit activity" columns={txColumns} rows={detail.recentTransactions} rowKey={(t) => t.id} empty="No credit activity." />
            </section>
            <section className="panel" aria-labelledby="recent-payments">
              <h2 id="recent-payments">Payments</h2>
              <DataTable caption="Payments" columns={paymentColumns} rows={detail.recentPayments} rowKey={(p) => p.id} empty="No payments." />
            </section>
          </div>
        )}
      </QueryState>
    </>
  );
}
