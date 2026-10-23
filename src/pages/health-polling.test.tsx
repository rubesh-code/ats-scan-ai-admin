import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SystemHealth } from '@/api/types';
import { fakeApi, renderApp } from '@/test/renderApp';

const health: SystemHealth = {
  checkedAt: '2026-10-22T09:00:00Z',
  checks: [{ name: 'Database', status: 'ok', latencyMs: 12, detail: null }],
  recentErrors: null,
};

describe('Health page polling', () => {
  it('loads normally, then polls in the background so polling never extends the idle session', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const healthCall = vi.fn(async (_options?: { background?: boolean }) => health);
    renderApp('/health', { api: fakeApi({ health: healthCall }) });

    expect(await screen.findByRole('table', { name: 'Service checks' })).toBeInTheDocument();
    expect(healthCall).toHaveBeenCalledTimes(1);
    expect(healthCall.mock.calls[0]?.[0]).toEqual({ background: false });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(healthCall).toHaveBeenCalledTimes(2));
    expect(healthCall.mock.calls[1]?.[0]).toEqual({ background: true });
  });
});
