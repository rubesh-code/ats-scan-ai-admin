import { useQuery } from '@tanstack/react-query';

import { adminApi } from '@/api';
import type { BackendError, HealthCheck } from '@/api/types';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/Layout';
import { QueryState } from '@/components/QueryState';
import { StateBadge } from '@/components/StatusBadge';
import { formatDateTime } from '@/lib/format';

const checkColumns: Column<HealthCheck>[] = [
  { key: 'name', header: 'Service', render: (c) => c.name },
  { key: 'status', header: 'Status', render: (c) => <StateBadge state={c.status} /> },
  { key: 'latency', header: 'Response time', numeric: true, render: (c) => (c.latencyMs === null ? '—' : `${c.latencyMs} ms`) },
  { key: 'detail', header: 'Detail', render: (c) => c.detail ?? '—' },
];

const errorColumns: Column<BackendError>[] = [
  { key: 'at', header: 'Time', render: (e) => formatDateTime(e.at) },
  { key: 'route', header: 'Route', render: (e) => <code>{e.route}</code> },
  { key: 'status', header: 'Status', numeric: true, render: (e) => e.status },
  { key: 'message', header: 'Message', render: (e) => e.message },
];

export function HealthPage() {
  const query = useQuery({
    queryKey: ['health'],
    queryFn: () => adminApi.health(),
    refetchInterval: 60_000,
  });
  const data = query.data;

  return (
    <>
      <PageHeader title="System health" description="Checked by the backend itself; refreshes every minute." />
      <QueryState isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
        {data && (
          <div className="stack">
            <section className="panel" aria-labelledby="services">
              <div className="panel-head">
                <h2 id="services">Services</h2>
                <span className="muted small">Checked {formatDateTime(data.checkedAt)}</span>
              </div>
              <DataTable caption="Service checks" columns={checkColumns} rows={data.checks} rowKey={(c) => c.name} />
            </section>
            <section className="panel" aria-labelledby="errors">
              <h2 id="errors">Recent backend errors</h2>
              {data.recentErrors === null ? (
                <p className="muted">
                  Not tracked yet. The backend currently writes errors only to its server log; see
                  docs/admin-api.md for what's needed to show them here.
                </p>
              ) : (
                <DataTable
                  caption="Recent backend errors"
                  columns={errorColumns}
                  rows={data.recentErrors}
                  rowKey={(e) => `${e.at}-${e.route}`}
                  empty="No errors recorded."
                />
              )}
            </section>
          </div>
        )}
      </QueryState>
    </>
  );
}
