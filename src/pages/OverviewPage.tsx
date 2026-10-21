import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { adminApi } from '@/api';
import { FilterBar, RangeSelect } from '@/components/FilterBar';
import { PageHeader } from '@/components/Layout';
import { QueryState } from '@/components/QueryState';
import { StatTile } from '@/components/StatTile';
import { TrendChart } from '@/components/TrendChart';
import { formatCompact, formatInr, formatInrCompact, formatNumber } from '@/lib/format';
import { RANGES, useUrlState } from '@/lib/useUrlState';

export function OverviewPage() {
  const { range, set } = useUrlState();
  const query = useQuery({
    queryKey: ['overview', range],
    queryFn: () => adminApi.overview(range),
    placeholderData: keepPreviousData,
  });
  const data = query.data;
  const rangeLabel = RANGES.find((r) => r.key === range)?.label.toLowerCase() ?? range;
  const vsLabel = `vs previous ${rangeLabel.replace('last ', '')}`;

  return (
    <>
      <PageHeader title="Overview" description="How ATS Scan AI is doing across every user." />
      <FilterBar>
        <RangeSelect value={range} onChange={(r) => set({ range: r })} />
      </FilterBar>

      <QueryState isPending={query.isPending} error={query.error} onRetry={() => void query.refetch()}>
        {data && (
          <div className="stack" data-stale={query.isPlaceholderData || undefined}>
            <section className="stats" aria-label="Key figures">
              <StatTile
                label="Verified revenue"
                value={formatInr(data.totals.verifiedRevenueInr)}
                current={data.totals.verifiedRevenueInr}
                previous={data.previous.verifiedRevenueInr}
                hint={vsLabel}
              />
              <StatTile label="Total users" value={formatNumber(data.totals.users)} hint="all time" />
              <StatTile
                label="New users"
                value={formatNumber(data.current.newUsers)}
                current={data.current.newUsers}
                previous={data.previous.newUsers}
                hint={vsLabel}
              />
              <StatTile
                label="Active users"
                value={formatNumber(data.totals.activeUsers)}
                hint={`activity in the last ${data.activeWindowDays} days`}
              />
              <StatTile
                label="Scans"
                value={formatNumber(data.totals.scans)}
                current={data.totals.scans}
                previous={data.previous.scans}
                hint={vsLabel}
              />
              <StatTile
                label="Credits consumed"
                value={formatNumber(data.totals.creditsConsumed)}
                current={data.totals.creditsConsumed}
                previous={data.previous.creditsConsumed}
                hint={vsLabel}
              />
            </section>

            <section className="charts" aria-label="Trends">
              <TrendChart
                title="Verified revenue per day"
                points={data.trends.verifiedRevenueInr}
                format={formatInr}
                formatTick={formatInrCompact}
                stale={query.isPlaceholderData}
              />
              <TrendChart
                title="Scans per day"
                points={data.trends.scans}
                format={formatNumber}
                formatTick={formatCompact}
                stale={query.isPlaceholderData}
              />
              <TrendChart
                title="New users per day"
                points={data.trends.signups}
                format={formatNumber}
                formatTick={formatCompact}
                stale={query.isPlaceholderData}
              />
              <TrendChart
                title="Credits consumed per day"
                points={data.trends.creditsConsumed}
                format={formatNumber}
                formatTick={formatCompact}
                stale={query.isPlaceholderData}
              />
            </section>
          </div>
        )}
      </QueryState>
    </>
  );
}
