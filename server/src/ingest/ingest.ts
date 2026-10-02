import Parser from 'rss-parser';
import { config } from '../config.js';
import * as repo from '../db/repo.js';
import type { NewItem } from '../db/repo.js';
import { excerpt, extractArticle, firstImage, htmlToText, sanitizeContent } from './content.js';

type MediaNode = { $?: { url?: string; medium?: string; type?: string } };

export interface RawItem {
  guid?: string;
  id?: string;
  link?: string;
  title?: string;
  creator?: string;
  author?: string;
  content?: string;
  contentSnippet?: string;
  summary?: string;
  'content:encoded'?: string;
  isoDate?: string;
  pubDate?: string;
  enclosure?: { url?: string; type?: string };
  'media:content'?: MediaNode | MediaNode[];
  'media:thumbnail'?: MediaNode | MediaNode[];
  'media:group'?: { 'media:content'?: MediaNode[]; 'media:thumbnail'?: MediaNode[] };
}

const parser: Parser<Record<string, unknown>, RawItem> = new Parser({
  customFields: {
    item: ['media:content', 'media:thumbnail', 'media:group', 'content:encoded', 'summary'],
  },
});

export async function fetchText(url: string, accept: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': config.userAgent, accept },
    redirect: 'follow',
    signal: AbortSignal.timeout(config.fetchTimeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

export async function parseFeed(xml: string) {
  return parser.parseString(xml);
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function mediaImage(raw: RawItem): string | null {
  const candidates = [
    ...asArray(raw['media:thumbnail']),
    ...asArray(raw['media:group']?.['media:thumbnail']),
    ...asArray(raw['media:content']),
    ...asArray(raw['media:group']?.['media:content']),
  ];
  for (const node of candidates) {
    const attrs = node?.$;
    if (!attrs?.url) continue;
    if (!attrs.medium && !attrs.type) return attrs.url;
    if (attrs.medium === 'image' || attrs.type?.startsWith('image/')) return attrs.url;
  }
  if (raw.enclosure?.url && raw.enclosure.type?.startsWith('image/')) return raw.enclosure.url;
  return null;
}

function parseDate(...values: (string | undefined)[]): Date | null {
  for (const v of values) {
    if (!v) continue;
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/** Maps an rss-parser item (RSS 2.0, Atom or RDF) onto our item shape. Returns null if unusable. */
export function normalizeItem(raw: RawItem, feedUrl: string): NewItem | null {
  let url: string | null = null;
  if (raw.link) {
    try {
      url = new URL(raw.link.trim(), feedUrl).toString();
    } catch {
      url = null;
    }
  }
  const guid = (raw.guid || raw.id || url || '').toString().trim();
  const html = raw['content:encoded'] || raw.content || raw.summary || '';
  const fullContent = html ? sanitizeContent(html, url ?? feedUrl) : null;
  const contentText = fullContent ? htmlToText(fullContent) : null;
  const headline =
    raw.title?.replace(/\s+/g, ' ').trim() ||
    (contentText ? excerpt(contentText, 80) : '') ||
    url ||
    '';
  if (!guid || !headline) return null;
  const snippet = raw.contentSnippet?.trim() || contentText || '';
  return {
    guid,
    url,
    headline,
    author: (raw.creator || raw.author || '').trim() || null,
    summary: snippet ? excerpt(snippet) : null,
    fullContent: fullContent || null,
    contentText: contentText || null,
    thumbnailUrl: mediaImage(raw) ?? (fullContent ? firstImage(fullContent, url ?? feedUrl) : null),
    publishedDate: parseDate(raw.isoDate, raw.pubDate),
  };
}

/**
 * When a feed only ships a teaser, fetch the article page and let Readability pull the body.
 * Failures are swallowed: the feed's own content is still a perfectly good fallback.
 */
export async function enrichWithReadability(item: NewItem): Promise<NewItem> {
  if (!config.extractFullArticles || !item.url) return item;
  if ((item.contentText?.length ?? 0) >= config.extractMinChars) return item;
  try {
    const html = await fetchText(item.url, 'text/html,application/xhtml+xml');
    const article = extractArticle(html, item.url);
    if (!article || article.text.length <= (item.contentText?.length ?? 0)) return item;
    return {
      ...item,
      fullContent: article.content,
      contentText: article.text,
      summary: article.excerpt ? excerpt(article.excerpt) : excerpt(article.text),
      author: item.author ?? article.byline,
      thumbnailUrl: item.thumbnailUrl ?? article.image,
    };
  } catch {
    return item;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface RefreshResult {
  feedId: number;
  inserted: number;
  error?: string;
}

export async function refreshFeed(feedId: number): Promise<RefreshResult> {
  const feedUrl = await repo.getFeedUrl(feedId);
  try {
    const xml = await fetchText(
      feedUrl,
      'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
    );
    const feed = await parseFeed(xml);
    const normalized = (feed.items ?? [])
      .map((raw) => normalizeItem(raw, feedUrl))
      .filter((it): it is NewItem => it !== null);

    // Deduplicate within the batch, then against what is already stored (by GUID or URL).
    const seen = new Set<string>();
    const batch = normalized.filter((it) => {
      const keys = [`g:${it.guid}`, ...(it.url ? [`u:${it.url}`] : [])];
      if (keys.some((k) => seen.has(k))) return false;
      keys.forEach((k) => seen.add(k));
      return true;
    });
    const existing = await repo.existingKeys(
      feedId,
      batch.map((it) => it.guid),
      batch.flatMap((it) => (it.url ? [it.url] : [])),
    );
    const fresh = batch.filter(
      (it) => !existing.guids.has(it.guid) && !(it.url && existing.urls.has(it.url)),
    );

    const enriched = await mapLimit(fresh, 3, enrichWithReadability);
    const inserted = await repo.insertItems(feedId, enriched);
    await repo.recordFetch(feedId, {
      title: typeof feed.title === 'string' ? feed.title : null,
      siteUrl: typeof feed.link === 'string' ? feed.link : null,
      error: null,
    });
    return { feedId, inserted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await repo.recordFetch(feedId, { error: message });
    return { feedId, inserted: 0, error: message };
  }
}

export async function refreshAll(): Promise<RefreshResult[]> {
  const feeds = await repo.feedsToFetch();
  return mapLimit(feeds, config.fetchConcurrency, (f) => refreshFeed(f.id));
}
