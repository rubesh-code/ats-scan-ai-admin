import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { adminApi } from '@/api';
import type { CreditTransaction, CreditTransactionType } from '@/api/types';
import { DataTable, Pagination, type Column } from '@/components/DataTable';
import { FilterBar, RangeSelect, SearchInput, SelectFilter } from '@/components/FilterBar';
import { PageHeader } from '@/components/Layout';
import { QueryState } from '@/components/QueryState';
import { StatTile } from '@/components/StatTile';
import { TrendChart } from '@/components/TrendChart';
import { formatCompact, formatDateTime, formatNumber } from '@/lib/format';
import { useUrlState } from '@/lib/useUrlState';

const PAGE_SIZE = 25;

const TYPE_OPTIONS: { value: CreditTransactionType; label: string }[] = [
  { value: 'purchase', label: 'Purchases' },
  { value: 'scan', label: 'Scans' },
  { value: 'rewrite', label: 'Rewrites' },
  { value: 'adjustment', label: 'Adjustments' },
  { value: 'refund', label: 'Refunds' },
];

const columns: Column<CreditTransaction>[] = [
  { key: 'date', header: 'Date', render: (t) => formatDateTime(t.createdAt) },
  {
    key: 'user',
    header: 'User',
    render: (t) => <Link to={`/users/${encodeURIComponent(t.userId)}`}>{t.userEmail}</Link>,
  },
  { key: 'type', header: 'Type', render: (t) => t.type },
  { key: 'desc', header: 'Description', render: (t) => t.description ?? '—' },
  {
    key: 'credits',
    header: 'Credits',
    numeric: true,
    render: (t) => (t.credits > 0 ? `+${formatNumber(t.credits)}` : formatNumber(t.credits)),
  },
];

export function CreditsPage() {
  const { range, page, get, set } = useUrlState();
  const search = get('q');
  const type = get('type') as CreditTransactionType | '';

  const summary = useQuery({
    queryKey: ['credit-summary', range],
    queryFn: () => adminApi.creditSummary(range),
    placeholderData: keepPreviousData,
  });
  const list = useQuery({
    queryKey: ['credit-transactions', { page, search, type }],
    queryFn: () => adminApi.creditTransactions({ page, pageSize: PAGE_SIZE, search, type: type || undefined }),
    placeholderData: keepPreviousData,
  });
  const s = summary.data;

  return (
    <>
      <PageHeader title="Credits" description="Balances, consumption, purchases and the full credit ledger." />
      <FilterBar>
        <RangeSelect value={range} onChange={(r) => set({ range: r }, { resetPage: false })} />
      </FilterBar>

      <QueryState isPending={summary.isPending} error={summary.error} onRetry={() => void summary.refetch()}>
        {s && (
          <div className="stack" data-stale={summary.isPlaceholderData || undefined}>
            <section className="stats" aria-label="Credit figures">
              <StatTile label="Outstanding balance" value={formatNumber(s.outstandingBalance)} hint="all users, right now" />
              <StatTile label="Consumed" value={formatNumber(s.consumed)} hint="in this range" />
              <StatTile label="Purchased" value={formatNumber(s.purchased)} hint="in this range" />
            </section>
            <TrendChart
              title="Credits consumed per day"
              points={s.trend}
              format={formatNumber}
              formatTick={formatCompact}
              stale={summary.isPlaceholderData}
            />
          </div>
        )}
      </QueryState>

      <section className="panel" aria-labelledby="ledger">
        <h2 id="ledger">Transaction history</h2>
        <FilterBar>
          <SearchInput value={search} onChange={(q) => set({ q })} placeholder="Search user or description" />
          <SelectFilter label="Types" value={type} options={TYPE_OPTIONS} onChange={(v) => set({ type: v })} />
        </FilterBar>
        <QueryState isPending={list.isPending} error={list.error} onRetry={() => void list.refetch()}>
          {list.data && (
            <>
              <DataTable
                caption="Credit transactions"
                columns={columns}
                rows={list.data.items}
                rowKey={(t) => t.id}
                empty="No transactions match these filters."
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
