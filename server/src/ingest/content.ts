import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import createDOMPurify, { type DOMPurify } from 'dompurify';

function absolutize(value: string | undefined, baseUrl: string | undefined): string | undefined {
  if (!value) return value;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

// Tags and attributes kept in stored article HTML; everything else is stripped.
const ALLOWED_TAGS = [
  'address', 'article', 'aside', 'footer', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hgroup', 'main', 'nav', 'section', 'blockquote', 'dd', 'div', 'dl', 'dt', 'figcaption',
  'figure', 'hr', 'li', 'ol', 'p', 'pre', 'ul', 'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite',
  'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q', 'rb', 'rp', 'rt', 'rtc', 'ruby', 's',
  'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'caption', 'col',
  'colgroup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'img', 'picture', 'source',
  'video', 'audio',
];
const ATTRS_BY_TAG: Record<string, string[]> = {
  a: ['href', 'title'],
  img: ['src', 'srcset', 'alt', 'title', 'width', 'height'],
  source: ['src', 'srcset', 'type', 'media'],
  video: ['src', 'poster', 'controls', 'width', 'height'],
  audio: ['src', 'controls'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  code: ['class'],
};
const GLOBAL_ATTRS = ['lang', 'dir'];
const URL_ATTRS = new Set(['href', 'src', 'poster']);
// http(s) and mailto, or relative URLs (resolved against the article URL below).
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

let purifier: DOMPurify | undefined;
let currentBase: string | undefined;

/** One DOMPurify instance on a jsdom window, created on first use. */
function getPurifier(): DOMPurify {
  if (purifier) return purifier;
  const p = createDOMPurify(new JSDOM('').window as unknown as Parameters<typeof createDOMPurify>[0]);
  // Drop attributes that are allowed somewhere but not on this element.
  p.addHook('uponSanitizeAttribute', (node, data) => {
    const allowed = ATTRS_BY_TAG[node.nodeName.toLowerCase()] ?? [];
    if (!allowed.includes(data.attrName) && !GLOBAL_ATTRS.includes(data.attrName)) {
      data.keepAttr = false;
    }
  });
  // Make URLs absolute, then re-check the scheme of what they resolved to.
  p.addHook('afterSanitizeAttributes', (node) => {
    for (const attr of URL_ATTRS) {
      const value = node.getAttribute(attr);
      if (value === null) continue;
      const resolved = absolutize(value, currentBase) ?? '';
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(resolved)?.[1]?.toLowerCase();
      const ok = node.nodeName === 'A' ? ['http', 'https', 'mailto'] : ['http', 'https'];
      if (scheme && ok.includes(scheme)) node.setAttribute(attr, resolved);
      else node.removeAttribute(attr);
    }
    if (node.nodeName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (node.nodeName === 'IMG') node.setAttribute('loading', 'lazy');
  });
  purifier = p;
  return p;
}

/** Sanitizes feed/article HTML for display: no scripts, styles or event handlers; absolute URLs. */
export function sanitizeContent(html: string, baseUrl?: string): string {
  const p = getPurifier();
  currentBase = baseUrl;
  try {
    return p
      .sanitize(html, {
        ALLOWED_TAGS,
        ALLOWED_ATTR: [...new Set([...Object.values(ATTRS_BY_TAG).flat(), ...GLOBAL_ATTRS])],
        ALLOWED_URI_REGEXP,
        ALLOW_DATA_ATTR: false,
        ALLOW_ARIA_ATTR: false,
      })
      .trim();
  } finally {
    currentBase = undefined;
  }
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
