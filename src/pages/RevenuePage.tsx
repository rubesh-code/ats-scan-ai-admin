import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { adminApi } from '@/api';
import type { PaymentRecord, PaymentStatus } from '@/api/types';
import { DataTable, Pagination, type Column } from '@/components/DataTable';
import { FilterBar, RangeSelect, SearchInput, SelectFilter } from '@/components/FilterBar';
import { PageHeader } from '@/components/Layout';
import { QueryState } from '@/components/QueryState';
import { StatTile } from '@/components/StatTile';
import { StateBadge } from '@/components/StatusBadge';
import { TrendChart } from '@/components/TrendChart';
import { formatDateTime, formatInr, formatInrCompact, formatNumber } from '@/lib/format';
import { useUrlState } from '@/lib/useUrlState';

const PAGE_SIZE = 25;

const STATUS_OPTIONS: { value: PaymentStatus; label: string }[] = [
  { value: 'paid', label: 'Paid' },
  { value: 'failed', label: 'Failed' },
  { value: 'created', label: 'Pending' },
  { value: 'refunded', label: 'Refunded' },
];

const columns: Column<PaymentRecord>[] = [
  { key: 'date', header: 'Created', render: (p) => formatDateTime(p.createdAt) },
  {
    key: 'user',
    header: 'User',
    render: (p) => <Link to={`/users/${encodeURIComponent(p.userId)}`}>{p.userEmail}</Link>,
  },
  { key: 'package', header: 'Package', render: (p) => p.packageName ?? '—' },
  { key: 'status', header: 'Status', render: (p) => <StateBadge state={p.status} /> },
  {
    key: 'ref',
    header: 'Provider reference',
    render: (p) => (
      <span className="cell-primary">
        <code>{p.providerPaymentId ?? p.providerOrderId}</code>
        <span className="muted small">{p.provider}</span>
      </span>
    ),
  },
  { key: 'verified', header: 'Verified', render: (p) => formatDateTime(p.verifiedAt) },
  { key: 'amount', header: 'Amount', numeric: true, render: (p) => formatInr(p.amountInr) },
];

export function RevenuePage() {
  const { range, page, get, set } = useUrlState();
  const search = get('q');
  const status = get('status') as PaymentStatus | '';

  const summary = useQuery({
    queryKey: ['payment-summary', range],
    queryFn: () => adminApi.paymentSummary(range),
    placeholderData: keepPreviousData,
  });
  const list = useQuery({
    queryKey: ['payments', { page, search, status }],
    queryFn: () => adminApi.payments({ page, pageSize: PAGE_SIZE, search, status: status || undefined }),
    placeholderData: keepPreviousData,
  });
  const s = summary.data;

  return (
    <>
      <PageHeader
        title="Revenue"
        description="Only payments verified with the provider count as revenue."
      />
      <FilterBar>
        <RangeSelect value={range} onChange={(r) => set({ range: r }, { resetPage: false })} />
      </FilterBar>

      <QueryState isPending={summary.isPending} error={summary.error} onRetry={() => void summary.refetch()}>
        {s && (
          <div className="stack" data-stale={summary.isPlaceholderData || undefined}>
            <section className="stats" aria-label="Revenue figures">
              <StatTile
                label="Verified revenue"
                value={formatInr(s.verifiedRevenueInr)}
                hint={`${formatNumber(s.verifiedCount)} payments`}
              />
              <StatTile label="Failed payments" value={formatNumber(s.failedCount)} />
              <StatTile label="Abandoned checkouts" value={formatNumber(s.pendingCount)} hint="created, never paid" />
              <StatTile
                label="Refunds"
                value={s.refundedInr === null ? 'Not tracked' : formatInr(s.refundedInr)}
                hint={
                  s.refundedCount === null
                    ? 'needs the payment webhook'
                    : `${formatNumber(s.refundedCount)} refunds`
                }
              />
            </section>
            <TrendChart
              title="Verified revenue per day"
              points={s.trend}
              format={formatInr}
              formatTick={formatInrCompact}
              stale={summary.isPlaceholderData}
            />
          </div>
        )}
      </QueryState>

      <section className="panel" aria-labelledby="payments">
        <h2 id="payments">Payments</h2>
        <FilterBar>
          <SearchInput value={search} onChange={(q) => set({ q })} placeholder="Search user, order or payment ID" />
          <SelectFilter label="Statuses" value={status} options={STATUS_OPTIONS} onChange={(v) => set({ status: v })} />
        </FilterBar>
        <QueryState isPending={list.isPending} error={list.error} onRetry={() => void list.refetch()}>
          {list.data && (
            <>
              <DataTable
                caption="Payments"
                columns={columns}
                rows={list.data.items}
                rowKey={(p) => p.id}
                empty="No payments match these filters."
                stale={list.isPlaceholderData}
              />
              <Pagination
                page={list.data.page}
                pageSize={list.data.pageSize}
                total={list.data.total}
                onPage={(p) => set({ page: p })}
              />
            </>
          )}
        </QueryState>
      </section>
    </>
  );
}
