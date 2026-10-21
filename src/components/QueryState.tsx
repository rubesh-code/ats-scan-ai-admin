import type { ReactNode } from 'react';

import { ApiError } from '@/api/client';

type Props = {
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
  children: ReactNode;
};

/**
 * First load shows a placeholder; errors get a retry. Refetches (new range,
 * next page) keep showing the previous data, marked stale, with no flash.
 */
export function QueryState({ isPending, error, onRetry, children }: Props) {
  if (isPending) {
    return (
      <div className="panel placeholder" aria-busy="true">
        Loading…
      </div>
    );
  }
  if (error) {
    const message = error instanceof ApiError ? error.message : 'Something went wrong loading this data.';
    const notBuilt = error instanceof ApiError && error.status === 404;
    return (
      <div className="panel error-panel" role="alert">
        <p>{notBuilt ? 'This admin endpoint is not available on the backend yet.' : message}</p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  return children;
}
