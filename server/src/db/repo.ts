import type { Bookmark } from '../ingest/bookmarks.js';
import { feedKey, type OpmlFeed } from '../ingest/opml.js';
import { escapeLike, slugify } from '../lib/slug.js';
import { type Embedding, InvalidInputError, requireVectors, vectorLiteral } from './enrichment.js';
import { getPool, query } from './pool.js';

export type ReadStatus = 'read' | 'unread' | 'all';

export interface Board {
  id: number;
  name: string;
  slug: string;
  unread_count: number;
}

export interface FeedSubscription {
  id: number;
  url: string;
  /** Display name: the user's custom title if set, otherwise the feed's own title. */
  title: string | null;
  /** The title the feed itself publishes. */
  feed_title: string | null;
  custom_title: string | null;
  slug: string | null;
  site_url: string | null;
  last_fetched: Date | null;
  last_error: string | null;
  board_id: number | null;
  unread_count: number;
}

export interface ItemRow {
  id: string;
  feed_id: number;
  feed_title: string | null;
  url: string | null;
  headline: string;
  author: string | null;
  summary: string | null;
  thumbnail_url: string | null;
  published_date: Date | null;
  is_read: boolean;
  is_saved: boolean;
  board_id: number | null;
  /** Set by an enricher (see enrichment.ts); empty until then. */
  tags: string[];
  ai_summary: string | null;
  /** Cosine similarity to the search's topic or embedding, when there was one. */
  similarity?: number | null;
  full_content?: string | null;
  content_text?: string | null;
}

export interface NewItem {
  guid: string;
  url: string | null;
  headline: string;
  author: string | null;
  summary: string | null;
  fullContent: string | null;
  contentText: string | null;
  thumbnailUrl: string | null;
  publishedDate: Date | null;
}

export class NotFoundError extends Error {}

const ITEM_COLUMNS = `
  i.id, i.feed_id, coalesce(s.custom_title, f.title) AS feed_title, i.url, i.headline, i.author, i.summary,
  i.thumbnail_url, i.published_date,
  coalesce(ui.is_read, false) AS is_read,
  coalesce(ui.is_saved, false) AS is_saved,
  ui.board_id,
  coalesce(ie.tags, '{}') AS tags,
  ie.summary AS ai_summary`;

// Items the user can see: anything from a subscribed feed. `$1` is always the user id.
const ITEM_FROM = `
  FROM items i
  JOIN feeds f ON f.id = i.feed_id
  JOIN subscriptions s ON s.feed_id = i.feed_id AND s.user_id = $1
  LEFT JOIN user_items ui ON ui.item_id = i.id AND ui.user_id = $1
  LEFT JOIN item_enrichment ie ON ie.item_id = i.id`;

const SORT_DATE = 'coalesce(i.published_date, i.created_at)';

// An item belongs to a board when its feed is filed there or the user pinned the item to it.
function boardCondition(param: string): string {
  return `(s.board_id = ${param} OR ui.board_id = ${param})`;
}

function statusCondition(status: ReadStatus): string | null {
  if (status === 'read') return 'coalesce(ui.is_read, false)';
  if (status === 'unread') return 'NOT coalesce(ui.is_read, false)';
  return null;
}

async function uniqueSlug(
  base: string,
  exists: (slug: string) => Promise<boolean>,
): Promise<string> {
  let slug = base;
  for (let n = 2; await exists(slug); n++) slug = `${base}-${n}`;
  return slug;
}

// ---------------------------------------------------------------- boards

export async function listBoards(userId: number): Promise<Board[]> {
  const { rows } = await query<Board>(
    `SELECT b.id, b.name, b.slug,
       (SELECT count(*)::int ${ITEM_FROM}
         WHERE ${boardCondition('b.id')} AND NOT coalesce(ui.is_read, false)) AS unread_count
     FROM boards b WHERE b.user_id = $1 ORDER BY lower(b.name)`,
    [userId],
  );
  return rows;
}

export async function createBoard(userId: number, name: string): Promise<Board> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Board name is required');
  const slug = await uniqueSlug(slugify(trimmed), async (s) => {
    const r = await query('SELECT 1 FROM boards WHERE user_id = $1 AND slug = $2', [userId, s]);
    return r.rowCount! > 0;
  });
  const { rows } = await query<Board>(
    `INSERT INTO boards (user_id, name, slug) VALUES ($1, $2, $3)
     RETURNING id, name, slug, 0 AS unread_count`,
    [userId, trimmed, slug],
  );
  return rows[0];
}

export async function deleteBoard(userId: number, boardId: number): Promise<void> {
  const r = await query('DELETE FROM boards WHERE user_id = $1 AND id = $2', [userId, boardId]);
  if (r.rowCount === 0) throw new NotFoundError('Board not found');
}

