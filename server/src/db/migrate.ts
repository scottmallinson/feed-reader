import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { closePool, getPool } from './pool.js';

const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));

/**
 * Applies every migrations/*.sql file that has not run yet, in filename order.
 *
 * Everything runs in one transaction holding a transaction-scoped advisory lock, so concurrent
 * migrators (API, worker, MCP, serverless cold starts) serialize, and the lock is safe behind
 * transaction-mode poolers such as PgBouncer or Neon's pooled endpoint.
 */
export async function migrate(log: (msg: string) => void = console.error): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(727274)');
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const pending = files.filter((f) => !applied.has(f));
    for (const file of pending) {
      await client.query(await readFile(path.join(migrationsDir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    }
    await client.query('COMMIT');
    for (const file of pending) log(`migrated: ${file}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then(() => closePool())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
