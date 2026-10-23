/**
 * Empty means same origin: nginx (prod) or the Vite proxy (dev) forwards
 * /api/admin. A path prefix is allowed; another origin is not, because the
 * session cookie is only ever sent to this site.
 */
const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

const TIMEOUT_MS = 20_000;

/** Tells the auth service a request is automatic, so it does not extend the idle timeout. */
export const BACKGROUND_HEADER = 'x-ats-admin-background';

export class ApiError extends Error {
  readonly status: number;
  /** From a 429's Retry-After header, in seconds, when the server sent one. */
  readonly retryAfterSeconds: number | null;

  constructor(status: number, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/**
 * Notified on a 401 from any API call (session expired, revoked, or account
 * disabled). Nothing subscribes while the dashboard has no sign-in page; a
 * 401 is then shown as an error on the page that made the call. A 403 never
 * notifies:
 * the auth service sends 403 when it refuses a request's origin or when the
 * admin's role is not allowed on that route; the session is still valid.
 */
export function onUnauthorized(listener: Listener) {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

export type Query = Record<string, string | number | undefined | null>;

export function buildUrl(path: string, query?: Query) {
  const url = new URL(`${BASE_URL}${path}`, window.location.origin);
  if (url.origin !== window.location.origin) {
    throw new ApiError(0, 'The admin API must be served from this site’s own address.');
  }
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

function retryAfter(response: Response): number | null {
  const value = response.headers.get('Retry-After');
  if (!value || !/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
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
  if (response.status === 401) return 'The admin API requires authorisation.';
  if (response.status === 403) return 'The server refused this request.';
  if (response.status === 429) return 'Too many attempts. Try again later.';
  return `Request failed (${response.status}).`;
}

type RequestOptions = {
  method?: 'GET' | 'POST';
  query?: Query;
  /** Sent as JSON. State-changing requests use JSON bodies only. */
  body?: unknown;
  /** Automatic refresh rather than something the admin did; see BACKGROUND_HEADER. */
  background?: boolean;
  /**
   * Whether a 401 should sign the UI out. False for login (a 401 there is a
   * wrong password) and for the startup session check (no session yet).
   */
  signOutOn401?: boolean;
  signal?: AbortSignal;
};

/**
 * Every API call goes through here. Authentication is the HttpOnly session
 * cookie, sent by the browser on same-origin requests; this code never sees
 * or stores a token and sends no Authorization header.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', query, body, background = false, signOutOn401 = true, signal } = options;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (background) headers[BACKGROUND_HEADER] = '1';

  const url = buildUrl(path, query);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
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
    if (response.status === 401 && signOutOn401) {
      for (const listener of unauthorizedListeners) listener();
    }
    throw new ApiError(response.status, message, response.status === 429 ? retryAfter(response) : null);
  }

  if (response.status === 204) return undefined as T;
  // A web server with no admin API behind it answers /api/admin/* with the
  // dashboard's own index.html and a 200. That is "no API here", not data.
  if (!response.headers.get('Content-Type')?.toLowerCase().includes('application/json')) {
    throw new ApiError(
      response.status,
      'No admin API answered at this address (the server returned a web page instead of data).',
    );
  }
  return (await response.json()) as T;
}
