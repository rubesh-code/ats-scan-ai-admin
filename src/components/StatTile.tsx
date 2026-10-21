import { formatPercent, percentChange } from '@/lib/format';

type Props = {
  label: string;
  value: string;
  /** Shown under the value, e.g. "vs previous 30 days". */
  hint?: string;
  current?: number;
  previous?: number;
  /** Most metrics are better when they rise; failures are not. */
  upIsGood?: boolean;
};

export function StatTile({ label, value, hint, current, previous, upIsGood = true }: Props) {
  const change = current !== undefined && previous !== undefined ? percentChange(current, previous) : null;
  const direction = change === null || change === 0 ? 'flat' : change > 0 ? 'up' : 'down';
  const good = direction === 'flat' ? null : (direction === 'up') === upIsGood;

  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {(change !== null || hint) && (
        <span className="stat-meta">
          {change !== null && (
            <span className="delta" data-good={good === null ? undefined : String(good)}>
              <span aria-hidden="true">{direction === 'up' ? '▲' : direction === 'down' ? '▼' : '■'}</span>{' '}
              {formatPercent(change)}
            </span>
          )}
          {hint && <span className="muted">{hint}</span>}
        </span>
      )}
    </div>
  );
}
