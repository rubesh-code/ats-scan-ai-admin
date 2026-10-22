import pg from 'pg';

import type { Db } from './store.js';

export type Database = Db & { close(): Promise<void> };

export function openDatabase(config: pg.PoolConfig, onError: (error: Error) => void): Database {
  const pool = new pg.Pool(config);
  // An idle client losing its connection must not crash the process.
  pool.on('error', onError);

  return {
    query: (text, params) => pool.query(text, params),

    async transaction(work) {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query('begin');
        const result = await work({ query: (text, params) => client.query(text, params) });
        await client.query('commit');
        return result;
      } catch (error) {
        try {
          await client.query('rollback');
        } catch {
          // The connection is unusable; destroy it rather than return it to the pool.
          broken = true;
        }
        throw error;
      } finally {
        client.release(broken);
      }
    },

    close: () => pool.end(),
  };
}
