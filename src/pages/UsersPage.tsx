import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { adminApi } from '@/api';
import type { AccountStatus, UserSummary } from '@/api/types';
import { DataTable, Pagination, type Column } from '@/components/DataTable';
import { FilterBar, SearchInput, SelectFilter } from '@/components/FilterBar';
import { PageHeader } from '@/components/Layout';
import { QueryState } from '@/components/QueryState';
import { StateBadge } from '@/components/StatusBadge';
import { formatDate, formatDateTime, formatNumber } from '@/lib/format';
import { useUrlState } from '@/lib/useUrlState';

const PAGE_SIZE = 25;

const STATUS_OPTIONS: { value: AccountStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
];

const columns: Column<UserSummary>[] = [
  {
    key: 'user',
    header: 'User',
    render: (u) => (
      <Link to={`/users/${encodeURIComponent(u.id)}`} className="cell-primary">
        <span>{u.name}</span>
        <span className="muted small">{u.email}</span>
      </Link>
    ),
  },
  { key: 'status', header: 'Status', render: (u) => <StateBadge state={u.status} /> },
  { key: 'credits', header: 'Credits', numeric: true, render: (u) => formatNumber(u.credits) },
  { key: 'scans', header: 'Scans', numeric: true, render: (u) => formatNumber(u.totalScans) },
  { key: 'score', header: 'Avg score', numeric: true, render: (u) => (u.totalScans ? u.avgScore : '—') },
  { key: 'joined', header: 'Registered', render: (u) => formatDate(u.createdAt) },
  { key: 'active', header: 'Last active', render: (u) => formatDateTime(u.lastActiveAt) },
];

export function UsersPage() {
  const { page, get, set } = useUrlState();
  const search = get('q');
  const status = get('status') as AccountStatus | '';

  const query = useQuery({
    queryKey: ['users', { page, search, status }],
    queryFn: () => adminApi.users({ page, pageSize: PAGE_SIZE, search, status: status || undefined }),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader title="Users" description="Every registered account, newest first." />
      <FilterBar>
        <SearchInput value={search} onChange={(q) => set({ q })} placeholder="Search name or email" />
        <SelectFilter label="Statuses" value={status} options={STATUS_OPTIONS} onChange={(s) => set({ status: s })} />
      </FilterBar>

      <QueryState isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
        {query.data && (
          <>
            <DataTable
              caption="Users"
              columns={columns}
              rows={query.data.items}
              rowKey={(u) => u.id}
              empty={search || status ? 'No users match these filters.' : 'No users yet.'}
              stale={query.isPlaceholderData}
            />
            <Pagination
              page={query.data.page}
              pageSize={query.data.pageSize}
              total={query.data.total}
              onPage={(p) => set({ page: p })}
            />
          </>
        )}
      </QueryState>
    </>
  );
}
