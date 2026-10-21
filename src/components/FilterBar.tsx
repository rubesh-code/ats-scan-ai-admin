import { useEffect, useState, type ReactNode } from 'react';

import type { RangeKey } from '@/api/types';
import { RANGES } from '@/lib/useUrlState';

/** One row above the content it scopes; every chart and table below agrees. */
export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="filter-bar" role="search">
      {children}
    </div>
  );
}

export function RangeSelect({ value, onChange }: { value: RangeKey; onChange: (r: RangeKey) => void }) {
  return (
    <label className="control">
      <span className="sr-only">Date range</span>
      <select value={value} onChange={(e) => onChange(e.target.value as RangeKey)}>
        {RANGES.map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SelectFilter<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | '';
  options: { value: T; label: string }[];
  onChange: (value: T | '') => void;
}) {
  return (
    <label className="control">
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T | '')}>
        <option value="">{`All ${label.toLowerCase()}`}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Waits for typing to pause before searching, so each keystroke isn't a request. */
export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft((current) => (current.trim() === value ? current : value)), [value]);

  useEffect(() => {
    const next = draft.trim();
    if (next === value) return;
    const timer = window.setTimeout(() => onChange(next), 300);
    return () => window.clearTimeout(timer);
  }, [draft, value, onChange]);

  return (
    <label className="control control-search">
      <span className="sr-only">Search</span>
      <input
        type="search"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        maxLength={120}
      />
    </label>
  );
}
