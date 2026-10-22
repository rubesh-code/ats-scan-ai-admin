import { ConfigError } from './config.js';
import { isAdminRole, isValidUsername, normalizeUsername, type AdminRole } from './identity.js';
import { passwordProblem, PASSWORD_MAX_LENGTH, type PasswordHasher } from './password.js';
import { AccountExistsError, type AccountManager } from './store.js';

export type CliInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

export type CliIO = {
  stdin: CliInput;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
};

export type CliDeps = {
  openManager: () => Promise<{ manager: AccountManager; close(): Promise<void> }>;
  passwords: PasswordHasher;
  /** The operator, for the audit log (e.g. SUDO_USER). */
  actor: string;
  now?: () => Date;
};

export const USAGE = `Usage: ats-admin-auth <command> <username> [--role owner|admin|viewer]

Commands:
  create <username> [--role ROLE]   Create an admin account (default role: admin)
  reset-password <username>         Set a new password; signs the account out everywhere
  disable <username>                Disable the account and end its sessions
  enable <username>                 Re-enable a disabled account
  unlock <username>                 Clear failed-login lockout
  revoke-sessions <username>        Sign the account out everywhere

Passwords are never accepted as arguments or environment variables. Run this
on a terminal (ssh -t) and you are prompted twice with echo off. Without a
terminal, the first line of standard input is used: feed it only from a
password manager or a private file, never from echo/printf, which would leave
the password in your shell history.
`;

class CliError extends Error {}

const MAX_STDIN_BYTES = 4096;

/** Reads one line from the terminal with echo off. */
function promptHidden(prompt: string, io: CliIO): Promise<string> {
  const { stdin } = io;
  io.stderr.write(prompt);
  stdin.setRawMode!(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error: Error | null) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode!(false);
      stdin.pause();
      io.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string | Buffer) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') return finish(null);
        if (ch === '\u0003' || ch === '\u0004') return finish(new CliError('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') {
          value = [...value].slice(0, -1).join('');
          continue;
        }
        if (ch < ' ') continue;
        value += ch;
        if (value.length > PASSWORD_MAX_LENGTH * 4) return finish(new CliError('Password is too long.'));
      }
    };
    stdin.on('data', onData);
  });
}

async function readFirstLine(io: CliIO): Promise<string> {
  let text = '';
  for await (const chunk of io.stdin) {
    text += String(chunk);
    if (text.length > MAX_STDIN_BYTES) throw new CliError('Standard input is too long.');
    if (text.includes('\n')) break;
  }
  return (text.split('\n')[0] ?? '').replace(/\r$/, '');
}

async function readNewPassword(io: CliIO, username: string): Promise<string> {
  let password: string;
  if (io.stdin.isTTY && typeof io.stdin.setRawMode === 'function') {
    password = await promptHidden('New password: ', io);
    const again = await promptHidden('Repeat password: ', io);
    if (again !== password) throw new CliError('Passwords do not match.');
  } else {
    password = await readFirstLine(io);
  }
  const problem = passwordProblem(password, username);
  if (problem) throw new CliError(problem);
  return password;
}

function parseArgs(argv: string[]): { command: string; username: string; role: AdminRole } {
  if (argv.some((arg) => /^(--?pass(word)?|-p)(=|$)/i.test(arg))) {
    throw new CliError('Passwords are never accepted as arguments. Omit it and you will be prompted.');
  }
  const [command, rawUsername, ...rest] = argv;
  if (!command || !rawUsername) throw new CliError(USAGE);

  let role: AdminRole = 'admin';
  if (rest.length > 0) {
    const [flag, value] = rest;
    if (command !== 'create' || flag !== '--role' || !value || rest.length !== 2 || !isAdminRole(value)) {
      throw new CliError(USAGE);
    }
    role = value;
  }

  const username = normalizeUsername(rawUsername);
  if (!isValidUsername(username)) {
    throw new CliError('Usernames are 3-64 characters: lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.');
  }
  return { command, username, role };
}

/**
 * A message safe to show an operator. Driver errors can quote SQL, values or
 * server details, so only their code is shown (a SQLSTATE such as 28P01, or a
 * Node error code such as ECONNREFUSED).
 */
function describeFailure(error: unknown): string {
  if (error instanceof ConfigError) return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  const safeCode = typeof code === 'string' && /^([0-9A-Z]{5}|E[A-Z_]{2,30})$/.test(code) ? ` (code ${code})` : '';
  return `Failed: the database operation did not complete${safeCode}. The change was not applied.`;
}

/** Returns the process exit code. Never writes a password or a raw driver error anywhere. */
export async function runCli(argv: string[], io: CliIO, deps: CliDeps): Promise<number> {
  const now = deps.now ?? (() => new Date());
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.stderr.write(`${(error as Error).message.trimEnd()}\n`);
    return 2;
  }
  const { command, username, role } = args;
  const known = ['create', 'reset-password', 'disable', 'enable', 'unlock', 'revoke-sessions'];
  if (!known.includes(command)) {
    io.stderr.write(USAGE);
    return 2;
  }

  // Read the password before connecting, so a typo costs no database round trip.
  let passwordHash: string | null = null;
  try {
    if (command === 'create' || command === 'reset-password') {
      passwordHash = await deps.passwords.hash(await readNewPassword(io, username));
    }
  } catch (error) {
    io.stderr.write(`${error instanceof CliError ? error.message : 'Could not read the password.'}\n`);
    return 1;
  }

  let opened: Awaited<ReturnType<CliDeps['openManager']>>;
  try {
    opened = await deps.openManager();
  } catch (error) {
    io.stderr.write(`${describeFailure(error)}\n`);
    return 1;
  }

  const { manager, close } = opened;
  // Each change below commits together with its audit row, or not at all.
  const ctx = { at: now(), actor: deps.actor };
  try {
    switch (command) {
      case 'create': {
        await manager.createAccount(username, passwordHash!, role, ctx);
        io.stdout.write(`Created ${role} account "${username}".\n`);
        return 0;
      }
      case 'reset-password': {
        const result = await manager.resetPassword(username, passwordHash!, ctx);
        if (!result) break;
        io.stdout.write(`Password reset for "${username}"; ended ${result.sessionsEnded} session(s).\n`);
        return 0;
      }
      case 'disable':
      case 'enable': {
        const id = await manager.setDisabled(username, command === 'disable', ctx);
        if (!id) break;
        io.stdout.write(`Account "${username}" ${command}d.\n`);
        return 0;
      }
      case 'unlock': {
        const id = await manager.unlock(username, ctx);
        if (!id) break;
        io.stdout.write(`Lockout cleared for "${username}".\n`);
        return 0;
      }
      case 'revoke-sessions': {
        const result = await manager.revokeSessions(username, ctx);
        if (!result) break;
        io.stdout.write(`Ended ${result.sessionsEnded} session(s) for "${username}".\n`);
        return 0;
      }
    }
    io.stderr.write(`No admin account "${username}".\n`);
    return 1;
  } catch (error) {
    io.stderr.write(`${error instanceof AccountExistsError ? error.message : describeFailure(error)}\n`);
    return 1;
  } finally {
    await close().catch(() => {});
  }
}