export async function getBoardBySlug(userId: number, slug: string): Promise<Board | undefined> {
  return (await listBoards(userId)).find((b) => b.slug === slug);
}

// ---------------------------------------------------------------- feeds

export async function listFeeds(userId: number): Promise<FeedSubscription[]> {
  const { rows } = await query<FeedSubscription>(
    `SELECT f.id, f.url, coalesce(s.custom_title, f.title) AS title, f.title AS feed_title,
       s.custom_title, f.slug, f.site_url, f.last_fetched, f.last_error, s.board_id,
       (SELECT count(*)::int FROM items i
          LEFT JOIN user_items ui ON ui.item_id = i.id AND ui.user_id = $1
         WHERE i.feed_id = f.id AND NOT coalesce(ui.is_read, false)) AS unread_count
     FROM subscriptions s JOIN feeds f ON f.id = s.feed_id
     WHERE s.user_id = $1
     ORDER BY lower(coalesce(s.custom_title, f.title, f.url))`,
    [userId],
  );
  return rows;
}

export async function getFeed(userId: number, feedId: number): Promise<FeedSubscription> {
  const feed = (await listFeeds(userId)).find((f) => f.id === feedId);
  if (!feed) throw new NotFoundError('Feed not found');
  return feed;
}

export async function getFeedBySlug(
  userId: number,
  slug: string,
): Promise<FeedSubscription | undefined> {
  return (await listFeeds(userId)).find((f) => f.slug === slug);
}

/** Subscribes the user to a feed URL, creating the feed row if this is the first subscriber. */
export async function subscribe(
  userId: number,
  url: string,
  boardId: number | null = null,
): Promise<number> {
  const normalized = new URL(url).toString();
  // Reuse an existing feed stored under a URL variant (http/https, www., trailing slash).
  const key = feedKey(normalized);
  const { rows: candidates } = await query<{ id: number; url: string }>(
    'SELECT id, url FROM feeds WHERE url ILIKE $1',
    [`%${escapeLike(key.split('/')[0])}%`],
  );
  let feedId = candidates.find((f) => feedKey(f.url) === key)?.id;
  if (feedId === undefined) {
    const { rows } = await query<{ id: number }>(
      `INSERT INTO feeds (url) VALUES ($1)
       ON CONFLICT (url) DO UPDATE SET url = EXCLUDED.url
       RETURNING id`,
      [normalized],
    );
    feedId = rows[0].id;
  }
  await query(
    `INSERT INTO subscriptions (user_id, feed_id, board_id) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, feed_id) DO UPDATE SET board_id = coalesce(EXCLUDED.board_id, subscriptions.board_id)`,
    [userId, feedId, boardId],
  );
  return feedId;
}

export type ImportSkipReason = 'already subscribed' | 'duplicate in file';

export interface ImportResult {
  added: { id: number; url: string; title: string | null; board: string | null }[];
  skipped: { url: string; title: string | null; reason: ImportSkipReason }[];
  boardsCreated: string[];
}

/**
 * Subscribes the user to feeds from an OPML import. Feeds the user already follows, and repeats
 * within the file, are skipped (compared by feedKey, so http/https, "www." and trailing-slash
 * variants count as the same feed). OPML folders become boards, reusing boards of the same name.
 */
export async function importFeeds(userId: number, feeds: OpmlFeed[]): Promise<ImportResult> {
  const result: ImportResult = { added: [], skipped: [], boardsCreated: [] };
  const subscribed = new Set((await listFeeds(userId)).map((f) => feedKey(f.url)));
  const { rows: allFeeds } = await query<{ id: number; url: string }>('SELECT id, url FROM feeds');
  const knownFeeds = new Map(allFeeds.map((f) => [feedKey(f.url), f.id]));
  const boards = new Map((await listBoards(userId)).map((b) => [b.name.toLowerCase(), b.id]));
  const seen = new Set<string>();

  for (const feed of feeds) {
    const key = feedKey(feed.url);
    if (subscribed.has(key)) {
      result.skipped.push({ url: feed.url, title: feed.title, reason: 'already subscribed' });
      continue;
    }
    if (seen.has(key)) {
      result.skipped.push({ url: feed.url, title: feed.title, reason: 'duplicate in file' });
      continue;
    }
    seen.add(key);

    let boardId: number | null = null;
    const folder = feed.folder?.trim() || null;
    if (folder) {
      boardId = boards.get(folder.toLowerCase()) ?? null;
      if (boardId === null) {
        const board = await createBoard(userId, folder);
        boards.set(folder.toLowerCase(), board.id);
        boardId = board.id;
        result.boardsCreated.push(board.name);
      }
    }

    // Reuse a feed another subscription already created (even under a URL variant).
    let feedId = knownFeeds.get(key);
    if (feedId === undefined) {
      const { rows } = await query<{ id: number }>(
        `INSERT INTO feeds (url, title, site_url) VALUES ($1, $2, $3)
         ON CONFLICT (url) DO UPDATE SET title = coalesce(feeds.title, EXCLUDED.title)
         RETURNING id`,
        [feed.url, feed.title, feed.siteUrl],
      );
      feedId = rows[0].id;
      knownFeeds.set(key, feedId);
    }
    await query(
      `INSERT INTO subscriptions (user_id, feed_id, board_id) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, feed_id) DO NOTHING`,
      [userId, feedId, boardId],
    );
    result.added.push({ id: feedId, url: feed.url, title: feed.title, board: folder });
  }
  return result;
}

