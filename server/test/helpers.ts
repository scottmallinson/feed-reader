import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { migrate } from '../src/db/migrate.js';
import { query } from '../src/db/pool.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

export async function resetDatabase() {
  await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(() => {});
}

/** Serves the fixture feeds and article page from a local port. */
export async function startFixtureServer() {
  const recent = new Date(Date.now() - 2 * 86400_000);
  const old = new Date(Date.now() - 60 * 86400_000);
  let base = '';
  const render = (name: string) =>
    fixture(name)
      .replaceAll('{{BASE}}', base)
      .replaceAll('{{RECENT}}', name.endsWith('.xml') && name.includes('arxiv') ? recent.toUTCString() : recent.toISOString())
      .replaceAll('{{OLD}}', old.toUTCString());
  const server = http.createServer((req, res) => {
    const routes: Record<string, [string, string]> = {
      '/arxiv.xml': ['arxiv.xml', 'application/rss+xml'],
      '/r/LocalAI/.rss': ['localai.xml', 'application/atom+xml'],
      '/article/pi': ['article.html', 'text/html'],
    };
    // Inline web pages for feed autodiscovery.
    const pages: Record<string, string> = {
      '/site/': `<!doctype html><html><head><title>Site</title>
        <link rel="alternate" type="application/rss+xml" title="Comments" href="/site/comments.xml">
        <link rel="alternate" type="application/rss+xml" title="Posts" href="feed.xml">
        </head><body>Home</body></html>`,
      '/nofeed': '<!doctype html><html><head><title>Nothing</title></head><body>No feed here</body></html>',
    };
    if (req.url && pages[req.url]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(pages[req.url]);
      return;
    }
    if (req.url === '/site/feed.xml' || req.url === '/feed') {
      res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(render('arxiv.xml').replace('cs.CL updates on arXiv.org', req.url === '/feed' ? 'Root Feed' : 'Site Posts'));
      return;
    }
    const route = routes[req.url ?? ''];
    if (!route) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': route[1] }).end(render(route[0]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}
