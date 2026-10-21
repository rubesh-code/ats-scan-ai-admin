const IST = 'Asia/Kolkata';

const integer = new Intl.NumberFormat('en-IN');
const compact = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
const rupees = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
const dateTime = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: IST,
});
const dateOnly = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: IST });
const dayMonth = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export const formatNumber = (n: number) => integer.format(n);

/** 1,284 stays exact; 12,900 becomes 12.9K. */
export const formatCompact = (n: number) => (Math.abs(n) < 10_000 ? integer.format(n) : compact.format(n));

export const formatInr = (n: number) => rupees.format(n);

export const formatInrCompact = (n: number) =>
  Math.abs(n) < 100_000 ? rupees.format(n) : `₹${compact.format(n)}`;

export function formatDateTime(iso: string | null) {
  return iso ? dateTime.format(new Date(iso)) : '—';
}

export function formatDate(iso: string | null) {
  return iso ? dateOnly.format(new Date(iso)) : '—';
}

/** Chart axis label for a YYYY-MM-DD bucket (already a UTC day). */
export function formatDay(day: string) {
  return dayMonth.format(new Date(`${day}T00:00:00Z`));
}

/**
 * Percentage change versus the previous period. Null when there is no
 * baseline, because "+∞%" helps nobody.
 */
export function percentChange(current: number, previous: number) {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export function formatPercent(n: number) {
  // Round the magnitude so +3.25% and -3.25% show the same digits.
  const abs = Math.abs(n);
  const rounded = Math.sign(n) * (abs >= 10 ? Math.round(abs) : Math.round(abs * 10) / 10);
  return `${rounded > 0 ? '+' : ''}${rounded === 0 ? 0 : rounded}%`;
}
