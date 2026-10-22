import { buildApp } from './app.js';
import { ConfigError, loadConfig, loadDatabaseConfig, SERVICE_DATABASE, type AuthConfig } from './config.js';
import { openDatabase } from './db.js';
import { prepareSocketPath, restrictSocket } from './listen.js';
import { PasswordHasher } from './password.js';
import { AuthStore } from './store.js';

const PRUNE_INTERVAL_MS = 10 * 60_000;
const FAILURE_RETENTION_MS = 24 * 60 * 60_000;

function refuse(error: unknown): never {
  if (!(error instanceof ConfigError)) throw error;
  // Configuration messages name variables and files, never secret values.
  process.stderr.write(`ats-admin-auth: refusing to start: ${error.message}\n`);
  process.exit(1);
}

let config: AuthConfig;
let databaseConfig: ReturnType<typeof loadDatabaseConfig>;
try {
  config = loadConfig(process.env);
  databaseConfig = loadDatabaseConfig(process.env, SERVICE_DATABASE);
  if (config.listen.kind === 'unix') prepareSocketPath(config.listen.path);
} catch (error) {
  refuse(error);
}

let logError: (error: Error) => void = (error) => console.error(error.message);
const db = openDatabase(databaseConfig, (error) => logError(error));
const store = new AuthStore(db);

const app = await buildApp({ config, store, passwords: new PasswordHasher() });
logError = (error) => app.log.error({ err: error }, 'database pool error');

async function prune() {
  const at = Date.now();
  await store.prune(new Date(at), new Date(at - config.idleTimeoutMs), new Date(at - FAILURE_RETENTION_MS));
}

// Fail fast if the database or the admin_auth schema is unreachable.
await prune();
const pruneTimer = setInterval(() => {
  prune().catch((error: Error) => app.log.error({ err: error }, 'session prune failed'));
}, PRUNE_INTERVAL_MS);
pruneTimer.unref();

if (config.listen.kind === 'unix') {
  await app.listen({ path: config.listen.path });
  restrictSocket(config.listen.path);
} else {
  // Development only: a loopback address (validated), and X-Forwarded-For is ignored.
  await app.listen({ host: config.listen.host, port: config.listen.port });
}

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  clearInterval(pruneTimer);
  await app.close();
  await db.close();
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
