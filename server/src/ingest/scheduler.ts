import cron from 'node-cron';
import { config } from '../config.js';
import { processPendingBookmarks } from './bookmark-fetch.js';
import { refreshAll } from './ingest.js';

let running = false;

export interface IngestionSummary {
  feeds: number;
  inserted: number;
  errors: number;
  ms: number;
}

/**
 * Runs one ingestion pass unless one is already in flight in this process.
 * Returns null when skipped or when the pass itself failed.
 */
export async function runIngestion(
  log: (msg: string) => void = console.log,
): Promise<IngestionSummary | null> {
  if (running) return null;
  running = true;
  const started = Date.now();
  try {
    const results = await refreshAll();
    const failed = results.filter((r) => r.error);
    const summary = {
      feeds: results.length,
      inserted: results.reduce((n, r) => n + r.inserted, 0),
      errors: failed.length,
      ms: Date.now() - started,
    };
    log(
      `ingest: ${summary.feeds} feeds, ${summary.inserted} new items, ${summary.errors} errors in ${summary.ms}ms`,
    );
    for (const f of failed) log(`ingest: feed ${f.feedId} failed: ${f.error}`);
    // A slice of any imported bookmarks still waiting for their article text.
    await processPendingBookmarks({ log }).catch((err) =>
      log(`bookmarks: pass failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    return summary;
  } catch (err) {
    log(`ingest: pass failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
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
