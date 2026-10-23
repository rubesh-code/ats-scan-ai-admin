import type { ReactNode } from 'react';

import { ApiError } from '@/api/client';

/**
 * The dashboard has no sign-in page, so a 401 or 403 is not "sign in again":
 * the server is refusing to share admin data with this browser. Say so
 * plainly; never fall back to other data.
 */
function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong loading this data.';
  if (error.status === 404) return 'This admin endpoint is not available on the backend yet.';
  if (error.status === 401) {
    return 'The admin API refused this request: it requires server-side admin access, which this browser does not have. No data is shown.';
  }
  if (error.status === 403) return `The admin API refused this request (403): ${error.message}`;
  return error.message;
}

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
    return (
      <div className="panel error-panel" role="alert">
        <p>{errorMessage(error)}</p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  return children;
}
