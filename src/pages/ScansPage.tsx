import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { adminApi } from '@/api';
import type { ScanRecord, ScanStatus } from '@/api/types';
import { DataTable, Pagination, type Column } from '@/components/DataTable';
import { FilterBar, RangeSelect, SearchInput, SelectFilter } from '@/components/FilterBar';
import { PageHeader } from '@/components/Layout';
import { QueryState } from '@/components/QueryState';
import { StatTile } from '@/components/StatTile';
import { StateBadge } from '@/components/StatusBadge';
import { TrendChart } from '@/components/TrendChart';
import { formatCompact, formatDateTime, formatNumber } from '@/lib/format';
import { useUrlState } from '@/lib/useUrlState';

const PAGE_SIZE = 25;

const STATUS_OPTIONS: { value: ScanStatus; label: string }[] = [
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
];

const columns: Column<ScanRecord>[] = [
  { key: 'date', header: 'Date', render: (s) => formatDateTime(s.createdAt) },
  {
    key: 'user',
    header: 'User',
    render: (s) => <Link to={`/users/${encodeURIComponent(s.userId)}`}>{s.userEmail}</Link>,
  },
  { key: 'file', header: 'File', render: (s) => s.filename },
  { key: 'role', header: 'Target', render: (s) => s.jobRole ?? (s.type === 'job_description' ? 'Job description' : '—') },
  {
    key: 'status',
    header: 'Outcome',
    render: (s) => (
      <span className="cell-primary">
        <StateBadge state={s.status} />
        {s.failureReason && <span className="muted small">{s.failureReason}</span>}
      </span>
    ),
  },
  { key: 'score', header: 'Score', numeric: true, render: (s) => s.score ?? '—' },
  { key: 'credit', header: 'Credits', numeric: true, render: (s) => s.creditUsed },
];

export function ScansPage() {
  const { range, page, get, set } = useUrlState();
  const search = get('q');
  const status = get('status') as ScanStatus | '';

  const summary = useQuery({
    queryKey: ['scan-summary', range],
    queryFn: () => adminApi.scanSummary(range),
    placeholderData: keepPreviousData,
  });
  const list = useQuery({
    queryKey: ['scans', { page, search, status }],
    queryFn: () => adminApi.scans({ page, pageSize: PAGE_SIZE, search, status: status || undefined }),
    placeholderData: keepPreviousData,
  });
  const s = summary.data;
  const failureRate = s && s.total ? (s.failed / s.total) * 100 : 0;

  return (
    <>
      <PageHeader title="Scans" description="Resume scans across all users, with outcomes and failures." />
      <FilterBar>
        <RangeSelect value={range} onChange={(r) => set({ range: r }, { resetPage: false })} />
      </FilterBar>

      <QueryState isPending={summary.isPending} error={summary.error} onRetry={() => void summary.refetch()}>
        {s && (
          <div className="stack" data-stale={summary.isPlaceholderData || undefined}>
            <section className="stats" aria-label="Scan figures">
              <StatTile label="Scans" value={formatNumber(s.total)} />
              <StatTile label="Completed" value={formatNumber(s.completed)} />
              <StatTile
                label="Failed"
                value={formatNumber(s.failed)}
                hint={s.total ? `${failureRate.toFixed(1)}% of scans` : undefined}
              />
              <StatTile label="Average score" value={s.avgScore === null ? '—' : String(s.avgScore)} />
            </section>
            <TrendChart
              title="Scans per day"
              points={s.trend}
              format={formatNumber}
              formatTick={formatCompact}
              stale={summary.isPlaceholderData}
            />
          </div>
        )}
      </QueryState>

      <section className="panel" aria-labelledby="scan-history">
        <h2 id="scan-history">Scan history</h2>
        <FilterBar>
          <SearchInput value={search} onChange={(q) => set({ q })} placeholder="Search user, file or role" />
          <SelectFilter label="Outcomes" value={status} options={STATUS_OPTIONS} onChange={(v) => set({ status: v })} />
        </FilterBar>
        <QueryState isPending={list.isPending} error={list.error} onRetry={() => void list.refetch()}>
          {list.data && (
            <>
              <DataTable
                caption="Scan history"
                columns={columns}
                rows={list.data.items}
                rowKey={(r) => r.id}
                empty="No scans match these filters."
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
