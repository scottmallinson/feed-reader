import { feedKey, type OpmlFeed } from '../ingest/opml.js';
import { escapeLike, slugify } from '../lib/slug.js';
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
  title: string | null;
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
  i.id, i.feed_id, f.title AS feed_title, i.url, i.headline, i.author, i.summary,
  i.thumbnail_url, i.published_date,
  coalesce(ui.is_read, false) AS is_read,
  coalesce(ui.is_saved, false) AS is_saved,
  ui.board_id`;

// Items the user can see: anything from a subscribed feed. `$1` is always the user id.
const ITEM_FROM = `
  FROM items i
  JOIN feeds f ON f.id = i.feed_id
  JOIN subscriptions s ON s.feed_id = i.feed_id AND s.user_id = $1
  LEFT JOIN user_items ui ON ui.item_id = i.id AND ui.user_id = $1`;

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
    `SELECT f.id, f.url, f.title, f.slug, f.site_url, f.last_fetched, f.last_error, s.board_id,
       (SELECT count(*)::int FROM items i
          LEFT JOIN user_items ui ON ui.item_id = i.id AND ui.user_id = $1
         WHERE i.feed_id = f.id AND NOT coalesce(ui.is_read, false)) AS unread_count
     FROM subscriptions s JOIN feeds f ON f.id = s.feed_id
     WHERE s.user_id = $1
     ORDER BY lower(coalesce(f.title, f.url))`,
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
     WHERE EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_id = f.id)
     ORDER BY f.last_fetched NULLS FIRST`,
  );
  return rows;
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
  limit?: number;
}

/**
 * Full-text search over the user's items. `keyword` uses Postgres websearch syntax, so
 * `tiny LLM OR "small language model" -crypto` works. Without a keyword the most recent
 * matching items are returned.
 */
export async function searchItems(userId: number, opts: SearchOptions): Promise<ItemRow[]> {
  const values: unknown[] = [userId];
  const param = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const where: string[] = [];
  let rank = '0';
  const keyword = opts.keyword?.trim();
  if (keyword) {
    const q = `websearch_to_tsquery('english', ${param(keyword)})`;
    where.push(`i.search @@ ${q}`);
    rank = `ts_rank(i.search, ${q})`;
  }
  if (opts.feedId !== undefined) where.push(`i.feed_id = ${param(opts.feedId)}`);
  const names = (opts.feedNames ?? []).map((n) => n.trim()).filter(Boolean);
  if (names.length) {
    // Loose match against title, slug and URL so "Arxiv" or "r/LocalAI" find the right feed.
    const p = param(names.map((n) => `%${escapeLike(n)}%`));
    where.push(
      `(f.title ILIKE ANY(${p}) OR f.url ILIKE ANY(${p}) OR f.slug ILIKE ANY(${p}))`,
    );
  }
  if (opts.boardSlug) {
    where.push(
      boardCondition(`(SELECT id FROM boards WHERE user_id = $1 AND slug = ${param(opts.boardSlug)})`),
    );
  }
  const status = statusCondition(opts.status ?? 'all');
  if (status) where.push(status);
  if (opts.savedOnly) where.push('coalesce(ui.is_saved, false)');
  if (opts.sinceDays !== undefined) {
    where.push(`${SORT_DATE} >= now() - make_interval(days => ${param(opts.sinceDays)})`);
  }
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const { rows } = await query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} ${ITEM_FROM}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ${rank} DESC, ${SORT_DATE} DESC, i.id DESC
     LIMIT ${param(limit)}`,
    values,
  );
  return rows;
}

export async function ensureUser(userId: number): Promise<void> {
  await getPool().query(
    `INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [userId, `user-${userId}`],
  );
}
