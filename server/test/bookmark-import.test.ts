import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { closePool } from '../src/db/pool.js';
import * as repo from '../src/db/repo.js';
import { processPendingBookmarks } from '../src/ingest/bookmark-fetch.js';
import { refreshFeed } from '../src/ingest/ingest.js';
import { runIngestion } from '../src/ingest/scheduler.js';
import { resetDatabase, startFixtureServer } from './helpers.js';

const USER = 1;
let fixtures: Awaited<ReturnType<typeof startFixtureServer>>;
const fetchLog: string[] = [];
const app = createApp({ userId: USER, startBookmarkFetch: () => {} });

function exportFile(base: string): string {
  const link = (path: string, title: string, added: number) =>
    `<DT><A HREF="${path.startsWith('http') ? path : base + path}" ADD_DATE="${added}">${title}</A>`;
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>Saved in 2016</H3><DL><p>
    ${link('/gone', 'Long gone', 1_400_000_000)}
    ${link('/article/pi', 'Pi article', 1_500_000_000)}
    ${link('/flaky', 'Flaky', 1_450_000_000)}
    ${link('/doc.pdf', 'A PDF', 1_300_000_000)}
    ${link('https://arxiv.org/abs/2610.00001', 'Already in a feed', 1_460_000_000)}
  </DL><p></DL><p>`;
}

beforeAll(async () => {
  await resetDatabase();
  fixtures = await startFixtureServer();
  const feedId = await repo.subscribe(USER, `${fixtures.base}/arxiv.xml`);
  await refreshFeed(feedId);
});

afterAll(async () => {
  await fixtures.close();
  await closePool();
});

describe('bookmark import', () => {
  it('saves every link without making them unread, and queues new ones', async () => {
    const res = await request(app)
      .post('/api/bookmarks')
      .set('content-type', 'text/html')
      .send(exportFile(fixtures.base))
      .expect(200);
    expect(res.body).toMatchObject({
      imported: 4,
      matchedExisting: 1,
      alreadySaved: 0,
      duplicates: 0,
      invalid: [],
      report: { total: 4, pending: 4, fetched: 0, dead: [] },
    });

    const saved = await request(app).get('/api/items?saved=true').expect(200);
    expect(saved.body).toHaveLength(5);
    // Imported bookmarks are archive material: the unread count stays that of the real feed.
    const unread = await request(app).get('/api/items?status=unread').expect(200);
    expect(unread.body.every((i: { url: string }) => i.url.startsWith('https://arxiv.org/'))).toBe(true);
    // The pseudo feed is never polled.
    expect(await repo.feedsToFetch()).toHaveLength(1);
  });

  it('is idempotent', async () => {
    const res = await request(app)
      .post('/api/bookmarks')
      .set('content-type', 'text/html')
      .send(exportFile(fixtures.base))
      .expect(200);
    expect(res.body).toMatchObject({ imported: 0, matchedExisting: 0, alreadySaved: 5 });
  });

  it('accepts JSON { html } and rejects files without links', async () => {
    await request(app).post('/api/bookmarks').send({ html: '<p>no links</p>' }).expect(400);
    await request(app).post('/api/bookmarks').send({}).expect(400);
  });

  it('fetches most recent first, retries transient failures and reports dead links', async () => {
    const log = (m: string) => fetchLog.push(m);
    // One at a time: the newest bookmark (the Pi article) comes first.
    const first = await processPendingBookmarks({ limit: 1, log });
    expect(first).toMatchObject({ fetched: 1, dead: 0, retry: 0, remaining: 3 });
    const [pi] = await repo.searchItems(USER, { keyword: 'six tokens per second', savedOnly: true });
    expect(pi.url).toBe(`${fixtures.base}/article/pi`);
    const full = await repo.getItem(USER, pi.id);
    expect(full.content_text).toContain('six tokens per second');
    expect(full.headline).toBe('Pi article'); // the title from the export is kept

    const rest = await processPendingBookmarks({ log });
    // /gone is a 404 (dead at once), /flaky is a 503 (retry later), the PDF is fetched without text.
    expect(rest).toMatchObject({ fetched: 1, dead: 1, retry: 1, remaining: 1 });

    const report = await repo.bookmarkReport(USER);
    expect(report).toMatchObject({ total: 4, pending: 1, fetched: 2 });
    expect(report.dead).toEqual([
      expect.objectContaining({ url: `${fixtures.base}/gone`, headline: 'Long gone', error: 'HTTP 404' }),
    ]);
    // Nothing is reported as complete while the flaky link may still be retried.
    expect(fetchLog.some((m) => m.includes('import complete'))).toBe(false);
  });

  it('gives up on a link that keeps failing and reports the finished import', async () => {
    const { query } = await import('../src/db/pool.js');
    for (let attempt = 0; attempt < 2; attempt++) {
      // Skip the retry wait.
      await query(`UPDATE items SET content_checked_at = now() - interval '2 hours' WHERE content_status = 'pending'`);
      await processPendingBookmarks({ log: (m) => fetchLog.push(m) });
    }
    const report = await repo.bookmarkReport(USER);
    expect(report).toMatchObject({ pending: 0, fetched: 2 });
    expect(report.dead.map((d) => [d.url.replace(fixtures.base, ''), d.error])).toEqual([
      ['/flaky', 'HTTP 503'],
      ['/gone', 'HTTP 404'],
    ].sort());
    expect(fetchLog.some((m) => m.includes('import complete — 2 of 4 fetched, 2 dead links'))).toBe(true);
    expect(fetchLog.filter((m) => m.includes('dead (HTTP'))).toHaveLength(2);
  });

  it('serves the report over the API', async () => {
    const res = await request(app).get('/api/bookmarks/report').expect(200);
    expect(res.body).toMatchObject({ total: 4, pending: 0, fetched: 2 });
    expect(res.body.dead).toHaveLength(2);
  });
});

describe('fetching on demand and on schedule', () => {
  const links = (base: string, ...paths: string[]) =>
    `<DL>${paths.map((p, i) => `<DT><A HREF="${base}${p}" ADD_DATE="${1_600_000_000 + i}">Link ${p}</A>`).join('')}</DL>`;

  it('POST /bookmarks/fetch works through a batch and returns the report', async () => {
    await request(app)
      .post('/api/bookmarks')
      .send({ html: links(fixtures.base, '/article/pi?n=1', '/article/pi?n=2', '/gone?n=3') })
      .expect(200);
    const res = await request(app).post('/api/bookmarks/fetch').expect(200);
    expect(res.body).toMatchObject({ fetched: 2, dead: 1, retry: 0, remaining: 0 });
    expect(res.body.report).toMatchObject({ pending: 0, fetched: 4 });
    expect(res.body.report.dead.map((d: { url: string }) => d.url.replace(fixtures.base, ''))).toContain('/gone?n=3');
    // Nothing left: a further call is a cheap no-op.
    const again = await request(app).post('/api/bookmarks/fetch').expect(200);
    expect(again.body).toMatchObject({ fetched: 0, dead: 0, retry: 0, remaining: 0 });
  });

  it('the scheduled pass fetches bookmarks too', async () => {
    await request(app).post('/api/bookmarks').send({ html: links(fixtures.base, '/article/pi?n=4') }).expect(200);
    const summary = await runIngestion(() => {});
    expect(summary?.bookmarks).toMatchObject({ fetched: 1, remaining: 0 });
  });

  it('GET /cron/bookmarks fetches a batch', async () => {
    await request(app).post('/api/bookmarks').send({ html: links(fixtures.base, '/article/pi?n=5') }).expect(200);
    const res = await request(app).get('/api/cron/bookmarks').expect(200);
    expect(res.body.bookmarks).toMatchObject({ fetched: 1, remaining: 0 });
  });
});
