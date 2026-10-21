import { httpAdminApi, type AdminApi } from '@/api/admin';

/**
 * Mock data is a development-only convenience. The check on `DEV` lets Vite
 * drop the mock module from production builds entirely, so `VITE_USE_MOCKS`
 * can never make a deployed dashboard show invented numbers.
 */
export const usingMocks = import.meta.env.DEV && import.meta.env.VITE_USE_MOCKS === 'true';

let api: AdminApi = httpAdminApi;

export async function initApi() {
  if (usingMocks) {
    const { mockAdminApi } = await import('@/api/mock');
    api = mockAdminApi;
  }
}

/** Resolved at call time so `initApi` can swap the implementation in first. */
export const adminApi = new Proxy({} as AdminApi, {
  get(_target, key: keyof AdminApi) {
    return api[key];
  },
});

export function setAdminApiForTests(next: AdminApi) {
  api = next;
}
