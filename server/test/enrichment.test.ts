import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import * as enrichment from '../src/db/enrichment.js';
import { closePool } from '../src/db/pool.js';
import * as repo from '../src/db/repo.js';
import { refreshFeed } from '../src/ingest/ingest.js';
import { createMcpServer } from '../src/mcp/server.js';
import { resetDatabase, startFixtureServer } from './helpers.js';

const USER = 1;
const MODEL = 'test-embed';
const app = createApp({ userId: USER });
let fixtures: Awaited<ReturnType<typeof startFixtureServer>>;
let tiny: string;
let protein: string;
let pi: string;

function text(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0].text;
}

beforeAll(async () => {
  await resetDatabase();
  enrichment.resetEnrichmentCache();
  fixtures = await startFixtureServer();
  await refreshFeed(await repo.subscribe(USER, `${fixtures.base}/arxiv.xml`));
  await refreshFeed(await repo.subscribe(USER, `${fixtures.base}/r/LocalAI/.rss`));
  const items = await repo.listItems(USER);
  const id = (headline: string) => items.find((i) => i.headline.startsWith(headline))!.id;
  tiny = id('TinyLM');
  protein = id('Protein');
  pi = id('Running a 1B');
});

afterAll(async () => {
  await fixtures.close();
  await closePool();
});

describe('enrichment', () => {
  it('creates the embedding tables when pgvector is available', async () => {
    expect(await enrichment.vectorsEnabled()).toBe(true);
    expect(await enrichment.enrichmentStatus(USER)).toEqual({
      vectors_enabled: true,
      items: 3,
      tagged: 0,
      embedded: {},
      topics: 0,
    });
  });

  it('lists untagged items, newest first, with their text', async () => {
    const { items, topics } = await enrichment.pendingEnrichment(USER, { textChars: 20 });
    expect(items.map((i) => i.item_id).sort()).toEqual([tiny, protein, pi].sort());
    expect(items.at(-1)!.item_id).toBe(protein); // 60 days old
    expect(items.every((i) => i.needs_tags && !i.needs_embedding)).toBe(true);
    expect(items.find((i) => i.item_id === tiny)!.text!.length).toBeLessThanOrEqual(20);
    expect(topics).toEqual([]); // topics are only reported for a model
  });

  it('stores tags, summaries and embeddings, and normalises tags', async () => {
    const result = await enrichment.saveEnrichment(USER, [
      { item_id: tiny, tags: ['AI Models', 'local ai', 'ai models'], summary: 'Small models do well.', model: 'tagger', embedding: { model: MODEL, vector: [1, 0, 0] } },
      { item_id: pi, tags: ['local-ai', 'hardware'], embedding: { model: MODEL, vector: [0.8, 0.6, 0] } },
      { item_id: protein, tags: ['science'], embedding: { model: MODEL, vector: [0, 0, 1] } },
      { item_id: '424242', tags: ['nope'] },
    ]);
    expect(result).toEqual({ updated: [tiny, pi, protein], not_found: ['424242'] });

    const item = await repo.getItem(USER, tiny);
    expect(item.tags).toEqual(['ai-models', 'local-ai']);
    expect(item.ai_summary).toBe('Small models do well.');
    expect(await enrichment.enrichmentStatus(USER)).toMatchObject({ tagged: 3, embedded: { [MODEL]: 3 } });
    expect((await enrichment.pendingEnrichment(USER, { model: MODEL })).items).toEqual([]);

    // A different model still needs embeddings, but not tags.
    const other = await enrichment.pendingEnrichment(USER, { model: 'other-model' });
    expect(other.items).toHaveLength(3);
    expect(other.items.every((i) => !i.needs_tags && i.needs_embedding)).toBe(true);
  });

  it('keeps existing tags and summary when only an embedding is sent', async () => {
    await enrichment.saveEnrichment(USER, [{ item_id: tiny, embedding: { model: 'other-model', vector: [1, 1] } }]);
    expect(await repo.getItem(USER, tiny)).toMatchObject({ tags: ['ai-models', 'local-ai'], ai_summary: 'Small models do well.' });
  });

  it('re-queues items tagged before a cut-off', async () => {
    const later = new Date(Date.now() + 60_000);
    const { items } = await enrichment.pendingEnrichment(USER, { retagBefore: later });
    expect(items).toHaveLength(3);
  });

  it('rejects malformed embeddings before writing anything', async () => {
    await expect(
      enrichment.saveEnrichment(USER, [
        { item_id: pi, tags: ['changed'] },
        { item_id: tiny, embedding: { model: MODEL, vector: [Number.NaN] } },
      ]),
    ).rejects.toThrow(enrichment.InvalidInputError);
    expect((await repo.getItem(USER, pi)).tags).toEqual(['local-ai', 'hardware']);
  });

  it('counts tags and filters searches by them', async () => {
    expect(await enrichment.listTags(USER)).toEqual([
      { tag: 'local-ai', count: 2 },
      { tag: 'ai-models', count: 1 },
      { tag: 'hardware', count: 1 },
      { tag: 'science', count: 1 },
    ]);
    expect((await enrichment.listTags(USER, 7)).map((t) => t.tag)).not.toContain('science');
    const hits = await repo.searchItems(USER, { tags: ['hardware', 'science'] });
    expect(hits.map((h) => h.id).sort()).toEqual([pi, protein].sort());
  });

  it('ranks by similarity to an embedding, within one model', async () => {
    const hits = await repo.searchItems(USER, { embedding: { model: MODEL, vector: [1, 0.1, 0] } });
    expect(hits.map((h) => h.id)).toEqual([tiny, pi, protein]);
    expect(hits[0].similarity).toBeGreaterThan(0.99);

    const close = await repo.searchItems(USER, { embedding: { model: MODEL, vector: [1, 0.1, 0] }, minSimilarity: 0.5 });
    expect(close.map((h) => h.id)).toEqual([tiny, pi]);

    // Vectors of another size, or from another model, are never compared.
    expect(await repo.searchItems(USER, { embedding: { model: MODEL, vector: [1, 0] } })).toEqual([]);
    expect(await repo.searchItems(USER, { embedding: { model: 'unknown', vector: [1, 0, 0] } })).toEqual([]);
  });
});

