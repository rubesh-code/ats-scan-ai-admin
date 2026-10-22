import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { prepareSocketPath, restrictSocket, socketDirectoryProblem, SOCKET_MODE } from '../src/listen.js';
import { PasswordHasher } from '../src/password.js';
import { AuthStore } from '../src/store.js';
import { asRole, createDatabase, FAST_ARGON2, HOST, ORIGIN } from './helpers.js';

const dirStat = (mode: number, uid = 1000, isDirectory = true) => ({ mode, uid, isDirectory: () => isDirectory });

describe('socketDirectoryProblem', () => {
  it.each([0o750, 0o700, 0o40750])('accepts a service-owned directory with mode %s', (mode) => {
    expect(socketDirectoryProblem(dirStat(mode), 1000)).toBeNull();
  });

  it.each([0o755, 0o751, 0o777, 0o1777])('refuses a directory other users can enter (mode %s)', (mode) => {
    expect(socketDirectoryProblem(dirStat(mode), 1000)).toMatch(/other users/);
  });

  it('refuses a directory owned by someone else', () => {
    expect(socketDirectoryProblem(dirStat(0o750, 0), 1000)).toMatch(/not owned/);
  });

  it('refuses something that is not a directory', () => {
    expect(socketDirectoryProblem(dirStat(0o750, 1000, false), 1000)).toMatch(/not a directory/);
  });
});

/**
 * Real Unix-socket checks. They need Linux or macOS: on Windows, Node's
 * listen(path) uses named pipes and POSIX modes do not exist, so these are
 * skipped there and must be run on the Linux host or in Linux CI.
 */
describe.skipIf(process.platform === 'win32')('listening on a Unix socket (POSIX only)', () => {
  let db: PGlite;
  let dir: string;

  beforeAll(async () => {
    db = await createDatabase();
    dir = mkdtempSync(join(tmpdir(), 'ats-sock-'));
    chmodSync(dir, 0o750);
  });
  afterAll(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a world-accessible socket directory', () => {
    const open = mkdtempSync(join(tmpdir(), 'ats-open-'));
    chmodSync(open, 0o755);
    try {
      expect(() => prepareSocketPath(join(open, 'auth.sock'))).toThrow(ConfigError);
    } finally {
      rmSync(open, { recursive: true, force: true });
    }
  });

  it('replaces a stale socket left by a killed process', async () => {
    const path = join(dir, 'stale.sock');
    // A process killed with SIGKILL cannot remove its socket file.
    const child = spawn(
      process.execPath,
      ['-e', `require('net').createServer().listen(${JSON.stringify(path)}, () => console.log('up'))`],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()));
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    expect(lstatSync(path).isSocket()).toBe(true);

    prepareSocketPath(path);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses to replace a non-socket file at the socket path', () => {
    const path = join(dir, 'not-a-socket');
    writeFileSync(path, 'x');
    expect(() => prepareSocketPath(path)).toThrow(/not a socket/);
  });

  it('serves on a 0660 socket and believes X-Forwarded-For only there', async () => {
    const path = join(dir, 'auth.sock');
    const config = loadConfig({ ADMIN_AUTH_ALLOWED_ORIGINS: ORIGIN, ADMIN_AUTH_SOCKET: path });
    const app = await buildApp({
      config,
      store: new AuthStore(asRole(db, 'ats_admin_auth_app')),
      passwords: new PasswordHasher(FAST_ARGON2),
      logger: false,
    });
    try {
      prepareSocketPath(path);
      await app.listen({ path });
      restrictSocket(path);
      expect(statSync(path).mode & 0o777).toBe(SOCKET_MODE);

      const body = JSON.stringify({ username: 'nobody', password: 'wrong password here' });
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            socketPath: path,
            method: 'POST',
            path: '/api/admin/auth/login',
            headers: {
              host: HOST,
              origin: ORIGIN,
              'content-type': 'application/json',
              'x-forwarded-for': '203.0.113.50',
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end(body);
      });
      expect(status).toBe(401);
      const { rows } = await db.query(`select ip from admin_auth.audit_log where event = 'login_failure'`);
      expect(rows).toEqual([{ ip: '203.0.113.50' }]);
    } finally {
      await app.close();
    }
  });
});
