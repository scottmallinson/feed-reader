import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { excerpt, extractArticle, htmlToText, sanitizeContent } from '../src/ingest/content.js';
import { normalizeItem, parseFeed } from '../src/ingest/ingest.js';

describe('sanitizeContent', () => {
  it('strips scripts and handlers and absolutizes URLs', () => {
    const html = sanitizeContent(
      '<p onclick="x()">Hi <a href="/a">link</a><img src="img.png"></p><script>alert(1)</script>',
      'https://example.com/posts/1',
    );
    expect(html).not.toContain('script');
    expect(html).not.toContain('onclick');
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('src="https://example.com/posts/img.png"');
  });

  it('drops javascript: links', () => {
    expect(sanitizeContent('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript');
  });

  it.each([
    ['svg onload', '<svg onload="alert(1)"><circle /></svg>'],
    ['svg animate URI', '<svg><a><animate attributeName="href" values="javascript:alert(1)" /></a></svg>'],
    ['iframe', '<iframe src="https://evil.test"></iframe>'],
    ['style element', '<style>body{background:url(javascript:alert(1))}</style>'],
    ['inline style', '<p style="background:url(javascript:alert(1))">x</p>'],
    ['form action', '<form action="javascript:alert(1)"><button formaction="javascript:alert(1)">x</button></form>'],
    ['img onerror', '<img src="x" onerror="alert(1)">'],
    ['img javascript src', '<img src="javascript:alert(1)">'],
    ['img data URI', '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">'],
    ['video poster', '<video poster="javascript:alert(1)"></video>'],
    ['textarea mutation', '<textarea/><img src=x onerror=alert(1)></textarea/>'],
    ['entity-encoded scheme', '<a href="jav&#x09;ascript:alert(1)">x</a>'],
    ['object/embed', '<object data="javascript:alert(1)"></object><embed src="javascript:alert(1)">'],
  ])('neutralizes %s', (_name, html) => {
    // Inspect the parsed result: escaped text is harmless, live elements and attributes are not.
    const doc = new JSDOM(`<body>${sanitizeContent(html, 'https://example.com/')}</body>`).window.document;
    expect(doc.querySelector('script, iframe, style, svg, form, button, object, embed, textarea')).toBeNull();
    for (const el of doc.body.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        expect(attr.name).not.toMatch(/^on|^style$|^formaction$|^action$/i);
        if (['href', 'src', 'poster'].includes(attr.name)) {
          expect(attr.value).toMatch(/^(https?:|mailto:)/);
        }
      }
    }
  });

  it('keeps allowed formatting and per-tag attributes only', () => {
    const out = sanitizeContent(
      '<h2 class="x" lang="en">T</h2><table><tr><td colspan="2" title="t">c</td></tr></table><a href="https://a.test" title="t" class="c">a</a>',
    );
    expect(out).toContain('<h2 lang="en">T</h2>');
    expect(out).toContain('<td colspan="2">c</td>');
    expect(out).toContain('<a href="https://a.test/" title="t" target="_blank" rel="noopener noreferrer">a</a>');
  });

  it('keeps mailto links but not mailto images', () => {
    expect(sanitizeContent('<a href="mailto:a@b.test">m</a>')).toContain('href="mailto:a@b.test"');
    expect(sanitizeContent('<img src="mailto:a@b.test">')).not.toContain('mailto');
  });
});

describe('htmlToText', () => {
  it('keeps paragraph breaks and decodes entities', () => {
    expect(htmlToText('<p>One &amp; two</p><ul><li>a</li><li>b</li></ul>')).toBe('One & two\n\n- a\n\n- b');
  });
});

describe('excerpt', () => {
  it('cuts at a word boundary', () => {
    expect(excerpt('alpha beta gamma delta', 12)).toBe('alpha beta…');
    expect(excerpt('short', 12)).toBe('short');
  });
});

describe('normalizeItem', () => {
  it('maps RSS items including media thumbnails', async () => {
    const feed = await parseFeed(`<?xml version="1.0"?>
      <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>T</title>
      <item><title> Hello
        world </title><link>/p/1</link><pubDate>Wed, 01 Oct 2026 10:00:00 GMT</pubDate>
      <media:content url="https://cdn/x.jpg" medium="image"/>
      <description>&lt;p&gt;Body text&lt;/p&gt;</description></item></channel></rss>`);
    const item = normalizeItem(feed.items[0], 'https://site.test/feed.xml');
    expect(item).toMatchObject({
      guid: 'https://site.test/p/1',
      url: 'https://site.test/p/1',
      headline: 'Hello world',
      thumbnailUrl: 'https://cdn/x.jpg',
      contentText: 'Body text',
    });
    expect(item?.publishedDate?.toISOString()).toBe('2026-10-01T10:00:00.000Z');
  });

  it('maps Atom entries', async () => {
    const feed = await parseFeed(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <title>A</title><entry><title>E</title><id>urn:1</id><link href="https://a.test/e"/>
      <updated>2026-09-30T00:00:00Z</updated><content type="html">&lt;b&gt;bold&lt;/b&gt;</content></entry></feed>`);
    const item = normalizeItem(feed.items[0], 'https://a.test/atom');
    expect(item).toMatchObject({ guid: 'urn:1', url: 'https://a.test/e', headline: 'E', contentText: 'bold' });
  });

  it('rejects items with no identity', () => {
    expect(normalizeItem({}, 'https://a.test/')).toBeNull();
  });
});

describe('extractArticle', () => {
  it('pulls the main content with Readability', () => {
    const page = `<html><head><title>T</title></head><body><nav>menu menu</nav><article>
      ${'<p>Readable paragraph with enough words to count as article content for readability. </p>'.repeat(6)}
      </article></body></html>`;
    const article = extractArticle(page, 'https://a.test/x');
    expect(article?.text).toContain('Readable paragraph');
    expect(article?.text).not.toContain('menu menu');
  });
});
