import { JSDOM } from 'jsdom';

export interface Bookmark {
  url: string;
  title: string | null;
  /** When the link was saved (ADD_DATE), if the export carries it. */
  savedAt: Date | null;
}

export class BookmarksParseError extends Error {}

function httpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function addDate(value: string | null): Date | null {
  const seconds = Number(value);
  if (!value || !Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface ParsedBookmarks {
  bookmarks: Bookmark[];
  /** Links that were not usable http(s) URLs. */
  invalid: string[];
  /** Links repeated within the file (only the first is kept). */
  duplicates: number;
}

/**
 * Extracts links from a Netscape bookmarks file (the format Feedly, browsers and Pocket export).
 * Folders are ignored: every link is kept, de-duplicated by URL.
 */
export function parseBookmarks(html: string): ParsedBookmarks {
  if (!/<a\s[^>]*href/i.test(html)) {
    throw new BookmarksParseError('Not a bookmarks file: no links found');
  }
  const dom = new JSDOM(html);
  const bookmarks: Bookmark[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const a of dom.window.document.querySelectorAll('a[href]')) {
    const raw = a.getAttribute('href') ?? '';
    const url = httpUrl(raw);
    if (!url) {
      invalid.push(raw);
      continue;
    }
    if (seen.has(url)) {
      duplicates++;
      continue;
    }
    seen.add(url);
    bookmarks.push({
      url,
      title: a.textContent?.replace(/\s+/g, ' ').trim() || null,
      savedAt: addDate(a.getAttribute('add_date')),
    });
  }
  dom.window.close();
  return { bookmarks, invalid, duplicates };
}
