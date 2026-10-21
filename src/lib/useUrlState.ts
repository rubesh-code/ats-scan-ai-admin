import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

import type { RangeKey } from '@/api/types';

export const RANGES: { key: RangeKey; label: string }[] = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
];

const isRange = (v: string | null): v is RangeKey => RANGES.some((r) => r.key === v);

/**
 * Filters live in the URL so a filtered view can be bookmarked or shared with
 * another admin, and Back restores the previous filter.
 */
export function useUrlState() {
  const [params, setParams] = useSearchParams();

  const set = useCallback(
    (updates: Record<string, string | number | null>, { resetPage = true } = {}) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(updates)) {
            if (value === null || value === '') next.delete(key);
            else next.set(key, String(value));
          }
          if (resetPage && !('page' in updates)) next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const rangeParam = params.get('range');
  const range: RangeKey = isRange(rangeParam) ? rangeParam : '30d';
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);

  return {
    range,
    page,
    get: (key: string) => params.get(key) ?? '',
    set,
  };
}
