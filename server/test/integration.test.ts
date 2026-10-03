import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
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

  it('validates input and reports missing records', async () => {
    await request(app).post('/api/feeds').send({ url: 'not a url' }).expect(400);
    await request(app).get('/api/items/999999').expect(404);
    await request(app).get('/api/items/abc').expect(404);
    await request(app).patch('/api/feeds/999').send({ board_id: null }).expect(404);
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
