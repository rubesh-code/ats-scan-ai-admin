import { describe, expect, it } from 'vitest';

import { formatCompact, formatInr, formatPercent, percentChange } from '@/lib/format';

describe('format', () => {
  it('formats rupees without paise', () => {
    expect(formatInr(1249)).toBe('₹1,249');
  });

  it('compacts only from 10,000 up', () => {
    expect(formatCompact(1284)).toBe('1,284');
    expect(formatCompact(12900)).toBe('12.9K');
  });

  it('has no percentage change without a baseline', () => {
    expect(percentChange(5, 0)).toBeNull();
    expect(percentChange(150, 100)).toBe(50);
  });

  it('signs percentages', () => {
    expect(formatPercent(12.4)).toBe('+12%');
    expect(formatPercent(-3.25)).toBe('-3.3%');
  });
});
