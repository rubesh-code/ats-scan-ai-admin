import type { ReactNode } from 'react';

export type Column<T> = {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Right-aligned with tabular figures, for numbers that must line up. */
  numeric?: boolean;
};

type Props<T> = {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: string;
  stale?: boolean;
};

export function DataTable<T>({ caption, columns, rows, rowKey, empty = 'Nothing to show.', stale }: Props<T>) {
  return (
    <div className="table-wrap" data-stale={stale || undefined}>
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.numeric ? 'num' : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="empty">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((c) => (
                  <td key={c.key} className={c.numeric ? 'num' : undefined}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="muted">
        {from}–{to} of {total.toLocaleString('en-IN')}
      </span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onPage(page - 1)} disabled={page <= 1}>
        Previous
      </button>
      <span aria-current="page">
        Page {page} of {pages}
      </span>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => onPage(page + 1)}
        disabled={page >= pages}
      >
        Next
      </button>
    </nav>
  );
}
