import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { accessVerifier, type AccessVerifier } from '../src/access.js';

const TEAM = 'atsscanai.cloudflareaccess.com';
const AUD = 'aud-tag-123';

let sign: (claims: Record<string, unknown>, options?: { iss?: string; aud?: string; exp?: string }) => Promise<string>;
let verify: AccessVerifier;
let otherKeySign: () => Promise<string>;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
  verify = accessVerifier(
    { teamDomain: TEAM, audience: AUD, allowedEmails: new Set(['owner@example.com']) },
    createLocalJWKSet({ keys: [jwk] }),
  );
  sign = (claims, { iss = `https://${TEAM}`, aud = AUD, exp = '5m' } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(iss)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(privateKey);
  otherKeySign = () =>
    new SignJWT({ email: 'owner@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD)
      .setExpirationTime('5m')
      .sign(other.privateKey);
});

describe('Cloudflare Access token check', () => {
  it('lets an allowed email through, normalised', async () => {
    expect(await verify(await sign({ email: ' Owner@Example.com ' }))).toEqual({ ok: true, email: 'owner@example.com' });
  });

  it('refuses a request with no token (it did not come through Cloudflare)', async () => {
    expect(await verify(undefined)).toEqual({ ok: false, status: 401 });
    expect(await verify('')).toEqual({ ok: false, status: 401 });
  });

  it.each([
    ['garbage', async () => 'not-a-jwt'],
    ['another application', async () => sign({ email: 'owner@example.com' }, { aud: 'someone-else' })],
    ['another team', async () => sign({ email: 'owner@example.com' }, { iss: 'https://evil.cloudflareaccess.com' })],
    ['expired', async () => sign({ email: 'owner@example.com' }, { exp: '-1m' })],
    ['signed with a different key', () => otherKeySign()],
  ])('refuses a token that is %s with 401', async (_name, token) => {
    expect(await verify(await token())).toEqual({ ok: false, status: 401 });
  });

  it('refuses an unsigned (alg none) token', async () => {
    const body = Buffer.from(
      JSON.stringify({ email: 'owner@example.com', iss: `https://${TEAM}`, aud: AUD, exp: Math.floor(Date.now() / 1000) + 300 }),
    ).toString('base64url');
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    expect(await verify(`${header}.${body}.`)).toEqual({ ok: false, status: 401 });
  });

  it('refuses a valid token for an email not on the admin list with 403', async () => {
    expect(await verify(await sign({ email: 'customer@example.com' }))).toEqual({ ok: false, status: 403 });
  });

  it('refuses a valid token with no email (a service token) with 403', async () => {
    expect(await verify(await sign({ common_name: 'svc' }))).toEqual({ ok: false, status: 403 });
  });
});