export async function setFeedBoard(userId: number, feedId: number, boardId: number | null) {
  const r = await query(
    `UPDATE subscriptions SET board_id = $3 WHERE user_id = $1 AND feed_id = $2`,
    [userId, feedId, boardId],
  );
  if (r.rowCount === 0) throw new NotFoundError('Feed not found');
}

export class ConflictError extends Error {}

/** Sets (or, with null/blank, clears) the user's own display name for a feed. */
export async function setFeedTitle(userId: number, feedId: number, title: string | null) {
  const r = await query(
    `UPDATE subscriptions SET custom_title = $3 WHERE user_id = $1 AND feed_id = $2`,
    [userId, feedId, title?.trim() || null],
  );
  if (r.rowCount === 0) throw new NotFoundError('Feed not found');
}

/**
 * Points the user's subscription at a new feed URL and returns the (possibly new) feed id.
 * - If the user already follows that feed (by feedKey), throws ConflictError.
 * - If another feed row already has that URL, the subscription moves to it.
 * - If other users follow the current feed, the subscription moves to a new feed row so their
 *   subscriptions are untouched; otherwise the feed is updated in place, keeping its items and
 *   read state.
 * The board and custom title travel with the subscription.
 */
export async function changeFeedUrl(userId: number, feedId: number, url: string): Promise<number> {
  const normalized = new URL(url).toString();
  const key = feedKey(normalized);
  const current = await getFeed(userId, feedId); // visibility check
  if (feedKey(current.url) === key && current.url === normalized) return feedId;

  const mine = (await listFeeds(userId)).find((f) => f.id !== feedId && feedKey(f.url) === key);
  if (mine) throw new ConflictError(`Already subscribed to ${mine.url} (${mine.title ?? 'untitled'})`);

  const { rows: candidates } = await query<{ id: number; url: string }>(
    'SELECT id, url FROM feeds WHERE id <> $1 AND url ILIKE $2',
    [feedId, `%${escapeLike(key.split('/')[0])}%`],
  );
  let targetId = candidates.find((f) => feedKey(f.url) === key)?.id;

  const { rows: others } = await query<{ n: number }>(
    'SELECT count(*)::int AS n FROM subscriptions WHERE feed_id = $1 AND user_id <> $2',
    [feedId, userId],
  );
  if (targetId === undefined && others[0].n === 0) {
    // Sole subscriber: update in place and clear the old fetch state.
    await query(
      `UPDATE feeds SET url = $2, last_error = NULL, last_fetched = NULL WHERE id = $1`,
      [feedId, normalized],
    );
    return feedId;
  }
  if (targetId === undefined) {
    const { rows } = await query<{ id: number }>(
      `INSERT INTO feeds (url, title) VALUES ($1, $2) RETURNING id`,
      [normalized, current.feed_title],
    );
    targetId = rows[0].id;
  }
  // Move the subscription, keeping its board and custom title.
  await query(
    `INSERT INTO subscriptions (user_id, feed_id, board_id, custom_title)
     SELECT user_id, $3, board_id, custom_title FROM subscriptions WHERE user_id = $1 AND feed_id = $2
     ON CONFLICT (user_id, feed_id) DO NOTHING`,
    [userId, feedId, targetId],
  );
  await unsubscribe(userId, feedId);
  return targetId;
}

export async function unsubscribe(userId: number, feedId: number): Promise<void> {
  const r = await query('DELETE FROM subscriptions WHERE user_id = $1 AND feed_id = $2', [
    userId,
    feedId,
  ]);
  if (r.rowCount === 0) throw new NotFoundError('Feed not found');
  // Drop feeds nobody follows any more (cascades to their items).
  await query(
    `DELETE FROM feeds f WHERE f.id = $1
       AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_id = f.id)`,
    [feedId],
  );
}