describe('topics', () => {
  it('matches by keyword until the topic has an embedding', async () => {
    const topic = await enrichment.upsertTopic(USER, 'Edge AI', {
      description: 'Running language models on small devices.',
      keywords: ['raspberry pi', 'on-device'],
    });
    expect(topic).toMatchObject({ slug: 'edge-ai', name: 'Edge AI', embedding_models: [] });

    const pending = await enrichment.pendingEnrichment(USER, { model: MODEL });
    expect(pending.topics).toEqual([
      { slug: 'edge-ai', name: 'Edge AI', text: 'Edge AI\n\nRunning language models on small devices.\n\nKeywords: raspberry pi, on-device' },
    ]);

    const hits = await repo.searchItems(USER, { topicSlug: 'edge-ai' });
    expect(hits.map((h) => h.id)).toEqual([pi]);
    expect(hits[0].similarity).toBeNull();
  });

  it('ranks by similarity once embedded, still including keyword matches', async () => {
    await enrichment.saveTopicEmbedding(USER, 'edge-ai', { model: MODEL, vector: [0.6, 0.8, 0] });
    expect((await enrichment.pendingEnrichment(USER, { model: MODEL })).topics).toEqual([]);

    const hits = await repo.searchItems(USER, { topicSlug: 'edge-ai' });
    expect(hits.map((h) => h.id)).toEqual([pi, tiny, protein]);
    const strict = await repo.searchItems(USER, { topicSlug: 'edge-ai', minSimilarity: 0.5 });
    expect(strict.map((h) => h.id)).toEqual([pi, tiny]);
  });

  it('forgets embeddings when the topic changes', async () => {
    const same = await enrichment.upsertTopic(USER, 'edge-ai', { description: 'Running language models on small devices.' });
    expect(same.embedding_models).toEqual([MODEL]);
    const changed = await enrichment.upsertTopic(USER, 'edge-ai', { description: 'Tiny models on phones.' });
    expect(changed.embedding_models).toEqual([]);
    expect(changed.keywords).toEqual(['raspberry pi', 'on-device']);
  });

  it('reports unknown topics', async () => {
    await expect(repo.searchItems(USER, { topicSlug: 'nope' })).rejects.toThrow(repo.NotFoundError);
    await enrichment.upsertTopic(USER, 'empty', {});
    await expect(repo.searchItems(USER, { topicSlug: 'empty' })).rejects.toThrow(/no embedding or keywords/);
    await enrichment.deleteTopic(USER, 'empty');
  });
});

