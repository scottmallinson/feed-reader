import { describe, expect, it } from 'vitest';
import { discoverFeedFromPage, findFeedLinks, isHtmlDocument, NoFeedFoundError } from '../src/ingest/discover.js';

describe('findFeedLinks', () => {
  it('returns advertised RSS/Atom links, resolved and with comment feeds last', () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" href="/comments/feed/">
      <link rel="alternate" type="application/atom+xml" href="atom.xml">
      <link rel="alternate" type="application/feed+json" href="/feed.json">
      <link rel="stylesheet" type="text/css" href="/style.css">
      <link rel="alternate" hreflang="es" href="/es/">
      <link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">
    </head></html>`;
    expect(findFeedLinks(html, 'https://example.com/blog/')).toEqual([
      'https://example.com/blog/atom.xml',
      'https://example.com/comments/feed/',
    ]);
  });
});

describe('isHtmlDocument', () => {
  it('tells web pages from feeds', () => {
    expect(isHtmlDocument({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html></html>' })).toBe(true);
    expect(isHtmlDocument({ contentType: '', body: '\n<!DOCTYPE html>\n<html lang="en">' })).toBe(true);
    expect(isHtmlDocument({ contentType: 'application/rss+xml', body: '<?xml version="1.0"?><rss>' })).toBe(false);
    // Mislabelled feeds are still feeds.
    expect(isHtmlDocument({ contentType: 'text/html', body: '<?xml version="1.0"?>\n<feed xmlns="http://www.w3.org/2005/Atom">' })).toBe(false);
  });
});

describe('discoverFeedFromPage', () => {
  it('throws NoFeedFoundError when nothing is advertised and no common path serves a feed', async () => {
    const page = { url: 'http://127.0.0.1:1/home', contentType: 'text/html', body: '<html><head></head></html>' };
    await expect(discoverFeedFromPage(page)).rejects.toBeInstanceOf(NoFeedFoundError);
  });
});
