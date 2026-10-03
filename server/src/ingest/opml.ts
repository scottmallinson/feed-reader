import { JSDOM } from 'jsdom';

export interface OpmlFeed {
  url: string;
  title: string | null;
  siteUrl: string | null;
  /** Name of the enclosing folder outline, imported as a board. */
  folder: string | null;
}

export class OpmlParseError extends Error {}

function attr(el: Element, name: string): string | null {
  // OPML in the wild uses xmlUrl, xmlurl, XMLURL...; XML attributes are case-sensitive.
  for (const a of el.attributes) {
    if (a.name.toLowerCase() === name) return a.value.trim() || null;
  }
  return null;
}

function httpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export interface ParsedOpml {
  feeds: OpmlFeed[];
  /** Outlines that had an xmlUrl we could not use. */
  invalid: string[];
}

/** Extracts feed subscriptions from an OPML document, keeping their folder (if any). */
export function parseOpml(xml: string): ParsedOpml {
  let doc: Document;
  try {
    doc = new JSDOM(xml, { contentType: 'text/xml' }).window.document;
  } catch (err) {
    throw new OpmlParseError(`Not a valid OPML file: ${err instanceof Error ? err.message : err}`);
  }
  if (doc.documentElement?.localName.toLowerCase() !== 'opml') {
    throw new OpmlParseError('Not a valid OPML file: missing <opml> root element');
  }
  const feeds: OpmlFeed[] = [];
  const invalid: string[] = [];
  for (const outline of doc.getElementsByTagName('outline')) {
    const xmlUrl = attr(outline, 'xmlurl');
    if (!xmlUrl) continue;
    const url = httpUrl(xmlUrl);
    if (!url) {
      invalid.push(xmlUrl);
      continue;
    }
    // The nearest enclosing outline that is not itself a feed is the folder.
    let folder: string | null = null;
    for (let p = outline.parentElement; p && p.localName === 'outline'; p = p.parentElement) {
      if (!attr(p, 'xmlurl')) {
        folder = attr(p, 'text') ?? attr(p, 'title');
        break;
      }
    }
    feeds.push({
      url,
      title: attr(outline, 'title') ?? attr(outline, 'text'),
      siteUrl: httpUrl(attr(outline, 'htmlurl')),
      folder,
    });
  }
  return { feeds, invalid };
}

/**
 * Identity used to de-duplicate feeds: ignores scheme (http/https), a leading "www.", host case,
 * default ports, trailing slashes and fragments, but keeps the query string.
 */
export function feedKey(url: string): string {
  const u = new URL(url);
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '') || '/';
  return `${host}${u.port ? `:${u.port}` : ''}${path}${u.search}`;
}
