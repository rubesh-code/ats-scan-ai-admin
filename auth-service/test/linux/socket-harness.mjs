// Linux CI only: serves the compiled app on a Unix socket so
// socket-access.sh can probe it as different OS users. Storage is an
// in-memory PGlite database with synthetic data; no database server is used.
//
// Usage (with dist/ built): ADMIN_AUTH_SOCKET=... ADMIN_AUTH_ALLOWED_ORIGINS=... node socket-harness.mjs
// Exit codes: 3 = refused to start (configuration/socket directory), printed on stderr.
import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';

import { buildApp } from '../../dist/app.js';
import { ConfigError, loadConfig } from '../../dist/config.js';
import { prepareSocketPath, restrictSocket } from '../../dist/listen.js';
import { PasswordHasher } from '../../dist/password.js';
import { AuthStore } from '../../dist/store.js';

function refuse(error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(`refusing to start: ${error.message}\n`);
  process.exit(3);
}

let config;
try {
  config = loadConfig(process.env);
  if (config.listen.kind !== 'unix') throw new ConfigError('ADMIN_AUTH_SOCKET is required.');
  prepareSocketPath(config.listen.path);
} catch (error) {
  refuse(error);
}

const sql = (path) => readFileSync(new URL(`../../db/${path}`, import.meta.url), 'utf8');
const pg = new PGlite();
await pg.exec(sql('roles.sql'));
await pg.exec(sql('migrations/001_admin_auth.sql'));

const db = {
  query: (text, params) => pg.query(text, params),
  transaction: (work) => pg.transaction((tx) => work({ query: (text, params) => tx.query(text, params) })),
};

const app = await buildApp({
  config,
  store: new AuthStore(db),
  passwords: new PasswordHasher({ memoryCost: 4096, timeCost: 1, parallelism: 1 }),
  logger: false,
});
await app.listen({ path: config.listen.path });
restrictSocket(config.listen.path);
process.stdout.write('ready\n');

process.once('SIGTERM', async () => {
  await app.close();
  await pg.close();
  process.exit(0);
});
