import { userInfo } from 'node:os';

import { runCli } from './admin-cli.js';
import { loadDatabaseConfig, MANAGER_DATABASE } from './config.js';
import { openDatabase } from './db.js';
import { PasswordHasher } from './password.js';
import { AccountManager } from './store.js';

const code = await runCli(
  process.argv.slice(2),
  { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
  {
    passwords: new PasswordHasher(),
    actor: process.env.SUDO_USER || userInfo().username,
    openManager: async () => {
      // Connects as ats_admin_auth_manager, not as the service's role.
      // Pool errors on idle clients are ignored here: the CLI makes one
      // change and exits, and a failed query is reported by runCli.
      const db = openDatabase(loadDatabaseConfig(process.env, MANAGER_DATABASE), () => {});
      return { manager: new AccountManager(db), close: () => db.close() };
    },
  },
).catch(() => {
  // Never print the raw error: it may quote SQL or connection details.
  process.stderr.write('Failed: unexpected error. The change was not applied.\n');
  return 1;
});
process.exitCode = code;
