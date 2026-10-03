import { describe, expect, it } from 'vitest';
import { feedKey, OpmlParseError, parseOpml } from '../src/ingest/opml.js';

const OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Subscriptions</title></head>
  <body>
    <outline text="Tech" title="Tech">
      <outline type="rss" text="Ars" title="Ars Technica" xmlUrl="https://feeds.arstechnica.com/arstechnica/index" htmlUrl="https://arstechnica.com"/>
      <outline text="Nested">
        <outline type="rss" text="Deep &amp; Nested" xmlurl="https://deep.test/feed"/>
      </outline>
    </outline>
    <outline type="rss" text="Top level" XMLURL="https://top.test/rss.xml"/>
    <outline type="rss" text="Bad" xmlUrl="ftp://bad.test/feed"/>
    <outline type="rss" text="Garbage" xmlUrl="not a url"/>
    <outline text="Just a folder with no feeds"/>
  </body>
</opml>`;

describe('parseOpml', () => {
  it('extracts feeds with titles, site URLs and their nearest folder', () => {
    const { feeds, invalid } = parseOpml(OPML);
    expect(feeds).toEqual([
      { url: 'https://feeds.arstechnica.com/arstechnica/index', title: 'Ars Technica', siteUrl: 'https://arstechnica.com/', folder: 'Tech' },
      { url: 'https://deep.test/feed', title: 'Deep & Nested', siteUrl: null, folder: 'Nested' },
      { url: 'https://top.test/rss.xml', title: 'Top level', siteUrl: null, folder: null },
    ]);
    expect(invalid).toEqual(['ftp://bad.test/feed', 'not a url']);
  });

  it('rejects files that are not OPML', () => {
    expect(() => parseOpml('<html><body>nope</body></html>')).toThrow(OpmlParseError);
    expect(() => parseOpml('this is not xml <<<')).toThrow(OpmlParseError);
  });
});

describe('feedKey', () => {
  it('treats scheme, www, host case, trailing slash and fragment variants as one feed', () => {
    const key = feedKey('https://example.com/feed');
    for (const v of ['http://example.com/feed', 'https://www.example.com/feed/', 'https://EXAMPLE.com/feed#x', 'https://example.com:443/feed']) {
      expect(feedKey(v)).toBe(key);
    }
  });

  it('keeps paths, queries and non-default ports distinct', () => {
    expect(feedKey('https://example.com/feed?tag=a')).not.toBe(feedKey('https://example.com/feed?tag=b'));
    expect(feedKey('https://example.com/feed')).not.toBe(feedKey('https://example.com/comments/feed'));
    expect(feedKey('https://example.com:8443/feed')).not.toBe(feedKey('https://example.com/feed'));
  });
});
