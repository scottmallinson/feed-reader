import pg from 'pg';
import { config } from '../config.js';

// Return bigint ids (int8) as strings and keep timestamps as Date objects.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: config.databaseUrl, max: config.poolMax });
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
