import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Page, PaymentSummary, UserSummary } from '@/api/types';
import { fakeApi, renderApp } from '@/test/renderApp';

const user = (n: number, extra: Partial<UserSummary> = {}): UserSummary => ({
  id: `usr_${n}`,
  name: `User ${n}`,
  email: `user${n}@example.com`,
  status: 'active',
  credits: n,
  totalScans: 2,
  avgScore: 71,
  createdAt: '2026-10-01T10:00:00Z',
  lastActiveAt: '2026-10-20T10:00:00Z',
  ...extra,
});

describe('Users page', () => {
  it('lists users and searches by name or email', async () => {
    const users = vi.fn(async ({ search }: { search?: string }): Promise<Page<UserSummary>> => {
      const all = [user(1), user(2, { status: 'suspended', name: '<b>Mallory</b>' })];
      const items = search ? all.filter((u) => u.email.includes(search)) : all;
      return { items, page: 1, pageSize: 25, total: items.length };
    });
    renderApp('/users', { api: fakeApi({ users }), signedIn: true });

    const table = await screen.findByRole('table', { name: 'Users' });
    expect(within(table).getByText('user1@example.com')).toBeInTheDocument();
    // API text is rendered as text, never as HTML.
    expect(within(table).getByText('<b>Mallory</b>')).toBeInTheDocument();
    expect(within(table).getByText('Suspended')).toBeInTheDocument();

    await userEvent.setup().type(screen.getByRole('searchbox'), 'user2');
    await waitFor(() => expect(users).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'user2', page: 1 })));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Users' })).queryByText('user1@example.com')).toBeNull());
  });

  it('shows a clear message when the admin endpoint does not exist yet', async () => {
    const { ApiError } = await import('@/api/client');
    const users = vi.fn(async () => {
      throw new ApiError(404, 'Not found');
    });
    renderApp('/users', { api: fakeApi({ users }), signedIn: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('not available on the backend yet');
  });
});

describe('Revenue page', () => {
  it('says refunds are not tracked instead of showing zero', async () => {
    const summary: PaymentSummary = {
      range: '30d',
      verifiedRevenueInr: 12450,
      verifiedCount: 98,
      failedCount: 6,
      pendingCount: 11,
      refundedCount: null,
      refundedInr: null,
      trend: [
        { date: '2026-10-19', value: 400 },
        { date: '2026-10-20', value: 650 },
      ],
    };
    renderApp('/revenue', {
      api: fakeApi({
        paymentSummary: vi.fn(async () => summary),
        payments: vi.fn(async () => ({ items: [], page: 1, pageSize: 25, total: 0 })),
      }),
      signedIn: true,
    });

    expect(await screen.findByText('₹12,450')).toBeInTheDocument();
    expect(screen.getByText('Not tracked')).toBeInTheDocument();

    // Every chart value is reachable without hovering.
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show table' }));
    expect(screen.getByRole('cell', { name: '₹650' })).toBeInTheDocument();
  });
});
