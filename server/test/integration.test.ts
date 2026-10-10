import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closePool } from '../src/db/pool.js';
import * as repo from '../src/db/repo.js';
import { refreshFeed } from '../src/ingest/ingest.js';
import { createMcpServer } from '../src/mcp/server.js';
import { resetDatabase, startFixtureServer } from './helpers.js';

const USER = 1;
let fixtures: Awaited<ReturnType<typeof startFixtureServer>>;
let arxivId: number;
let localAiId: number;
let boardId: number;
const app = createApp({ userId: USER });

function text(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0].text;
}

beforeAll(async () => {
  await resetDatabase();
  fixtures = await startFixtureServer();
});

afterAll(async () => {
  await fixtures.close();
  await closePool();
});

describe('ingestion', () => {
  it('fetches, parses, sanitizes and deduplicates a feed', async () => {
    arxivId = await repo.subscribe(USER, `${fixtures.base}/arxiv.xml`);
    expect(await refreshFeed(arxivId)).toEqual({ feedId: arxivId, inserted: 2 });

    const feed = await repo.getFeed(USER, arxivId);
    expect(feed).toMatchObject({ title: 'cs.CL updates on arXiv.org', slug: 'cs-cl-updates-on-arxiv-org', unread_count: 2 });

    const [tiny] = await repo.searchItems(USER, { keyword: 'TinyLM' });
    const item = await repo.getItem(USER, tiny.id);
    expect(item.full_content).not.toMatch(/script|onclick/);
    expect(item.full_content).toContain('href="https://arxiv.org/abs/2610.00001v2"');
    expect(item.thumbnail_url).toBe('https://arxiv.org/thumb/1.png');
    expect(item.author).toBe('A. Researcher');

    // A second pass finds nothing new.
    expect(await refreshFeed(arxivId)).toEqual({ feedId: arxivId, inserted: 0 });
  });

  it('runs Readability on items that only ship a teaser', async () => {
    localAiId = await repo.subscribe(USER, `${fixtures.base}/r/LocalAI/.rss`);
    expect((await refreshFeed(localAiId)).inserted).toBe(1);
    const [row] = await repo.listItems(USER, { feedId: localAiId, includeContent: true });
    expect(row.content_text).toContain('six tokens per second');
    expect(row.content_text).not.toContain('Login');
    expect(row.thumbnail_url).toBe(`${fixtures.base}/images/pi.jpg`);
  });

  it('records fetch errors on the feed', async () => {
    const badId = await repo.subscribe(USER, `${fixtures.base}/missing.xml`);
    const result = await refreshFeed(badId);
    expect(result.error).toMatch(/HTTP 404/);
    expect((await repo.getFeed(USER, badId)).last_error).toMatch(/HTTP 404/);
    await repo.unsubscribe(USER, badId);
  });
});

