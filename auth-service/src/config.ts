import { existsSync, readFileSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { join, posix } from 'node:path';

import type { PoolConfig } from 'pg';

type Env = Record<string, string | undefined>;

/**
 * Production listens on a Unix socket whose permissions admit only the service
 * user and nginx. TCP on loopback is for local development only.
 */
export type ListenTarget = { kind: 'unix'; path: string } | { kind: 'tcp'; host: string; port: number };

export type AuthConfig = {
  listen: ListenTarget;
  /**
   * Whether X-Forwarded-For is believed. Only on the Unix socket, where file
   * permissions guarantee the peer is nginx. On TCP any local process could
   * connect and claim any address, so the header is ignored there.
   */
  trustForwardedFor: boolean;
  /** Exact `Origin` values allowed to make state-changing requests. */
  allowedOrigins: ReadonlySet<string>;
  /** Exact `Host` values (host[:port]) the service answers; derived from the origins. */
  allowedHosts: ReadonlySet<string>;
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
  lockout: { maxFailures: number; windowMs: number; durationMs: number };
  loginRateLimit: { perIp: number; global: number; windowMs: number };
};

const MINUTE = 60_000;

/**
 * Approved policy values. Deliberately not configurable from the environment,
 * so a typo in a unit file cannot quietly weaken them.
 */
export const SESSION_POLICY = {
  idleTimeoutMs: 30 * MINUTE,
  absoluteTimeoutMs: 8 * 60 * MINUTE,
  lockout: { maxFailures: 5, windowMs: 15 * MINUTE, durationMs: 15 * MINUTE },
  loginRateLimit: { perIp: 10, global: 30, windowMs: MINUTE },
} as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Literal loopback addresses only. A hostname such as "localhost" is refused: it depends on resolver configuration. */
export function isLoopbackAddress(host: string): boolean {
  if (isIP(host) === 4) return host.startsWith('127.');
  return host === '::1';
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost');
}

/**
 * Each entry must be a bare origin (scheme://host[:port], no path or trailing
 * slash) so comparison with the browser's Origin header is an exact string
 * match. Plain http is accepted only for *.localhost (the SSH-tunnel preview):
 * the cookie is Secure, and browsers only honour that over http on localhost.
 */
export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const entries = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) {
    throw new ConfigError('ADMIN_AUTH_ALLOWED_ORIGINS must list at least one origin.');
  }
  const origins = new Set<string>();
  for (const entry of entries) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new ConfigError(`ADMIN_AUTH_ALLOWED_ORIGINS: "${entry}" is not a URL.`);
    }
    if (url.origin !== entry) {
      throw new ConfigError(`ADMIN_AUTH_ALLOWED_ORIGINS: "${entry}" must be a bare origin such as ${url.origin}.`);
    }
    if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
      throw new ConfigError(`ADMIN_AUTH_ALLOWED_ORIGINS: "${entry}" must use https (http is allowed only for *.localhost).`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ConfigError(`ADMIN_AUTH_ALLOWED_ORIGINS: "${entry}" must be http or https.`);
    }
    origins.add(entry);
  }
  return origins;
}

/** sun_path is 108 bytes on Linux; stay well inside it. */
const MAX_SOCKET_PATH = 100;

function loadListenTarget(env: Env): ListenTarget {
  const socket = env.ADMIN_AUTH_SOCKET;
  if (socket !== undefined) {
    if (env.ADMIN_AUTH_HOST !== undefined || env.ADMIN_AUTH_PORT !== undefined) {
      throw new ConfigError('Set either ADMIN_AUTH_SOCKET or ADMIN_AUTH_HOST/ADMIN_AUTH_PORT, not both.');
    }
    if (
      !socket.startsWith('/') ||
      socket.includes('\0') ||
      socket.length > MAX_SOCKET_PATH ||
      posix.normalize(socket) !== socket
    ) {
      throw new ConfigError(
        `ADMIN_AUTH_SOCKET must be an absolute, normalised path of at most ${MAX_SOCKET_PATH} characters.`,
      );
    }
    return { kind: 'unix', path: socket };
  }

  const host = env.ADMIN_AUTH_HOST ?? '127.0.0.1';
  if (!isLoopbackAddress(host)) {
    throw new ConfigError(`ADMIN_AUTH_HOST must be a loopback address (127.0.0.1 or ::1), got "${host}".`);
  }
  const port = Number(env.ADMIN_AUTH_PORT ?? '5071');
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new ConfigError('ADMIN_AUTH_PORT must be an integer between 1024 and 65535.');
  }
  return { kind: 'tcp', host, port };
}

export function loadConfig(env: Env): AuthConfig {
  const listen = loadListenTarget(env);
  const allowedOrigins = parseAllowedOrigins(env.ADMIN_AUTH_ALLOWED_ORIGINS);
  const allowedHosts = new Set([...allowedOrigins].map((origin) => new URL(origin).host));
  return { listen, trustForwardedFor: listen.kind === 'unix', allowedOrigins, allowedHosts, ...SESSION_POLICY };
}

/* ------------------------------------------------------------ database ---- */

export type SecretSource = {
  /** Name under $CREDENTIALS_DIRECTORY (systemd LoadCredential=). */
  credential: string;
  /** Environment variable holding a path to the secret file, for the CLI and local runs. */
  fileVariable: string;
  /** Whether the file must be private to its owner. False for public material such as a CA bundle. */
  private: boolean;
};

