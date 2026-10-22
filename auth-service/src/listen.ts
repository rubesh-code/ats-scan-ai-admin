import { chmodSync, lstatSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

import { ConfigError } from './config.js';

/**
 * The socket admits its owner (the service) and its group. In deployment the
 * group is the service's own group, of which only the nginx user is also a
 * member; nobody else can connect.
 */
export const SOCKET_MODE = 0o660;

type DirStat = { mode: number; uid: number; isDirectory(): boolean };

/** Why the socket's directory is unsafe, or null. It must be the service's own and closed to other users. */
export function socketDirectoryProblem(stat: DirStat, uid: number): string | null {
  if (!stat.isDirectory()) return 'is not a directory';
  if (stat.uid !== uid) return 'is not owned by the service user';
  if ((stat.mode & 0o007) !== 0) return 'is accessible to other users (use mode 0750 or stricter)';
  return null;
}

/**
 * Checks the directory and removes a socket left by a previous run (which
 * would otherwise make listen() fail). Anything at the path that is not a
 * socket is refused rather than deleted.
 */
export function prepareSocketPath(path: string): void {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    throw new ConfigError('ADMIN_AUTH_SOCKET needs Linux; for local development use ADMIN_AUTH_HOST/ADMIN_AUTH_PORT.');
  }
  const dir = dirname(path);
  let dirStat: DirStat;
  try {
    dirStat = statSync(dir);
  } catch {
    throw new ConfigError(`The socket directory ${dir} does not exist (systemd RuntimeDirectory= creates it).`);
  }
  const problem = socketDirectoryProblem(dirStat, process.getuid());
  if (problem) throw new ConfigError(`The socket directory ${dir} ${problem}.`);

  let existing;
  try {
    existing = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!existing.isSocket()) throw new ConfigError(`${path} exists and is not a socket.`);
  unlinkSync(path);
}

/**
 * Called right after listen(). Until then the socket has the process umask
 * (0077 under the systemd unit, so 0600): it is never more open than this.
 */
export function restrictSocket(path: string): void {
  chmodSync(path, SOCKET_MODE);
  const mode = statSync(path).mode & 0o777;
  if (mode !== SOCKET_MODE) {
    throw new Error(`Socket ${path} has mode ${mode.toString(8)}, expected ${SOCKET_MODE.toString(8)}.`);
  }
}