describe('feed autodiscovery', () => {
  it('subscribes to the feed a web page advertises', async () => {
    const res = await request(app).post('/api/feeds').send({ url: `${fixtures.base}/site/` }).expect(201);
    expect(res.body).toMatchObject({ url: `${fixtures.base}/site/feed.xml`, title: 'Site Posts' });
    expect(res.body.refresh).toMatchObject({ inserted: 2 });
    await repo.unsubscribe(USER, res.body.id);
  });

  it('falls back to common feed paths', async () => {
    const res = await request(app).post('/api/feeds').send({ url: `${fixtures.base}/nofeed` }).expect(201);
    expect(res.body).toMatchObject({ url: `${fixtures.base}/feed`, title: 'Root Feed' });
    await repo.unsubscribe(USER, res.body.id);
  });

  it('rejects a readable web page with no feed (422) without subscribing', async () => {
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      if (req.url === '/') res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>hi</body></html>');
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const before = (await repo.listFeeds(USER)).length;
      const res = await request(app).post('/api/feeds').send({ url: `http://127.0.0.1:${port}/` }).expect(422);
      expect(res.body.error).toMatch(/No RSS or Atom feed found/);
      expect(await repo.listFeeds(USER)).toHaveLength(before);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('switches an existing web-page subscription to its feed on refresh', async () => {
    const feedId = await repo.subscribe(USER, `${fixtures.base}/site/`);
    expect(await refreshFeed(feedId)).toMatchObject({ inserted: 2 });
    expect(await repo.getFeedUrl(feedId)).toBe(`${fixtures.base}/site/feed.xml`);
    await repo.unsubscribe(USER, feedId);
  });
});

describe('REST API', () => {
  it('manages boards and files feeds under them', async () => {
    const created = await request(app).post('/api/boards').send({ name: 'AI Research' }).expect(201);
    expect(created.body).toMatchObject({ name: 'AI Research', slug: 'ai-research' });
    boardId = created.body.id;

    await request(app).patch(`/api/feeds/${arxivId}`).send({ board_id: boardId }).expect(200);
    const boards = await request(app).get('/api/boards').expect(200);
    expect(boards.body).toEqual([expect.objectContaining({ slug: 'ai-research', unread_count: 2 })]);
  });

  it('lists items with filters and updates state', async () => {
    const all = await request(app).get('/api/items').expect(200);
    expect(all.body).toHaveLength(3);
    expect(all.body[0]).not.toHaveProperty('full_content');

    const withContent = await request(app).get(`/api/items?feed_id=${localAiId}&content=true`).expect(200);
    expect(withContent.body[0].full_content).toContain('<p>');

    const id = all.body[0].id;
    const patched = await request(app).patch(`/api/items/${id}`).send({ is_saved: true, is_read: true }).expect(200);
    expect(patched.body).toMatchObject({ is_saved: true, is_read: true });

    const saved = await request(app).get('/api/items?saved=true').expect(200);
    expect(saved.body.map((i: { id: string }) => i.id)).toEqual([id]);
    const unread = await request(app).get('/api/items?status=unread').expect(200);
    expect(unread.body).toHaveLength(2);

    const search = await request(app).get('/api/items?q=protein').expect(200);
    expect(search.body).toEqual([expect.objectContaining({ headline: 'Protein folding with diffusion' })]);

    await request(app).patch(`/api/items/${id}`).send({ is_read: false }).expect(200);
  });

  it('pins individual items to a board', async () => {
    const [pi] = await repo.listItems(USER, { feedId: localAiId });
    await request(app).patch(`/api/items/${pi.id}`).send({ board_id: boardId }).expect(200);
    const board = await request(app).get(`/api/items?board_id=${boardId}`).expect(200);
    expect(board.body).toHaveLength(3);
    await request(app).patch(`/api/items/${pi.id}`).send({ board_id: null }).expect(200);
  });

  it('still subscribes to an unreachable address, recording the fetch error', async () => {
    const res = await request(app).post('/api/feeds').send({ url: 'http://127.0.0.1:1/nothing' });
    expect(res.status).toBe(201);
    expect(res.body.refresh.error).toBeTruthy();
    await repo.unsubscribe(USER, res.body.id);
  });

  it('validates input and reports missing records', async () => {
    await request(app).post('/api/feeds').send({ url: 'not a url' }).expect(400);
    await request(app).get('/api/items/999999').expect(404);
    await request(app).get('/api/items/abc').expect(404);
    await request(app).patch('/api/feeds/999').send({ board_id: null }).expect(404);
  });
});

describe('OPML import', () => {
  const opml = (body: string) => `<?xml version="1.0"?><opml version="2.0"><head/><body>${body}</body></opml>`;

  it('imports new feeds, skips ones already followed and duplicates, and maps folders to boards', async () => {
    const before = await repo.listFeeds(USER);
    const followed = before.find((f) => f.url.endsWith('/arxiv.xml'))!;
    // Same feed as an existing subscription, written differently (scheme/www/trailing slash).
    const variant = followed.url.replace('http://', 'https://') + '/';
    const xml = opml(`
      <outline text="Imported Board">
        <outline type="rss" text="Zeta Feed" xmlUrl="https://zeta.test/feed"/>
        <outline type="rss" text="Alpha Feed" xmlUrl="https://alpha.test/rss"/>
      </outline>
      <outline type="rss" text="AI research dup board" xmlUrl="https://beta.test/atom.xml"/>
      <outline type="rss" text="Already" xmlUrl="${variant}"/>
      <outline type="rss" text="Alpha again" xmlUrl="http://www.alpha.test/rss/"/>
      <outline type="rss" text="Bad" xmlUrl="javascript:alert(1)"/>`);

    const cleanup = async () => {
      for (const f of await repo.listFeeds(USER)) {
        if (!before.some((b) => b.id === f.id)) await repo.unsubscribe(USER, f.id);
      }
      const created = (await repo.listBoards(USER)).find((b) => b.name === 'Imported Board');
      if (created) await repo.deleteBoard(USER, created.id);
    };
    try {
    const res = await request(app).post('/api/opml').send({ opml: xml }).expect(200);
    expect(res.body.added.map((a: { url: string }) => a.url)).toEqual([
      'https://zeta.test/feed',
      'https://alpha.test/rss',
      'https://beta.test/atom.xml',
    ]);
    expect(res.body.skipped).toEqual([
      { url: variant, title: 'Already', reason: 'already subscribed' },
      { url: 'http://www.alpha.test/rss/', title: 'Alpha again', reason: 'duplicate in file' },
    ]);
    expect(res.body.boardsCreated).toEqual(['Imported Board']);
    expect(res.body.invalid).toEqual(['javascript:alert(1)']);

    // Titles from the OPML show until the first fetch, and the list is alphabetical.
    const after = await repo.listFeeds(USER);
    expect(after).toHaveLength(before.length + 3);
    const names = after.map((f) => f.title ?? f.url);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
    const board = (await repo.listBoards(USER)).find((b) => b.name === 'Imported Board')!;
    expect(after.filter((f) => f.board_id === board.id).map((f) => f.title)).toEqual(['Alpha Feed', 'Zeta Feed']);

    // Re-importing the same file adds nothing.
    const again = await request(app).post('/api/opml').set('content-type', 'text/x-opml').send(xml).expect(200);
    expect(again.body.added).toEqual([]);
    expect(again.body.skipped.every((s: { reason: string }) => s.reason === 'already subscribed')).toBe(true);
    expect(again.body.skipped).toHaveLength(5);
    expect(again.body.boardsCreated).toEqual([]);

    } finally {
      await cleanup();
    }
  });

  it('reuses an existing board with the same name (case-insensitive)', async () => {
    const res = await request(app)
      .post('/api/opml')
      .send({ opml: opml('<outline text="ai research"><outline xmlUrl="https://gamma.test/feed" text="Gamma"/></outline>') })
      .expect(200);
    expect(res.body.boardsCreated).toEqual([]);
    const gamma = (await repo.listFeeds(USER)).find((f) => f.url === 'https://gamma.test/feed')!;
    expect(gamma.board_id).toBe(boardId);
    await repo.unsubscribe(USER, gamma.id);
  });

  it('rejects malformed OPML with 400', async () => {
    const res = await request(app).post('/api/opml').set('content-type', 'text/xml').send('<html>no</html>').expect(400);
    expect(res.body.error).toMatch(/Not a valid OPML file/);
    await request(app).post('/api/opml').send({}).expect(400);
  });

  it('does not create a second feed when following a URL variant of an existing one', async () => {
    const before = await repo.listFeeds(USER);
    const followed = before.find((f) => f.url.endsWith('/arxiv.xml'))!;
    const id = await repo.subscribe(USER, followed.url + '/');
    expect(id).toBe(followed.id);
    expect(await repo.listFeeds(USER)).toHaveLength(before.length);
  });
});

describe('editing feeds', () => {
  it('fixes an outdated feed address in place, keeping the subscription', async () => {
    const id = await repo.subscribe(USER, `${fixtures.base}/gone/feed.xml`, boardId);
    expect((await refreshFeed(id)).error).toMatch(/HTTP 404/);

    const res = await request(app).patch(`/api/feeds/${id}`).send({ url: `${fixtures.base}/site/feed.xml` }).expect(200);
    expect(res.body).toMatchObject({ id, url: `${fixtures.base}/site/feed.xml`, last_error: null, board_id: boardId });
    expect(res.body.refresh).toMatchObject({ inserted: 2 });
    expect(res.body.refresh.error).toBeUndefined();
    await repo.unsubscribe(USER, id);
  });

  it('accepts a website address and uses the feed it advertises', async () => {
    const id = await repo.subscribe(USER, `${fixtures.base}/gone/feed.xml`);
    const res = await request(app).patch(`/api/feeds/${id}`).send({ url: `${fixtures.base}/site/` }).expect(200);
    expect(res.body.url).toBe(`${fixtures.base}/site/feed.xml`);
    await repo.unsubscribe(USER, id);
  });

  it('refuses an address the user already follows (409), including URL variants', async () => {
    const id = await repo.subscribe(USER, `${fixtures.base}/gone/feed.xml`);
    const arxiv = (await repo.listFeeds(USER)).find((f) => f.url.endsWith('/arxiv.xml'))!;
    const res = await request(app).patch(`/api/feeds/${id}`).send({ url: `${arxiv.url}/` }).expect(409);
    expect(res.body.error).toMatch(/Already subscribed/);
    expect(await repo.getFeedUrl(id)).toBe(`${fixtures.base}/gone/feed.xml`);
    await repo.unsubscribe(USER, id);
  });

  it('moves only this user to the new address when the feed is shared', async () => {
    const OTHER = 2;
    await repo.ensureUser(OTHER);
    const id = await repo.subscribe(USER, `${fixtures.base}/gone/feed.xml`, boardId);
    expect(await repo.subscribe(OTHER, `${fixtures.base}/gone/feed.xml`)).toBe(id);
    await repo.setFeedTitle(USER, id, 'My name');

    const res = await request(app).patch(`/api/feeds/${id}`).send({ url: `${fixtures.base}/feed` }).expect(200);
    expect(res.body.id).not.toBe(id);
    expect(res.body).toMatchObject({ url: `${fixtures.base}/feed`, board_id: boardId, title: 'My name' });
    expect((await repo.listFeeds(USER)).some((f) => f.id === id)).toBe(false);
    // The other user still follows the old address, untouched.
    expect((await repo.listFeeds(OTHER)).map((f) => [f.id, f.url])).toEqual([[id, `${fixtures.base}/gone/feed.xml`]]);

    await repo.unsubscribe(USER, res.body.id);
    await repo.unsubscribe(OTHER, id);
  });

  it('renames a feed; the custom name survives refreshes and can be cleared', async () => {
    const arxiv = (await repo.listFeeds(USER)).find((f) => f.url.endsWith('/arxiv.xml'))!;
    const res = await request(app).patch(`/api/feeds/${arxiv.id}`).send({ title: '  Papers  ' }).expect(200);
    expect(res.body).toMatchObject({ title: 'Papers', custom_title: 'Papers', feed_title: 'cs.CL updates on arXiv.org' });
    expect(res.body.refresh).toBeUndefined();

    await refreshFeed(arxiv.id);
    expect((await repo.getFeed(USER, arxiv.id)).title).toBe('Papers');
    const [item] = await repo.listItems(USER, { feedId: arxiv.id, limit: 1 });
    expect(item.feed_title).toBe('Papers');
    expect(await repo.searchItems(USER, { feedNames: ['Papers'] })).not.toHaveLength(0);

    const cleared = await request(app).patch(`/api/feeds/${arxiv.id}`).send({ title: null }).expect(200);
    expect(cleared.body).toMatchObject({ title: 'cs.CL updates on arXiv.org', custom_title: null });
  });

  it('validates edits', async () => {
    const arxiv = (await repo.listFeeds(USER)).find((f) => f.url.endsWith('/arxiv.xml'))!;
    await request(app).patch(`/api/feeds/${arxiv.id}`).send({}).expect(400);
    await request(app).patch(`/api/feeds/${arxiv.id}`).send({ url: 'not a url' }).expect(400);
    await request(app).patch('/api/feeds/99999').send({ title: 'x' }).expect(404);
    // Setting the same URL is a no-op.
    const same = await request(app).patch(`/api/feeds/${arxiv.id}`).send({ url: arxiv.url }).expect(200);
    expect(same.body.id).toBe(arxiv.id);
  });
});

describe('deployment hardening', () => {
  it('re-running migrations is a no-op', async () => {
    const logs: string[] = [];
    await Promise.all([migrate((m) => logs.push(m)), migrate((m) => logs.push(m))]);
    expect(logs).toEqual([]);
  });

  it('protects the cron endpoint with CRON_SECRET or the API token', async () => {
    const saved = { ...config };
    try {
      config.cronSecret = 'cron-s3cret';
      config.apiToken = 'api-t0ken';
      await request(app).get('/api/cron/refresh').expect(401);
      await request(app).get('/api/cron/refresh').set('authorization', 'Bearer wrong').expect(401);
      const viaCron = await request(app)
        .get('/api/cron/refresh')
        .set('authorization', 'Bearer cron-s3cret')
        .expect(200);
      expect(viaCron.body.summary).toMatchObject({ feeds: 2, errors: 0 });
      await request(app).get('/api/cron/refresh').set('authorization', 'Bearer api-t0ken').expect(200);
      // The cron secret is not an API credential.
      await request(app).get('/api/feeds').set('authorization', 'Bearer cron-s3cret').expect(401);
    } finally {
      Object.assign(config, saved);
    }
  });

  it('refuses API and MCP requests on Vercel when no API token is configured', async () => {
    const saved = { ...config };
    try {
      config.onVercel = true;
      config.apiToken = undefined;
      config.cronSecret = undefined;
      await request(app).get('/api/feeds').expect(503);
      await request(app).post('/mcp').send({}).expect(503);
      await request(app).get('/api/cron/refresh').expect(401);
      await request(app).get('/healthz').expect(200);
    } finally {
      Object.assign(config, saved);
    }
  });

  it('awaits a full refresh from the API', async () => {
    const res = await request(app).post('/api/refresh').expect(200);
    expect(res.body.summary).toMatchObject({ feeds: 2, inserted: 0, errors: 0 });
  });
});

describe('MCP server', () => {
  let client: Client;

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createMcpServer(USER).connect(serverTransport);
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterAll(() => client.close());

  it('exposes the reader tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_full_article',
      'list_feeds',
      'list_tags',
      'list_topics',
      'mark_as_read',
      'search_feed_items',
    ]);
  });

  it('runs the search → read → mark-read workflow', async () => {
    const search = await client.callTool({
      name: 'search_feed_items',
      arguments: {
        keyword: 'tiny LLM OR "small language model"',
        feed_name: ['Arxiv', 'r/LocalAI'],
        since_days: 7,
        status: 'unread',
      },
    });
    const found = JSON.parse(text(search));
    expect(found.items.map((i: { headline: string }) => i.headline).sort()).toEqual([
      'Running a 1B model on a Raspberry Pi',
      'TinyLM: Small Language Models That Punch Above Their Weight',
    ]);

    const old = JSON.parse(text(await client.callTool({ name: 'search_feed_items', arguments: { keyword: 'protein', since_days: 7 } })));
    expect(old.count).toBe(0);

    const ids = found.items.map((i: { item_id: string }) => i.item_id);
    const article = await client.callTool({ name: 'get_full_article', arguments: { item_id: ids[0] } });
    expect(text(article)).toMatch(/^# /);
    expect(text(article)).toContain(`item_id: ${ids[0]}`);

    const marked = JSON.parse(text(await client.callTool({ name: 'mark_as_read', arguments: { item_id: [...ids, '424242'] } })));
    expect(marked.updated.sort()).toEqual([...ids].sort());
    expect(marked.not_found).toEqual(['424242']);

    const after = JSON.parse(text(await client.callTool({ name: 'search_feed_items', arguments: { keyword: 'tiny LLM', status: 'unread' } })));
    expect(after.count).toBe(0);

    await repo.markItemsRead(USER, ids, false);
  });

  it('lists the newest items when search_feed_items has no keyword', async () => {
    const result = await client.callTool({ name: 'search_feed_items', arguments: { feed_name: 'arxiv', limit: 5 } });
    expect(result.isError).toBeFalsy();
    const listing = JSON.parse(text(result));
    expect(listing.count).toBeGreaterThan(0);
    const dates = listing.items.map((i: { published_date: string | null }) => i.published_date ?? '');
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('returns a tool error for unknown articles', async () => {
    const result = await client.callTool({ name: 'get_full_article', arguments: { item_id: '999999' } });
    expect(result.isError).toBe(true);
  });

  it('serves boards and subscriptions as resources', async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain('feed://boards/ai-research');
    expect(uris).toContain('feed://subscriptions/cs-cl-updates-on-arxiv-org');
    expect(uris).toContain('feed://subscriptions/localai');

    const board = await client.readResource({ uri: 'feed://boards/ai-research' });
    const body = (board.contents[0] as { text: string }).text;
    expect(body).toContain('# Board: AI Research');
    expect(body).toContain('TinyLM');
    expect(body).toContain('Protein folding');

    await expect(client.readResource({ uri: 'feed://boards/nope' })).rejects.toThrow(/Unknown board/);
  });

  it('is reachable over stateless Streamable HTTP', async () => {
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    const http = new Client({ name: 'http-test', version: '1.0.0' });
    try {
      await http.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      const result = await http.callTool({ name: 'list_feeds', arguments: {} });
      const listing = JSON.parse(text(result));
      expect(listing.boards[0].resource).toBe('feed://boards/ai-research');
      expect(listing.feeds).toHaveLength(2);
    } finally {
      await http.close();
      await new Promise((r) => server.close(r));
    }
  });
});
