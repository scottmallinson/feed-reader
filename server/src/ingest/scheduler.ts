import cron from 'node-cron';
import { config } from '../config.js';
import { refreshAll } from './ingest.js';

let running = false;

/** Runs one ingestion pass unless one is already in flight. */
export async function runIngestion(log: (msg: string) => void = console.log): Promise<void> {
  if (running) return;
  running = true;
  const started = Date.now();
  try {
    const results = await refreshAll();
    const inserted = results.reduce((n, r) => n + r.inserted, 0);
    const failed = results.filter((r) => r.error);
    log(
      `ingest: ${results.length} feeds, ${inserted} new items, ${failed.length} errors in ${Date.now() - started}ms`,
    );
    for (const f of failed) log(`ingest: feed ${f.feedId} failed: ${f.error}`);
  } catch (err) {
    log(`ingest: pass failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    running = false;
  }
}

export function startScheduler(log: (msg: string) => void = console.log) {
  if (!cron.validate(config.fetchCron)) throw new Error(`Invalid FETCH_CRON: ${config.fetchCron}`);
  const task = cron.schedule(config.fetchCron, () => runIngestion(log), { noOverlap: true });
  void runIngestion(log);
  log(`ingest: scheduled with "${config.fetchCron}"`);
  return task;
}
