import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export const ACCESS_HEADER = 'cf-access-jwt-assertion';

/** Who is calling, or why they are refused. */
export type AccessResult = { ok: true; email: string } | { ok: false; status: 401 | 403 };

export type AccessVerifier = (token: string | undefined) => Promise<AccessResult>;

/**
 * Checks the token Cloudflare Access attaches to every request it lets
 * through. The server's address is public, so a request that skipped
 * Cloudflare reaches nginx too; it has no valid token and is refused here.
 *
 * `keys` is injectable for tests; production fetches Cloudflare's signing
 * keys from the team domain (cached and refreshed by jose).
 */
export function accessVerifier(
  access: { teamDomain: string; audience: string; allowedEmails: ReadonlySet<string> },
  keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(`https://${access.teamDomain}/cdn-cgi/access/certs`)),
): AccessVerifier {
  return async (token) => {
    if (!token) return { ok: false, status: 401 };
    let email: unknown;
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: `https://${access.teamDomain}`,
        audience: access.audience,
        algorithms: ['RS256'],
      });
      email = payload.email;
    } catch {
      return { ok: false, status: 401 };
    }
    if (typeof email !== 'string') return { ok: false, status: 403 };
    const normalized = email.trim().toLowerCase();
    if (!access.allowedEmails.has(normalized)) return { ok: false, status: 403 };
    return { ok: true, email: normalized };
  };
}
