import { isIP } from 'node:net';

type Env = Record<string, string | undefined>;

export type ApiConfig = {
  /** Loopback only: nginx is the one client. */
  host: string;
  port: number;
  supabase: { url: string; serviceRoleKey: string };
  access: {
    /** e.g. `atsscanai.cloudflareaccess.com`; the token issuer and key source. */
    teamDomain: string;
    /** The Access application's AUD tag. */
    audience: string;
    /**
     * Emails allowed in, checked after Cloudflare's own policy. A second
     * gate, so a too-broad Access policy does not open customer data.
     */
    allowedEmails: ReadonlySet<string>;
  };
  /** The customer backend's health URL, reported on the Health page. */
  customerHealthUrl: string | null;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is required.`);
  return value;
}

function httpsUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be a URL.`);
  }
  if (url.protocol !== 'https:') throw new ConfigError(`${name} must use https.`);
  return url.origin;
}

export function loadConfig(env: Env): ApiConfig {
  const host = env.ADMIN_API_HOST?.trim() || '127.0.0.1';
  if (!(isIP(host) === 4 ? host.startsWith('127.') : host === '::1')) {
    throw new ConfigError('ADMIN_API_HOST must be a loopback address.');
  }
  const port = Number(env.ADMIN_API_PORT ?? 5080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError('ADMIN_API_PORT must be a port number.');
  }

  const teamDomain = required(env, 'CF_ACCESS_TEAM_DOMAIN').replace(/^https:\/\//, '').replace(/\/+$/, '');
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(teamDomain)) {
    throw new ConfigError('CF_ACCESS_TEAM_DOMAIN must look like <team>.cloudflareaccess.com.');
  }

  const allowedEmails = new Set(
    required(env, 'ADMIN_EMAILS')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
  if (allowedEmails.size === 0 || [...allowedEmails].some((e) => !/^[^@\s]+@[^@\s]+$/.test(e))) {
    throw new ConfigError('ADMIN_EMAILS must be a comma-separated list of email addresses.');
  }

  const customerHealth = env.CUSTOMER_HEALTH_URL?.trim();
  return {
    host,
    port,
    supabase: {
      url: httpsUrl('SUPABASE_URL', required(env, 'SUPABASE_URL')),
      serviceRoleKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    },
    access: { teamDomain: teamDomain.toLowerCase(), audience: required(env, 'CF_ACCESS_AUD'), allowedEmails },
    customerHealthUrl: customerHealth || null,
  };
}
