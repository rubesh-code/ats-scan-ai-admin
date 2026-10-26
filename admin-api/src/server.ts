import { accessVerifier } from './access.js';
import { buildApp } from './app.js';
import { ConfigError, loadConfig, type ApiConfig } from './config.js';
import { cachedSource, supabaseSource } from './source.js';

/** How long one database snapshot serves requests. */
const SNAPSHOT_TTL_MS = 30_000;

let config: ApiConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  // Configuration messages name variables, never secret values.
  process.stderr.write(`ats-admin-api: refusing to start: ${error.message}\n`);
  process.exit(1);
}

const app = await buildApp({
  source: cachedSource(supabaseSource(config.supabase), SNAPSHOT_TTL_MS),
  verify: accessVerifier(config.access),
  customerHealthUrl: config.customerHealthUrl,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });
