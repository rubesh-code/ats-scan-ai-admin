import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client';
import { MOCK_PASSWORD, mockAdminApi } from '@/api/mock';

describe('mock auth (development only)', () => {
  it('follows the auth service contract and stores nothing in the browser', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    await expect(mockAdminApi.me()).rejects.toMatchObject({ status: 401 });
    await expect(mockAdminApi.login('owner', 'wrong')).rejects.toEqual(
      new ApiError(401, 'Invalid username or password.'),
    );

    const session = await mockAdminApi.login(' Owner ', MOCK_PASSWORD);
    expect(session.admin).toEqual({ id: 'adm_mock', username: 'owner', role: 'owner' });
    expect(Object.keys(session).sort()).toEqual(['admin', 'expiresAt', 'idleExpiresAt']);
    expect(Date.parse(session.idleExpiresAt)).toBeLessThanOrEqual(Date.parse(session.expiresAt));

    await expect(mockAdminApi.me()).resolves.toMatchObject({ admin: { username: 'owner' } });
    await mockAdminApi.logout();
    await expect(mockAdminApi.me()).rejects.toMatchObject({ status: 401 });

    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
});
