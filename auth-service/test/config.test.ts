import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  buildPoolConfig,
  ConfigError,
  loadConfig,
  loadDatabaseConfig,
  MANAGER_DATABASE,
  secretFileProblem,
  SERVICE_DATABASE,
} from '../src/config.js';

const ORIGINS = { ADMIN_AUTH_ALLOWED_ORIGINS: 'http://ats-admin.localhost:5070' };
const onWindows = process.platform === 'win32';

describe('listen target', () => {
  it('defaults to TCP 127.0.0.1:5071 for development, without trusting X-Forwarded-For', () => {
    expect(loadConfig(ORIGINS)).toMatchObject({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 5071 },
      trustForwardedFor: false,
    });
  });

  it('uses a Unix socket when ADMIN_AUTH_SOCKET is set, and only then trusts X-Forwarded-For', () => {
    expect(loadConfig({ ...ORIGINS, ADMIN_AUTH_SOCKET: '/run/ats-admin-auth/auth.sock' })).toMatchObject({
      listen: { kind: 'unix', path: '/run/ats-admin-auth/auth.sock' },
      trustForwardedFor: true,
    });
  });

  it.each(['relative/auth.sock', '/run/../tmp/auth.sock', '/run//auth.sock', `/${'x'.repeat(100)}`, '/run/a\u0000b'])(
    'refuses socket path %j',
    (path) => {
      expect(() => loadConfig({ ...ORIGINS, ADMIN_AUTH_SOCKET: path })).toThrow(ConfigError);
    },
  );

  it('refuses a socket and a TCP address together', () => {
    expect(() =>
      loadConfig({ ...ORIGINS, ADMIN_AUTH_SOCKET: '/run/ats-admin-auth/auth.sock', ADMIN_AUTH_PORT: '5071' }),
    ).toThrow(/not both/);
  });

  it.each(['127.0.0.1', '127.0.0.2', '::1'])('accepts loopback %s', (host) => {
    expect(loadConfig({ ...ORIGINS, ADMIN_AUTH_HOST: host }).listen).toMatchObject({ host });
  });

  it.each(['0.0.0.0', '::', '172.31.5.10', '51.21.242.89', 'localhost', 'ats-admin.localhost'])(
    'refuses non-loopback or non-literal host %s',
    (host) => {
      expect(() => loadConfig({ ...ORIGINS, ADMIN_AUTH_HOST: host })).toThrow(ConfigError);
    },
  );

  it.each(['80', '0', '70000', 'abc'])('refuses port %s', (port) => {
    expect(() => loadConfig({ ...ORIGINS, ADMIN_AUTH_PORT: port })).toThrow(ConfigError);
  });
});

describe('allowed origins', () => {
  it('derives the exact allowed Host values', () => {
    const config = loadConfig({
      ADMIN_AUTH_ALLOWED_ORIGINS: 'http://ats-admin.localhost:5070, https://admin.atsscanai.com',
    });
    expect([...config.allowedOrigins]).toEqual(['http://ats-admin.localhost:5070', 'https://admin.atsscanai.com']);
    expect([...config.allowedHosts]).toEqual(['ats-admin.localhost:5070', 'admin.atsscanai.com']);
  });

  it.each([
    undefined,
    '',
    '*',
    'http://ats-admin.localhost:5070/',
    'http://ats-admin.localhost:5070/login',
    'http://admin.atsscanai.com',
    'http://51.21.242.89:5070',
    'ftp://ats-admin.localhost',
  ])('refuses %s', (value) => {
    expect(() => loadConfig({ ADMIN_AUTH_ALLOWED_ORIGINS: value })).toThrow(ConfigError);
  });

  it('holds the approved session and lockout policy', () => {
    const config = loadConfig(ORIGINS);
    expect(config.idleTimeoutMs).toBe(30 * 60_000);
    expect(config.absoluteTimeoutMs).toBe(8 * 60 * 60_000);
    expect(config.lockout).toEqual({ maxFailures: 5, windowMs: 15 * 60_000, durationMs: 15 * 60_000 });
  });

  it('cannot be weakened from the environment', () => {
    const config = loadConfig({ ...ORIGINS, ADMIN_AUTH_IDLE_TIMEOUT_MS: '999999999', ADMIN_AUTH_MAX_FAILURES: '1000' });
    expect(config.idleTimeoutMs).toBe(30 * 60_000);
    expect(config.lockout.maxFailures).toBe(5);
  });
});

