import { clearSession, loadSession } from '@/auth/session';

/** Empty means same origin: nginx (prod) or the Vite proxy (dev) forwards /api. */
const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

const TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

type Listener = (status: 401 | 403) => void;
const authListeners = new Set<Listener>();

/** The auth provider subscribes here so any 401/403 anywhere signs the UI out. */
export function onAuthFailure(listener: Listener) {
  authListeners.add(listener);
  return () => {
    authListeners.delete(listener);
  };
}

export type Query = Record<string, string | number | undefined | null>;

export function buildUrl(path: string, query?: Query) {
  const url = new URL(`${BASE_URL}${path}`, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return BASE_URL ? url.toString() : `${url.pathname}${url.search}`;
}

async function readError(response: Response) {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'error' in body) {
      const message = (body as { error: unknown }).error;
      if (typeof message === 'string' && message.trim()) return message;
    }
  } catch {
    // Not JSON (proxy error page, Cloudflare block page): use a generic message.
  }
  if (response.status === 401) return 'Your session has expired. Sign in again.';
  if (response.status === 403) return 'This account does not have admin access.';
  if (response.status === 429) return 'Too many requests. Wait a moment and try again.';
  return `Request failed (${response.status}).`;
}

type RequestOptions = {
  method?: 'GET' | 'POST';
  query?: Query;
  body?: unknown;
  /** Login calls run before a session exists. */
  auth?: boolean;
  signal?: AbortSignal;
};

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', query, body, auth = true, signal } = options;
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (auth) {
    const session = loadSession();
    if (!session) {
      for (const listener of authListeners) listener(401);
      throw new ApiError(401, 'Your session has expired. Sign in again.');
    }
    headers.Authorization = `Bearer ${session.token}`;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      signal: combined,
    });
  } catch (error) {
    if (timeout.aborted) throw new ApiError(0, 'The server took too long to respond.');
    if (signal?.aborted) throw error;
    throw new ApiError(0, 'Could not reach the admin API. Check your connection.');
  }

  if (!response.ok) {
    const message = await readError(response);
    if (auth && (response.status === 401 || response.status === 403)) {
      clearSession();
      for (const listener of authListeners) listener(response.status);
    }
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
