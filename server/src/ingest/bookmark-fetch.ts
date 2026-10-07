import { config } from '../config.js';
import * as repo from '../db/repo.js';
import { excerpt, extractArticle } from './content.js';

/** A failed fetch; `dead` means retrying cannot help (gone, or the host no longer exists). */
export class PageFetchError extends Error {
  constructor(
    message: string,
    readonly dead: boolean,
  ) {
    super(message);
  }
}

/** Errors that mean the link is gone for good rather than temporarily unreachable. */
function classify(err: unknown): PageFetchError {
  if (err instanceof PageFetchError) return err;
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  if (code === 'ENOTFOUND') return new PageFetchError('Host not found (DNS lookup failed)', true);
  if (err instanceof Error && err.name === 'TimeoutError') return new PageFetchError('Timed out', false);
  const detail = code ?? (err instanceof Error ? err.message : String(err));
  return new PageFetchError(`Request failed: ${detail}`, false);
}

/** Fetches a page's HTML, or null when the URL serves something other than a web page. */
export async function fetchPage(url: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': config.userAgent, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
    });
  } catch (err) {
    throw classify(err);
  }
  if (!res.ok) {
    // 408 and 429 are temporary; every other 4xx (404, 410, 403, ...) will not change on retry.
    const dead = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    await res.body?.cancel().catch(() => {});
    throw new PageFetchError(`HTTP ${res.status}`, dead);
  }
  const type = res.headers.get('content-type') ?? '';
  if (type && !/html|xml/i.test(type)) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  try {
    return await res.text();
  } catch (err) {
    throw classify(err);
  }
}

/** Fetches one claimed bookmark and records the outcome. */
async function processBookmark(b: repo.PendingBookmark): Promise<'fetched' | 'dead' | 'retry'> {
  try {
    const html = await fetchPage(b.url);
    const article = html ? extractArticle(html, b.url) : null;
    await repo.recordBookmarkContent(b.id, {
      fullContent: article?.content ?? null,
      contentText: article?.text ?? null,
      summary: article ? (article.excerpt ? excerpt(article.excerpt) : excerpt(article.text)) : null,
      author: article?.byline ?? null,
      thumbnailUrl: article?.image ?? null,
      note: article ? null : html ? 'No readable article content' : 'Not a web page',
    });
    return 'fetched';
  } catch (err) {
    const failure = classify(err);
    const dead = failure.dead || b.attempts + 1 >= config.bookmarkMaxAttempts;
    await repo.recordBookmarkFailure(b.id, failure.message, dead);
    return dead ? 'dead' : 'retry';
  }
}

export interface BookmarkBatchResult {
  fetched: number;
  dead: number;
  retry: number;
  /** Bookmarks still waiting (including ones waiting to be retried). */
  remaining: number;
}

/**
 * Fetches pending bookmarks, most recently saved first, up to `limit` and until `budgetMs` has
 * passed. Logs the list of dead links when this pass leaves nothing pending.
 */
export async function processPendingBookmarks(
  opts: { limit?: number; budgetMs?: number; log?: (msg: string) => void } = {},
): Promise<BookmarkBatchResult> {
  const { limit = config.bookmarkBatch, budgetMs = config.bookmarkBudgetMs, log = console.log } = opts;
  const deadline = Date.now() + budgetMs;
  const result: BookmarkBatchResult = { fetched: 0, dead: 0, retry: 0, remaining: 0 };
  let started = 0;
  const worker = async () => {
    while (started < limit && Date.now() < deadline) {
      started++;
      const next = await repo.claimPendingBookmark(config.bookmarkRetryMinutes);
      if (!next) return;
      result[await processBookmark(next)]++;
    }
  };
  await Promise.all(Array.from({ length: config.bookmarkConcurrency }, worker));

  result.remaining = await repo.countPendingBookmarks();
  const done = result.fetched + result.dead + result.retry;
  if (done > 0) {
    log(
      `bookmarks: ${result.fetched} fetched, ${result.dead} dead, ${result.retry} to retry, ${result.remaining} remaining`,
    );
  }
  if (done === 0 && result.remaining > 0) {
    log(`bookmarks: ${result.remaining} pending, none due yet (waiting to retry after a failure)`);
  }
  if (done > 0 && result.remaining === 0) await logDeadLinks(log);
  return result;
}

let draining = false;

/** Keeps fetching in this process until no bookmark is eligible, e.g. right after an import. */
export async function drainPendingBookmarks(log: (msg: string) => void = console.log) {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const r = await processPendingBookmarks({ limit: 100, budgetMs: Infinity, log });
      if (r.fetched + r.dead + r.retry === 0) return;
    }
  } catch (err) {
    log(`bookmarks: background fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    draining = false;
  }
}

async function logDeadLinks(log: (msg: string) => void) {
  const report = await repo.bookmarkReport(config.userId);
  log(
    `bookmarks: import complete — ${report.fetched} of ${report.total} fetched, ${report.dead.length} dead links`,
  );
  for (const d of report.dead) log(`bookmarks: dead (${d.error ?? 'unknown'}): ${d.url}`);
}