describe('database connection', () => {
  const remote = 'postgresql://ats_admin_auth_app:pw@db.example.supabase.co:5432/postgres';

  it('turns the URL into discrete fields; pg never sees a connection string', () => {
    const config = buildPoolConfig(remote, null);
    expect(config).not.toHaveProperty('connectionString');
    expect(config).toMatchObject({
      host: 'db.example.supabase.co',
      port: 5432,
      user: 'ats_admin_auth_app',
      password: 'pw',
      database: 'postgres',
      max: 5,
      statement_timeout: 5000,
    });
  });

  it('always verifies TLS for a remote database', () => {
    expect(buildPoolConfig(remote, null).ssl).toEqual({ rejectUnauthorized: true });
    expect(buildPoolConfig(remote, 'CA PEM').ssl).toEqual({ rejectUnauthorized: true, ca: 'CA PEM' });
    expect(buildPoolConfig(`${remote}?sslmode=verify-full`, null).ssl).toEqual({ rejectUnauthorized: true });
  });

  it('closes the reported ?host= bypass: a local-looking URL cannot redirect to a remote host', () => {
    expect(() =>
      buildPoolConfig('postgresql://u:p@127.0.0.1:5432/postgres?host=db.example.supabase.co', null),
    ).toThrow(/"host" is not accepted/);
  });

  it.each([
    'host=db.example.com',
    'hostaddr=10.0.0.5',
    'port=6543',
    'max=500',
    'statement_timeout=0',
    'idle_in_transaction_session_timeout=0',
    'connectionTimeoutMillis=0',
    'connect_timeout=0',
    'options=-c%20statement_timeout%3D0',
    'ssl=false',
    'ssl=0',
    'sslrootcert=/tmp/evil.pem',
    'sslcert=/tmp/c.pem',
    'sslkey=/tmp/k.pem',
    'uselibpqcompat=true',
    'application_name=x',
    'user=postgres',
    'password=x',
    'database=other',
    'client_encoding=SQL_ASCII',
  ])('refuses the query parameter %s', (param) => {
    expect(() => buildPoolConfig(`${remote}?${param}`, null)).toThrow(ConfigError);
    expect(() => buildPoolConfig(`postgresql://u:p@127.0.0.1/db?${param}`, null)).toThrow(ConfigError);
  });

  it.each(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'no-verify'])(
    'refuses sslmode=%s for a remote database',
    (mode) => {
      expect(() => buildPoolConfig(`${remote}?sslmode=${mode}`, null)).toThrow(ConfigError);
    },
  );

  it('refuses sslmode given twice', () => {
    expect(() => buildPoolConfig(`${remote}?sslmode=verify-full&sslmode=disable`, null)).toThrow(/more than once/);
  });

  it('allows plain connections only to a local database', () => {
    expect(buildPoolConfig('postgresql://u:p@127.0.0.1:55433/test', null).ssl).toBe(false);
    expect(buildPoolConfig('postgresql://u:p@[::1]:55433/test?sslmode=disable', null).ssl).toBe(false);
    expect(buildPoolConfig('postgresql://u:p@localhost/test?sslmode=verify-full', null).ssl).toEqual({
      rejectUnauthorized: true,
    });
  });

  it.each([
    ['mysql://u:p@db/x', /postgres:\/\//],
    ['not a url', /not a valid URL/],
    ['postgresql://u:p@/db', /not a valid URL|name a host/],
    ['postgresql://u:p@db.example.com', /exactly one database/],
    ['postgresql://u:p@db.example.com/a/b', /exactly one database/],
    ['postgresql://:p@db.example.com/db', /user name/],
    ['postgresql://u:%E0%A4%A@db.example.com/db', /malformed password/],
  ])('refuses %s', (url, message) => {
    expect(() => buildPoolConfig(url, null)).toThrow(message);
  });

  it('never puts the URL or its password in an error message', () => {
    for (const url of [
      'postgresql://u:s3cret-value@127.0.0.1/db?host=evil.example.com',
      'postgresql://u:s3cret-value@db.example.com/db?sslmode=disable',
      'postgresql://u:s3cret-value@db.example.com',
    ]) {
      try {
        buildPoolConfig(url, null);
        expect.unreachable();
      } catch (error) {
        expect((error as Error).message).not.toContain('s3cret-value');
        expect((error as Error).message).not.toContain('evil.example.com');
      }
    }
  });

  describe('secret files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ats-admin-auth-test-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const file = (name: string, content: string, mode = 0o600) => {
      const path = join(dir, name);
      writeFileSync(path, content, { mode });
      chmodSync(path, mode);
      return path;
    };

    it('reads the URL from a private file named by the environment', () => {
      const path = file('url', 'postgresql://u:p@127.0.0.1:55433/a\n');
      expect(loadDatabaseConfig({ ADMIN_AUTH_DATABASE_URL_FILE: path }, SERVICE_DATABASE)).toMatchObject({
        host: '127.0.0.1',
        database: 'a',
      });
    });

    it('prefers a systemd credential', () => {
      file('db-url', 'postgresql://u:p@127.0.0.1:55433/from_credential');
      const other = file('other', 'postgresql://u:p@127.0.0.1:55433/from_file');
      const config = loadDatabaseConfig({ CREDENTIALS_DIRECTORY: dir, ADMIN_AUTH_DATABASE_URL_FILE: other }, SERVICE_DATABASE);
      expect(config.database).toBe('from_credential');
    });

    it('uses a separate secret for the operator CLI', () => {
      const path = file('manager', 'postgresql://m:p@127.0.0.1:55433/a');
      expect(() => loadDatabaseConfig({ ADMIN_AUTH_DATABASE_URL_FILE: path }, MANAGER_DATABASE)).toThrow(ConfigError);
      expect(loadDatabaseConfig({ ADMIN_AUTH_MANAGER_DATABASE_URL_FILE: path }, MANAGER_DATABASE).user).toBe('m');
    });

    it('refuses a URL placed directly in the environment', () => {
      const path = file('url2', 'postgresql://u:p@127.0.0.1:55433/a');
      for (const name of ['ADMIN_AUTH_DATABASE_URL', 'DATABASE_URL']) {
        expect(() =>
          loadDatabaseConfig({ [name]: 'postgresql://u:p@x/y', ADMIN_AUTH_DATABASE_URL_FILE: path }, SERVICE_DATABASE),
        ).toThrow(ConfigError);
      }
    });

    it('refuses a missing, unreadable or empty secret', () => {
      expect(() => loadDatabaseConfig({}, SERVICE_DATABASE)).toThrow(ConfigError);
      expect(() => loadDatabaseConfig({ ADMIN_AUTH_DATABASE_URL_FILE: join(dir, 'nope') }, SERVICE_DATABASE)).toThrow(
        ConfigError,
      );
      const empty = file('empty', '  \n');
      expect(() => loadDatabaseConfig({ ADMIN_AUTH_DATABASE_URL_FILE: empty }, SERVICE_DATABASE)).toThrow(ConfigError);
    });

    it.skipIf(onWindows)('refuses a secret file readable by group or others (POSIX only)', () => {
      for (const mode of [0o640, 0o604, 0o644, 0o660]) {
        const path = file(`loose-${mode.toString(8)}`, 'postgresql://u:p@127.0.0.1/a', mode);
        expect(() => loadDatabaseConfig({ ADMIN_AUTH_DATABASE_URL_FILE: path }, SERVICE_DATABASE)).toThrow(/chmod 600/);
      }
    });

    it('refuses a directory where a secret file belongs', () => {
      expect(() => loadDatabaseConfig({ ADMIN_AUTH_DATABASE_URL_FILE: dir }, SERVICE_DATABASE)).toThrow(/regular file/);
    });
  });

  describe('secretFileProblem', () => {
    const stat = (mode: number, isFile = true) => ({ mode, isFile: () => isFile });

    it.each([0o600, 0o400, 0o100600])('accepts mode %s', (mode) => {
      expect(secretFileProblem(stat(mode), 'linux')).toBeNull();
    });

    it.each([0o640, 0o604, 0o644, 0o666, 0o610, 0o601])('refuses mode %s on Linux', (mode) => {
      expect(secretFileProblem(stat(mode), 'linux')).toMatch(/chmod 600/);
    });

    it('does not judge POSIX modes on Windows, but still requires a regular file', () => {
      expect(secretFileProblem(stat(0o666), 'win32')).toBeNull();
      expect(secretFileProblem(stat(0o600, false), 'win32')).toMatch(/regular file/);
    });
  });
});