/** Feeds with at least one subscriber; these are what the ingestion worker polls. */
export async function feedsToFetch(): Promise<{ id: number; url: string }[]> {
  const { rows } = await query(
    `SELECT f.id, f.url FROM feeds f
     WHERE f.kind = 'feed' AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_id = f.id)
     ORDER BY f.last_fetched NULLS FIRST`,
  );
  return rows;
}

/** Imported-bookmark pseudo feeds have no URL to poll. */
export async function isBookmarksFeed(feedId: number): Promise<boolean> {
  const { rows } = await query('SELECT 1 FROM feeds WHERE id = $1 AND kind = $2', [feedId, 'bookmarks']);
  return rows.length > 0;
}

export async function getFeedUrl(feedId: number): Promise<string> {
  const { rows } = await query<{ url: string }>('SELECT url FROM feeds WHERE id = $1', [feedId]);
  if (!rows[0]) throw new NotFoundError('Feed not found');
  return rows[0].url;
}

/** Points a feed at a new URL (after feed discovery). Fails if another feed already uses it. */
export async function updateFeedUrl(feedId: number, url: string): Promise<void> {
  const normalized = new URL(url).toString();
  const taken = await query('SELECT 1 FROM feeds WHERE url = $1 AND id <> $2', [normalized, feedId]);
  if (taken.rowCount) {
    throw new Error(`Already subscribed to ${normalized}; remove this duplicate subscription`);
  }
  await query('UPDATE feeds SET url = $2 WHERE id = $1', [feedId, normalized]);
}

export async function recordFetch(
  feedId: number,
  meta: { title?: string | null; siteUrl?: string | null; error?: string | null },
): Promise<void> {
  const { rows } = await query<{ slug: string | null; title: string | null; url: string }>(
    'SELECT slug, title, url FROM feeds WHERE id = $1',
    [feedId],
  );
  const current = rows[0];
  if (!current) return;
  const title = meta.title?.trim() || current.title;
  let slug = current.slug;
  if (!slug && title) {
    slug = await uniqueSlug(slugify(title), async (s) => {
      const r = await query('SELECT 1 FROM feeds WHERE slug = $1 AND id <> $2', [s, feedId]);
      return r.rowCount! > 0;
    });
  }
  await query(
    `UPDATE feeds SET title = $2, slug = $3, site_url = coalesce($4, site_url),
       last_fetched = now(), last_error = $5
     WHERE id = $1`,
    [feedId, title, slug, meta.siteUrl ?? null, meta.error ?? null],
  );
}

/** Returns the subset of guids/urls already stored for a feed, so ingestion can skip them. */
export async function existingKeys(
  feedId: number,
  guids: string[],
  urls: string[],
): Promise<{ guids: Set<string>; urls: Set<string> }> {
  const { rows } = await query<{ guid: string; url: string | null }>(
    `SELECT guid, url FROM items WHERE feed_id = $1 AND (guid = ANY($2) OR url = ANY($3))`,
    [feedId, guids, urls],
  );
  return {
    guids: new Set(rows.map((r) => r.guid)),
    urls: new Set(rows.flatMap((r) => (r.url ? [r.url] : []))),
  };
}

export async function insertItems(feedId: number, items: NewItem[]): Promise<number> {
  let inserted = 0;
  for (const it of items) {
    const r = await query(
      `INSERT INTO items (feed_id, guid, url, headline, author, summary, full_content,
                          content_text, thumbnail_url, published_date)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
       WHERE NOT EXISTS (SELECT 1 FROM items WHERE feed_id = $1 AND url = $3)
       ON CONFLICT (feed_id, guid) DO NOTHING`,
      [
        feedId,
        it.guid,
        it.url,
        it.headline,
        it.author,
        it.summary,
        it.fullContent,
        it.contentText,
        it.thumbnailUrl,
        it.publishedDate,
      ],
    );
    inserted += r.rowCount ?? 0;
  }
  return inserted;
}

// ---------------------------------------------------------------- bookmarks

export interface BookmarkImportResult {
  /** Links new to the reader, saved and queued for background fetching. */
  imported: number;
  /** Links that matched an article already in the reader, which is now saved. */
  matchedExisting: number;
  /** Links that were already in the saved list. */
  alreadySaved: number;
}

