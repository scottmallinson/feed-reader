import { JSDOM } from 'jsdom';
import { config } from '../config.js';

const FEED_ACCEPT =
  'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, text/html;q=0.5, */*;q=0.3';

// Feed MIME types we can parse (rss-parser handles RSS, Atom and RDF; not JSON Feed).
const FEED_LINK_TYPES = new Set([
  'application/rss+xml',
  'application/atom+xml',
  'application/rdf+xml',
  'application/xml',
  'text/xml',
]);

// Tried in order when a page advertises no feed.
const COMMON_FEED_PATHS = ['/feed', '/rss', '/feed.xml', '/rss.xml', '/atom.xml', '/index.xml', '/feed/'];

export interface FetchedDocument {
  url: string;
  contentType: string;
  body: string;
}

export class NoFeedFoundError extends Error {
  constructor(url: string) {
    super(`No RSS or Atom feed found at ${url}`);
  }
}

export async function fetchDocument(url: string, accept = FEED_ACCEPT): Promise<FetchedDocument> {
  const res = await fetch(url, {
    headers: { 'user-agent': config.userAgent, accept },
    redirect: 'follow',
    signal: AbortSignal.timeout(config.fetchTimeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return {
    url: res.url || url,
    contentType: (res.headers.get('content-type') ?? '').toLowerCase(),
    body: await res.text(),
  };
}

/** True when the response is a web page rather than a feed document. */
export function isHtmlDocument(doc: Pick<FetchedDocument, 'contentType' | 'body'>): boolean {
  if (doc.contentType.includes('text/html') || doc.contentType.includes('application/xhtml')) {
    // Some servers label feeds text/html; trust the content if it opens like a feed.
    return !looksLikeFeed(doc.body);
  }
  return /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html[\s>])/i.test(doc.body);
}

function looksLikeFeed(body: string): boolean {
  const head = body.slice(0, 2048).replace(/<\?xml[\s\S]*?\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
  return /^\s*<(?:rss|feed|rdf:RDF)[\s>]/i.test(head);
}

/** Feed URLs a page advertises with <link rel="alternate" type="application/rss+xml" ...>. */
export function findFeedLinks(html: string, pageUrl: string): string[] {
  const { document } = new JSDOM(html).window;
  const urls: string[] = [];
  for (const link of document.querySelectorAll('link[href]')) {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    const type = (link.getAttribute('type') ?? '').toLowerCase().split(';')[0].trim();
    if (!rel.includes('alternate') || !FEED_LINK_TYPES.has(type)) continue;
    try {
      const url = new URL(link.getAttribute('href')!, pageUrl);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !urls.includes(url.href)) {
        urls.push(url.href);
      }
    } catch {
      // ignore malformed hrefs
    }
  }
  // Prefer RSS/Atom-typed links (already in document order), comments feeds last.
  return urls.sort((a, b) => Number(/comments/i.test(a)) - Number(/comments/i.test(b)));
}

async function isFeedAt(url: string): Promise<string | null> {
  try {
    const doc = await fetchDocument(url);
    return !isHtmlDocument(doc) && looksLikeFeed(doc.body) ? doc.url : null;
  } catch {
    return null;
  }
}

/**
 * Given a web page (already fetched), returns the URL of the feed it advertises, or the first
 * common feed path that serves one. Throws NoFeedFoundError when there is none.
 */
export async function discoverFeedFromPage(page: FetchedDocument): Promise<string> {
  for (const candidate of findFeedLinks(page.body, page.url)) {
    const found = await isFeedAt(candidate);
    if (found) return found;
  }
  const origin = new URL(page.url).origin;
  for (const path of COMMON_FEED_PATHS) {
    const found = await isFeedAt(origin + path);
    if (found) return found;
  }
  throw new NoFeedFoundError(page.url);
}

/**
 * Resolves what a user typed into a feed URL: a feed URL is returned unchanged; a web page is
 * replaced by the feed it advertises. Network errors fall through with the original URL so the
 * subscription still records the fetch error.
 */
export async function resolveFeedUrl(url: string): Promise<string> {
  let doc: FetchedDocument;
  try {
    doc = await fetchDocument(url);
  } catch {
    return url;
  }
  return isHtmlDocument(doc) ? discoverFeedFromPage(doc) : url;
}