describe('REST API', () => {
  it('serves pending work and accepts results', async () => {
    const pending = await request(app).get('/api/enrichment/pending').query({ model: 'api-model', limit: 2 }).expect(200);
    expect(pending.body.items).toHaveLength(2);
    expect(pending.body.topics.map((t: { slug: string }) => t.slug)).toEqual(['edge-ai']);

    await request(app)
      .post('/api/enrichment')
      .send({ items: [{ item_id: pi, embedding: { model: 'api-model', vector: [1, 2] } }] })
      .expect(200, { updated: [pi], not_found: [] });
    await request(app)
      .post('/api/enrichment')
      .send({ items: [{ item_id: pi, embedding: { model: ' ', vector: [1] } }] })
      .expect(400);
    await request(app).post('/api/enrichment').send({ items: [] }).expect(400);
  });

  it('manages topics and their embeddings', async () => {
    const put = await request(app)
      .put('/api/topics/chief')
      .send({ name: 'Chief', description: 'An AI assistant project.', keywords: ['agents'] })
      .expect(200);
    expect(put.body).toMatchObject({ slug: 'chief', name: 'Chief', keywords: ['agents'] });
    await request(app).put('/api/topics/chief/embedding').send({ model: MODEL, vector: [1, 0, 0] }).expect(200);
    const topics = await request(app).get('/api/topics').expect(200);
    expect(topics.body.find((t: { slug: string }) => t.slug === 'chief').embedding_models).toEqual([MODEL]);
    await request(app).put('/api/topics/missing/embedding').send({ model: MODEL, vector: [1] }).expect(404);
  });

  it('searches by tags, topic and embedding', async () => {
    const byTag = await request(app).get('/api/items').query({ tags: 'science,unknown' }).expect(200);
    expect(byTag.body.map((i: { id: string }) => i.id)).toEqual([protein]);

    const byTopic = await request(app).get('/api/items').query({ topic: 'chief' }).expect(200);
    expect(byTopic.body[0].id).toBe(tiny);

    const byVector = await request(app)
      .post('/api/items/search')
      .send({ embedding: { model: MODEL, vector: [0, 0, 1] }, limit: 1 })
      .expect(200);
    expect(byVector.body.map((i: { id: string }) => i.id)).toEqual([protein]);

    await request(app)
      .post('/api/items/search')
      .send({ topic: 'chief', embedding: { model: MODEL, vector: [1, 0, 0] } })
      .expect(400);
    const tags = await request(app).get('/api/tags').expect(200);
    expect(tags.body[0]).toEqual({ tag: 'local-ai', count: 2 });
    const status = await request(app).get('/api/enrichment/status').expect(200);
    expect(status.body).toMatchObject({ vectors_enabled: true, tagged: 3, topics: 2 });
  });
});

describe('MCP', () => {
  let client: Client;

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createMcpServer(USER).connect(serverTransport);
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  it('lists tags and topics', async () => {
    const tags = JSON.parse(text(await client.callTool({ name: 'list_tags', arguments: {} })));
    expect(tags.tags[0]).toEqual({ tag: 'local-ai', count: 2 });
    const topics = JSON.parse(text(await client.callTool({ name: 'list_topics', arguments: {} })));
    expect(topics.topics).toContainEqual(
      expect.objectContaining({ slug: 'chief', name: 'Chief', ranked_by_similarity: true }),
    );
  });

  it('searches by topic and tags, returning tags and similarity', async () => {
    const byTopic = JSON.parse(text(await client.callTool({ name: 'search_feed_items', arguments: { topic: 'chief', limit: 1 } })));
    expect(byTopic.items[0]).toMatchObject({ item_id: tiny, tags: ['ai-models', 'local-ai'], ai_summary: 'Small models do well.', similarity: 1 });
    const byTag = JSON.parse(text(await client.callTool({ name: 'search_feed_items', arguments: { tags: 'hardware' } })));
    expect(byTag.items.map((i: { item_id: string }) => i.item_id)).toEqual([pi]);
    const missing = await client.callTool({ name: 'search_feed_items', arguments: { topic: 'nope' } });
    expect(missing.isError).toBe(true);
  });
});