/** The user's pseudo feed holding imported bookmarks, created (and subscribed to) on first use. */
async function bookmarksFeed(userId: number): Promise<number> {
  const url = `feed-reader://bookmarks/${userId}`;
  const existing = await query<{ id: number }>('SELECT id FROM feeds WHERE url = $1', [url]);
  let feedId = existing.rows[0]?.id;
  if (feedId === undefined) {
    const slug = await uniqueSlug('imported-bookmarks', async (s) => {
      const r = await query('SELECT 1 FROM feeds WHERE slug = $1', [s]);
      return r.rowCount! > 0;
    });
    const { rows } = await query<{ id: number }>(
      `INSERT INTO feeds (url, title, slug, kind) VALUES ($1, 'Imported bookmarks', $2, 'bookmarks')
       ON CONFLICT (url) DO UPDATE SET kind = 'bookmarks' RETURNING id`,
      [url, slug],
    );
    feedId = rows[0].id;
  }
  await query(
    `INSERT INTO subscriptions (user_id, feed_id) VALUES ($1, $2) ON CONFLICT (user_id, feed_id) DO NOTHING`,
    [userId, feedId],
  );
  return feedId;
}

/**
 * Saves imported bookmarks. A link matching an article the user can already see is just marked
 * saved; the rest become items in the bookmarks feed, saved and marked read (they are an archive,
 * not new reading), with their article text left to be fetched in the background. Safe to repeat.
 */
export async function importBookmarks(
  userId: number,
  bookmarks: Bookmark[],
): Promise<BookmarkImportResult> {
  const result: BookmarkImportResult = { imported: 0, matchedExisting: 0, alreadySaved: 0 };
  if (bookmarks.length === 0) return result;
  const feedId = await bookmarksFeed(userId);
  const CHUNK = 500;

  for (let i = 0; i < bookmarks.length; i += CHUNK) {
    const chunk = bookmarks.slice(i, i + CHUNK);
    const urls = chunk.map((b) => b.url);
    const { rows: known } = await query<{ id: string; url: string; is_saved: boolean }>(
      `SELECT DISTINCT ON (i.url) i.id, i.url, coalesce(ui.is_saved, false) AS is_saved ${ITEM_FROM}
        WHERE i.url = ANY($2) ORDER BY i.url, coalesce(ui.is_saved, false) DESC, i.id`,
      [userId, urls],
    );
    const knownUrls = new Set(known.map((k) => k.url));
    const toSave = known.filter((k) => !k.is_saved);
    result.alreadySaved += known.length - toSave.length;
    if (toSave.length) {
      await query(
        `INSERT INTO user_items (user_id, item_id, is_saved)
         SELECT $1, unnest($2::bigint[]), true
         ON CONFLICT (user_id, item_id) DO UPDATE SET is_saved = true, updated_at = now()`,
        [userId, toSave.map((k) => k.id)],
      );
      result.matchedExisting += toSave.length;
    }

    const fresh = chunk.filter((b) => !knownUrls.has(b.url));
    if (fresh.length === 0) continue;
    const { rowCount } = await query(
      `WITH ins AS (
         INSERT INTO items (feed_id, guid, url, headline, published_date, content_status)
         SELECT $1, t.url, t.url, coalesce(nullif(t.title, ''), t.url), t.saved_at, 'pending'
           FROM unnest($3::text[], $4::text[], $5::timestamptz[]) AS t(url, title, saved_at)
         ON CONFLICT (feed_id, guid) DO NOTHING
         RETURNING id
       )
       INSERT INTO user_items (user_id, item_id, is_read, is_saved)
       SELECT $2, id, true, true FROM ins`,
      [
        feedId,
        userId,
        fresh.map((b) => b.url),
        fresh.map((b) => b.title ?? ''),
        fresh.map((b) => b.savedAt),
      ],
    );
    result.imported += rowCount ?? 0;
  }
  return result;
}

export interface PendingBookmark {
  id: string;
  url: string;
  attempts: number;
}

/**
 * Claims the most recently saved bookmark that still needs fetching (one that failed recently
 * waits `retryAfterMinutes` before another attempt). Concurrent workers never get the same one.
 */
export async function claimPendingBookmark(retryAfterMinutes = 60): Promise<PendingBookmark | null> {
  const { rows } = await query<{ id: string; url: string; attempts: number }>(
    `UPDATE items SET content_checked_at = now()
      WHERE id = (
        SELECT id FROM items
         WHERE content_status = 'pending' AND url IS NOT NULL
           AND (content_checked_at IS NULL
                OR content_checked_at < now() - make_interval(mins => $1))
         ORDER BY published_date DESC NULLS LAST, id DESC
         LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, url, content_attempts AS attempts`,
    [retryAfterMinutes],
  );
  return rows[0] ?? null;
}

export interface BookmarkContent {
  fullContent: string | null;
  contentText: string | null;
  summary: string | null;
  author: string | null;
  thumbnailUrl: string | null;
  /** Why there is no article text, when the page was reachable but had none. */
  note: string | null;
}