export const SERVICE_DATABASE: SecretSource = {
  credential: 'db-url',
  fileVariable: 'ADMIN_AUTH_DATABASE_URL_FILE',
  private: true,
};
export const MANAGER_DATABASE: SecretSource = {
  credential: 'manager-db-url',
  fileVariable: 'ADMIN_AUTH_MANAGER_DATABASE_URL_FILE',
  private: true,
};
const DATABASE_CA: SecretSource = { credential: 'db-ca', fileVariable: 'ADMIN_AUTH_DB_CA_FILE', private: false };

type FileStat = { mode: number; isFile(): boolean };

/**
 * Why a secret file named by an environment variable is unsafe to use, or null.
 * Files from $CREDENTIALS_DIRECTORY are not checked: systemd creates them
 * private to the service. POSIX modes mean nothing on Windows, where ACLs are
 * not inspected (local development only).
 */
export function secretFileProblem(stat: FileStat, platform: string = process.platform): string | null {
  if (!stat.isFile()) return 'is not a regular file';
  if (platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    return 'is readable or writable by group or others; run chmod 600 on it';
  }
  return null;
}

function readSecret(env: Env, source: SecretSource, required: true): string;
function readSecret(env: Env, source: SecretSource, required: false): string | null;
function readSecret(env: Env, source: SecretSource, required: boolean): string | null {
  const credentialPath = env.CREDENTIALS_DIRECTORY ? join(env.CREDENTIALS_DIRECTORY, source.credential) : null;
  const fromCredentials = credentialPath !== null && existsSync(credentialPath);
  const path = fromCredentials ? credentialPath : env[source.fileVariable];
  if (!path) {
    if (!required) return null;
    throw new ConfigError(
      `No ${source.credential} secret: use systemd LoadCredential=${source.credential}:... or set ${source.fileVariable} to a file path.`,
    );
  }

  if (!fromCredentials && source.private) {
    let stat: FileStat;
    try {
      stat = statSync(path);
    } catch {
      throw new ConfigError(`The file named by ${source.fileVariable} cannot be read.`);
    }
    const problem = secretFileProblem(stat);
    if (problem) throw new ConfigError(`The file named by ${source.fileVariable} ${problem}.`);
  }

  let value: string;
  try {
    value = readFileSync(path, 'utf8').trim();
  } catch {
    throw new ConfigError(`The ${source.credential} secret file cannot be read.`);
  }
  if (!value) throw new ConfigError(`The ${source.credential} secret file is empty.`);
  return value;
}

const LOCAL_DB_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Database URLs are read from a file, never from an environment variable:
 * environment variables leak into /proc/<pid>/environ, child processes and
 * crash reports.
 */
export function loadDatabaseConfig(env: Env, source: SecretSource): PoolConfig {
  for (const name of ['ADMIN_AUTH_DATABASE_URL', 'DATABASE_URL']) {
    if (env[name]) {
      throw new ConfigError(`${name} is not read. Put the URL in a file (${source.fileVariable}) or a systemd credential.`);
    }
  }
  return buildPoolConfig(readSecret(env, source, true), readSecret(env, DATABASE_CA, false));
}

function decode(part: string, what: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new ConfigError(`The database URL has a malformed ${what}.`);
  }
}

/**
 * Turns the URL into discrete connection fields. The URL is never handed to
 * pg as a connectionString: pg copies every query parameter into its config,
 * so `?host=` would silently replace the host checked below and `?max=` or
 * `?statement_timeout=` would override the pool settings.
 *
 * The only query parameter accepted is sslmode: verify-full anywhere, or
 * disable for a local database. Every non-local database gets TLS with
 * certificate and hostname verification, whatever the URL says.
 *
 * Error messages never include the URL or any part of it.
 */
export function buildPoolConfig(connectionString: string, ca: string | null): PoolConfig {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new ConfigError('The database URL is not a valid URL.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new ConfigError('The database URL must start with postgres:// or postgresql://.');
  }

  for (const key of new Set(url.searchParams.keys())) {
    if (key !== 'sslmode') {
      throw new ConfigError(`The database URL parameter "${key}" is not accepted; only sslmode is.`);
    }
  }
  const sslmodes = url.searchParams.getAll('sslmode');
  if (sslmodes.length > 1) throw new ConfigError('The database URL sets sslmode more than once.');
  const sslmode = sslmodes[0] ?? null;

  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (!host) throw new ConfigError('The database URL must name a host.');
  const local = LOCAL_DB_HOSTS.has(host);

  if (sslmode !== null && sslmode !== 'verify-full' && !(local && sslmode === 'disable')) {
    throw new ConfigError(
      `sslmode=${sslmode} is not accepted: use verify-full (or omit it), or disable for a local database only.`,
    );
  }

  const user = decode(url.username, 'user name');
  const password = decode(url.password, 'password');
  const database = decode(url.pathname.replace(/^\//, ''), 'database name');
  if (!user) throw new ConfigError('The database URL must include a user name.');
  if (!database || database.includes('/')) throw new ConfigError('The database URL must name exactly one database.');

  const port = url.port ? Number(url.port) : 5432;
  const useTls = !local || sslmode === 'verify-full';

  return {
    host,
    port,
    user,
    ...(password ? { password } : {}),
    database,
    ssl: useTls ? { rejectUnauthorized: true, ...(ca ? { ca } : {}) } : false,
    application_name: 'ats-admin-auth',
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 5_000,
  };
}
