import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import sanitizeHtml from 'sanitize-html';

function absolutize(value: string | undefined, baseUrl: string | undefined): string | undefined {
  if (!value) return value;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

/** Sanitizes feed/article HTML for display: no scripts, styles or event handlers; absolute URLs. */
export function sanitizeContent(html: string, baseUrl?: string): string {
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'img',
      'figure',
      'figcaption',
      'picture',
      'source',
      'video',
      'audio',
      'h1',
      'h2',
      'sup',
      'sub',
    ]),
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'srcset', 'alt', 'title', 'width', 'height', 'loading'],
      source: ['src', 'srcset', 'type', 'media'],
      video: ['src', 'poster', 'controls', 'width', 'height'],
      audio: ['src', 'controls'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
      code: ['class'],
      '*': ['lang', 'dir'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'], a: ['http', 'https', 'mailto'] },
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: {
          ...attribs,
          href: absolutize(attribs.href, baseUrl) ?? '',
          target: '_blank',
          rel: 'noopener noreferrer',
        },
      }),
      img: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, src: absolutize(attribs.src, baseUrl) ?? '', loading: 'lazy' },
      }),
    },
  }).trim();
}

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION',
  'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV',
  'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL',
]);

/** Converts HTML to readable plain text, keeping paragraph breaks. Used for search and the AI. */
export function htmlToText(html: string): string {
  const fragment = JSDOM.fragment(`<div>${html}</div>`);
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
    const block = BLOCK_TAGS.has(el.tagName);
    if (block) parts.push('\n');
    if (el.tagName === 'LI') parts.push('- ');
    el.childNodes.forEach(walk);
    if (block) parts.push('\n');
  };
  fragment.childNodes.forEach(walk);
  return parts
    .join('')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A one-paragraph excerpt cut at a word boundary. */
export function excerpt(text: string, maxChars = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > maxChars * 0.6 ? lastSpace : maxChars).trimEnd()}…`;
}

export function firstImage(html: string, baseUrl?: string): string | null {
  const match = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  return match ? (absolutize(match[1], baseUrl) ?? null) : null;
}

export interface ExtractedArticle {
  title: string | null;
  content: string;
  text: string;
  excerpt: string | null;
  byline: string | null;
  image: string | null;
}

/** Runs Mozilla Readability over a fetched article page. */
export function extractArticle(html: string, url: string): ExtractedArticle | null {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const ogImage =
    doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ??
    doc.querySelector('meta[name="twitter:image"]')?.getAttribute('content') ??
    null;
  const article = new Readability(doc).parse();
  dom.window.close();
  if (!article?.content) return null;
  const content = sanitizeContent(article.content, url);
  return {
    title: article.title ?? null,
    content,
    text: htmlToText(content),
    excerpt: article.excerpt?.trim() || null,
    byline: article.byline?.trim() || null,
    image: absolutize(ogImage ?? undefined, url) ?? firstImage(content, url),
  };
}