export async function recordBookmarkContent(itemId: string, c: BookmarkContent): Promise<void> {
  await query(
    `UPDATE items SET content_status = 'fetched', content_error = $7, content_checked_at = now(),
       full_content = $2, content_text = $3, summary = coalesce($4, summary),
       author = coalesce(author, $5), thumbnail_url = coalesce(thumbnail_url, $6)
     WHERE id = $1`,
    [itemId, c.fullContent, c.contentText, c.summary, c.author, c.thumbnailUrl, c.note],
  );
}

/** Records a failed fetch; `dead` gives up for good, otherwise the bookmark is retried later. */
export async function recordBookmarkFailure(itemId: string, error: string, dead: boolean) {
  await query(
    `UPDATE items SET content_attempts = content_attempts + 1, content_error = $2,
       content_status = CASE WHEN $3::boolean THEN 'dead' ELSE content_status END
     WHERE id = $1`,
    [itemId, error, dead],
  );
}

export interface DeadBookmark {
  id: string;
  url: string;
  headline: string;
  error: string | null;
  saved_at: Date | null;
}

export interface BookmarkReport {
  total: number;
  pending: number;
  fetched: number;
  dead: DeadBookmark[];
}

/** Progress of the user's imported bookmarks, and the links that turned out to be dead. */
export async function bookmarkReport(userId: number): Promise<BookmarkReport> {
  const { rows } = await query<{ status: string; n: number }>(
    `SELECT i.content_status AS status, count(*)::int AS n
       FROM items i JOIN feeds f ON f.id = i.feed_id AND f.kind = 'bookmarks'
       JOIN subscriptions s ON s.feed_id = f.id AND s.user_id = $1
      GROUP BY 1`,
    [userId],
  );
  const count = (status: string) => rows.find((r) => r.status === status)?.n ?? 0;
  const { rows: dead } = await query<DeadBookmark>(
    `SELECT i.id, i.url, i.headline, i.content_error AS error, i.published_date AS saved_at
       FROM items i JOIN feeds f ON f.id = i.feed_id AND f.kind = 'bookmarks'
       JOIN subscriptions s ON s.feed_id = f.id AND s.user_id = $1
      WHERE i.content_status = 'dead'
      ORDER BY i.published_date DESC NULLS LAST, i.id DESC`,
    [userId],
  );
  return {
    total: rows.reduce((n, r) => n + r.n, 0),
    pending: count('pending'),
    fetched: count('fetched'),
    dead,
  };
}

