import { describe, expect, it } from 'vitest';

import type { AdminSession } from '@/api/types';
import { isExpired, loadSession, saveSession } from '@/auth/session';

const session = (expiresInMs: number): AdminSession => ({
  token: 'tok',
  expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  admin: { id: 'adm_1', email: 'a@example.com', role: 'admin' },
});

describe('session storage', () => {
  it('round-trips a valid session', () => {
    const s = session(3_600_000);
    saveSession(s);
    expect(loadSession()).toEqual(s);
  });

  it('drops an expired session', () => {
    saveSession(session(-1_000));
    expect(loadSession()).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it('treats a session about to expire as expired', () => {
    expect(isExpired(session(10_000))).toBe(true);
  });

  it('clears corrupt or incomplete entries', () => {
    window.sessionStorage.setItem('ats-admin.session', '{not json');
    expect(loadSession()).toBeNull();

    window.sessionStorage.setItem('ats-admin.session', JSON.stringify({ token: 'x' }));
    expect(loadSession()).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it('never uses localStorage', () => {
    saveSession(session(3_600_000));
    expect(window.localStorage.length).toBe(0);
  });
});
