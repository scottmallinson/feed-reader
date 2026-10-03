import pg from 'pg';
import { config } from '../config.js';

// Return bigint ids (int8) as strings and keep timestamps as Date objects.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.poolMax });
    // Idle connections can be dropped by the server or a pooler (Neon suspends idle computes).
    // Without a listener that 'error' event would crash the process; the pool reconnects on demand.
    pool.on('error', (err) => console.error('postgres pool error', err.message));
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}

export function query<T extends pg.QueryResultRow = any>(text: string, values?: unknown[]) {
  return getPool().query<T>(text, values);
}