/** Bookmarks still waiting to be fetched, across all users. */
export async function countPendingBookmarks(): Promise<number> {
  const { rows } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM items WHERE content_status = 'pending'`,
  );
  return rows[0].n;
}

// ---------------------------------------------------------------- items

export interface ListItemsOptions {
  feedId?: number;
  boardId?: number;
  status?: ReadStatus;
  saved?: boolean;
  includeContent?: boolean;
  limit?: number;
  offset?: number;
}

export async function listItems(userId: number, opts: ListItemsOptions = {}): Promise<ItemRow[]> {
  const values: unknown[] = [userId];
  const where: string[] = [];
  const param = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  if (opts.feedId !== undefined) where.push(`i.feed_id = ${param(opts.feedId)}`);
  if (opts.boardId !== undefined) where.push(boardCondition(param(opts.boardId)));
  const status = statusCondition(opts.status ?? 'all');
  if (status) where.push(status);
  if (opts.saved) where.push('coalesce(ui.is_saved, false)');
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const columns = opts.includeContent
    ? `${ITEM_COLUMNS}, i.full_content, i.content_text`
    : ITEM_COLUMNS;
  const { rows } = await query<ItemRow>(
    `SELECT ${columns} ${ITEM_FROM}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ${SORT_DATE} DESC, i.id DESC
     LIMIT ${param(limit)} OFFSET ${param(Math.max(opts.offset ?? 0, 0))}`,
    values,
  );
  return rows;
}

export async function getItem(userId: number, itemId: string): Promise<ItemRow> {
  if (!/^\d+$/.test(itemId)) throw new NotFoundError(`Item ${itemId} not found`);
  const { rows } = await query<ItemRow>(
    `SELECT ${ITEM_COLUMNS}, i.full_content, i.content_text ${ITEM_FROM} WHERE i.id = $2`,
    [userId, itemId],
  );
  if (!rows[0]) throw new NotFoundError(`Item ${itemId} not found`);
  return rows[0];
}

export interface ItemStatePatch {
  is_read?: boolean;
  is_saved?: boolean;
  board_id?: number | null;
}

export async function updateItemState(
  userId: number,
  itemId: string,
  patch: ItemStatePatch,
): Promise<ItemRow> {
  await getItem(userId, itemId); // visibility check
  await query(
    `INSERT INTO user_items (user_id, item_id, is_read, is_saved, board_id)
     VALUES ($1, $2, coalesce($3, false), coalesce($4, false), $5)
     ON CONFLICT (user_id, item_id) DO UPDATE SET
       is_read  = coalesce($3, user_items.is_read),
       is_saved = coalesce($4, user_items.is_saved),
       board_id = CASE WHEN $6 THEN $5 ELSE user_items.board_id END,
       updated_at = now()`,
    [
      userId,
      itemId,
      patch.is_read ?? null,
      patch.is_saved ?? null,
      patch.board_id ?? null,
      patch.board_id !== undefined,
    ],
  );
  return getItem(userId, itemId);
}

/** Marks the given items read; returns the ids that were visible to the user. */
export async function markItemsRead(
  userId: number,
  itemIds: string[],
  isRead = true,
): Promise<string[]> {
  const ids = itemIds.filter((id) => /^\d+$/.test(id));
  if (ids.length === 0) return [];
  const { rows } = await query<{ item_id: string }>(
    `INSERT INTO user_items (user_id, item_id, is_read)
     SELECT $1, i.id, $3 FROM items i
       JOIN subscriptions s ON s.feed_id = i.feed_id AND s.user_id = $1
      WHERE i.id = ANY($2::bigint[])
     ON CONFLICT (user_id, item_id) DO UPDATE SET is_read = $3, updated_at = now()
     RETURNING item_id`,
    [userId, ids, isRead],
  );
  return rows.map((r) => r.item_id);
}

/** Marks everything in a feed, a board, or the whole inbox as read. */
export async function markAllRead(
  userId: number,
  scope: { feedId?: number; boardId?: number },
): Promise<number> {
  const values: unknown[] = [userId];
  const where = ['NOT coalesce(ui.is_read, false)'];
  if (scope.feedId !== undefined) {
    values.push(scope.feedId);
    where.push(`i.feed_id = $${values.length}`);
  }
  if (scope.boardId !== undefined) {
    values.push(scope.boardId);
    where.push(boardCondition(`$${values.length}`));
  }
  const r = await query(
    `INSERT INTO user_items (user_id, item_id, is_read)
     SELECT $1, i.id, true ${ITEM_FROM} WHERE ${where.join(' AND ')}
     ON CONFLICT (user_id, item_id) DO UPDATE SET is_read = true, updated_at = now()`,
    values,
  );
  return r.rowCount ?? 0;
}

export interface SearchOptions {
  keyword?: string;
  feedId?: number;
  feedNames?: string[];
  boardSlug?: string;
  status?: ReadStatus;
  savedOnly?: boolean;
  sinceDays?: number;
  /** Items carrying any of these tags. */
  tags?: string[];
  /** Rank by similarity to a topic's embedding; items matching its keywords also qualify. */
  topicSlug?: string;
  /** Rank by similarity to this embedding (e.g. of a query, computed by the caller). */
  embedding?: Embedding;
  /** Drop items less similar than this (cosine similarity, -1 to 1). */
  minSimilarity?: number;
  limit?: number;
  /** Upper bound for `limit` (MCP keeps answers short; workflows can ask for more). */
  maxLimit?: number;
}

/**
 * Searches the user's items. `keyword` uses Postgres websearch syntax, so
 * `tiny LLM OR "small language model" -crypto` works. With a topic or an embedding, results
 * are ranked by similarity instead (this needs pgvector and items embedded by an enricher with
 * the same model). Without either, the most recent matching items are returned.
 */
export async function searchItems(userId: number, opts: SearchOptions): Promise<ItemRow[]> {
  const values: unknown[] = [userId];
  const param = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const where: string[] = [];
  const joins: string[] = [];
  const order: string[] = [];
  let similarity = 'NULL::float8';

  if (opts.topicSlug !== undefined || opts.embedding !== undefined) {
    if (opts.topicSlug !== undefined && opts.embedding !== undefined) {
      throw new InvalidInputError('Search by a topic or an embedding, not both');
    }
    if (opts.embedding) {
      await requireVectors();
      const v = `${param(vectorLiteral(opts.embedding))}::vector`;
      joins.push(
        `JOIN item_embeddings ee ON ee.item_id = i.id AND ee.model = ${param(opts.embedding.model.trim())}
           AND vector_dims(ee.embedding) = vector_dims(${v})`,
      );
      similarity = `1 - (ee.embedding <=> ${v})`;
    } else {
      similarity = await topicSimilarity(userId, opts.topicSlug!, param, joins, where);
    }
    if (opts.minSimilarity !== undefined) {
      where.push(`(${similarity} >= ${param(opts.minSimilarity)} OR ${similarity} IS NULL)`);
    }
    order.push(`${similarity} DESC NULLS LAST`);
  }

  const keyword = opts.keyword?.trim();
  if (keyword) {
    const q = `websearch_to_tsquery('english', ${param(keyword)})`;
    where.push(`i.search @@ ${q}`);
    order.push(`ts_rank(i.search, ${q}) DESC`);
  }
  if (opts.feedId !== undefined) where.push(`i.feed_id = ${param(opts.feedId)}`);
  const names = (opts.feedNames ?? []).map((n) => n.trim()).filter(Boolean);
  if (names.length) {
    // Loose match against title, slug and URL so "Arxiv" or "r/LocalAI" find the right feed.
    const p = param(names.map((n) => `%${escapeLike(n)}%`));
    where.push(
      `(f.title ILIKE ANY(${p}) OR s.custom_title ILIKE ANY(${p}) OR f.url ILIKE ANY(${p}) OR f.slug ILIKE ANY(${p}))`,
    );
  }
  if (opts.boardSlug) {
    where.push(
      boardCondition(`(SELECT id FROM boards WHERE user_id = $1 AND slug = ${param(opts.boardSlug)})`),
    );
  }
  const tags = (opts.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tags.length) where.push(`ie.tags && ${param(tags)}::text[]`);
  const status = statusCondition(opts.status ?? 'all');
  if (status) where.push(status);
  if (opts.savedOnly) where.push('coalesce(ui.is_saved, false)');
  if (opts.sinceDays !== undefined) {
    where.push(`${SORT_DATE} >= now() - make_interval(days => ${param(opts.sinceDays)})`);
  }
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), opts.maxLimit ?? 50);
  const { rows } = await query<ItemRow>(
    `SELECT ${ITEM_COLUMNS}, ${similarity} AS similarity ${ITEM_FROM}
     ${joins.join('\n')}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ${[...order, `${SORT_DATE} DESC`, 'i.id DESC'].join(', ')}
     LIMIT ${param(limit)}`,
    values,
  );
  return rows;
}

/**
 * Adds what a topic search needs to the query and returns the similarity expression. Items are
 * ranked by similarity to the topic's newest embedding; items matching one of its keywords count
 * too, so a topic is useful before (or without) embeddings.
 */
async function topicSimilarity(
  userId: number,
  slug: string,
  param: (v: unknown) => string,
  joins: string[],
  where: string[],
): Promise<string> {
  const { rows } = await query<{ id: number; keywords: string[] }>(
    'SELECT id, keywords FROM topics WHERE user_id = $1 AND slug = $2',
    [userId, slug],
  );
  const topic = rows[0];
  if (!topic) throw new NotFoundError(`Topic ${slug} not found`);

  const { rows: emb } = await query<{ ok: boolean }>(`SELECT to_regclass('topic_embeddings') IS NOT NULL AS ok`);
  let model: string | undefined;
  if (emb[0].ok) {
    const { rows: m } = await query<{ model: string }>(
      'SELECT model FROM topic_embeddings WHERE topic_id = $1 ORDER BY created_at DESC LIMIT 1',
      [topic.id],
    );
    model = m[0]?.model;
  }
  const keywordQuery = topic.keywords.map((k) => (/\s/.test(k) ? `"${k.replace(/"/g, '')}"` : k)).join(' OR ');
  if (!model && !keywordQuery) {
    throw new NotFoundError(`Topic ${slug} has no embedding or keywords to search with yet`);
  }

  const matches: string[] = [];
  let similarity = 'NULL::float8';
  if (model) {
    const t = param(topic.id);
    const m = param(model);
    joins.push(
      `LEFT JOIN topic_embeddings te ON te.topic_id = ${t} AND te.model = ${m}
       LEFT JOIN item_embeddings ee ON ee.item_id = i.id AND ee.model = ${m}
         AND vector_dims(ee.embedding) = vector_dims(te.embedding)`,
    );
    similarity = '1 - (ee.embedding <=> te.embedding)';
    matches.push('ee.item_id IS NOT NULL');
  }
  if (keywordQuery) {
    matches.push(`i.search @@ websearch_to_tsquery('english', ${param(keywordQuery)})`);
  }
  where.push(`(${matches.join(' OR ')})`);
  return similarity;
}

export async function ensureUser(userId: number): Promise<void> {
  await getPool().query(
    `INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [userId, `user-${userId}`],
  );
}
