import { slugify } from '../lib/slug.js';
import { NotFoundError } from './repo.js';
import { getPool, query } from './pool.js';

/** Thrown when a request needs embeddings but the database has no pgvector. */
export class FeatureUnavailableError extends Error {}

/** Thrown for malformed enrichment input (an empty model name, a bad vector). */
export class InvalidInputError extends Error {}

export interface Embedding {
  model: string;
  vector: number[];
}

let vectors: Promise<boolean> | undefined;

/** Whether the pgvector tables exist (migration 004 creates them only when the extension is available). */
export function vectorsEnabled(): Promise<boolean> {
  vectors ??= query<{ ok: boolean }>(`SELECT to_regclass('item_embeddings') IS NOT NULL AS ok`)
    .then((r) => r.rows[0].ok)
    .catch((err) => {
      vectors = undefined;
      throw err;
    });
  return vectors;
}

/** Tests drop and recreate the schema; forget what we learned about it. */
export function resetEnrichmentCache() {
  vectors = undefined;
}

export async function requireVectors(): Promise<void> {
  if (!(await vectorsEnabled())) {
    throw new FeatureUnavailableError(
      'Embeddings need the pgvector extension, which this database does not have',
    );
  }
}

const MAX_DIMENSIONS = 16000; // pgvector's limit

/** Validates an embedding and renders it in pgvector's text format. */
export function vectorLiteral(e: Embedding): string {
  if (!e.model?.trim()) throw new InvalidInputError('Embedding model is required');
  if (!Array.isArray(e.vector) || e.vector.length === 0 || e.vector.length > MAX_DIMENSIONS) {
    throw new InvalidInputError(`Embedding must have 1-${MAX_DIMENSIONS} dimensions`);
  }
  if (!e.vector.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new InvalidInputError('Embedding values must be finite numbers');
  }
  return JSON.stringify(e.vector);
}

/** Lower-cases, trims, de-duplicates and bounds a tag list. */
export function normalizeTags(tags: string[]): string[] {
  const out = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 64);
    if (tag) out.add(tag);
    if (out.size >= 32) break;
  }
  return [...out];
}

// Items the user can see (from a subscribed feed). `$1` is the user id.
const VISIBLE = `
  FROM items i
  JOIN feeds f ON f.id = i.feed_id
  JOIN subscriptions s ON s.feed_id = i.feed_id AND s.user_id = $1`;

// ---------------------------------------------------------------- pending work

export interface PendingItem {
  item_id: string;
  headline: string;
  summary: string | null;
  text: string | null;
  feed: string | null;
  url: string | null;
  published_date: Date | null;
  needs_tags: boolean;
  needs_embedding: boolean;
}

export interface PendingTopic {
  slug: string;
  name: string;
  /** The text to embed: name, description and keywords. */
  text: string;
}

export interface PendingOptions {
  limit?: number;
  /** Also report items and topics with no embedding from this model. */
  model?: string;
  /** Characters of article text to return per item. */
  textChars?: number;
  /** Treat items tagged before this time as untagged (to re-tag after changing the vocabulary). */
  retagBefore?: Date;
}

/**
 * Work for an enricher: the user's items that are untagged (or tagged before `retagBefore`), or
 * that lack an embedding from `model`, newest first; and topics lacking an embedding from `model`.
 */
export async function pendingEnrichment(
  userId: number,
  opts: PendingOptions = {},
): Promise<{ items: PendingItem[]; topics: PendingTopic[] }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const textChars = Math.min(Math.max(opts.textChars ?? 4000, 0), 100_000);
  const model = opts.model?.trim() || null;
  const withVectors = model !== null && (await vectorsEnabled());

  const values: unknown[] = [userId, opts.retagBefore ?? null, textChars, limit];
  const needsTags = `(ie.item_id IS NULL OR ie.enriched_at < coalesce($2::timestamptz, '-infinity'))`;
  let needsEmbedding = 'false';
  let embeddingJoin = '';
  if (withVectors) {
    values.push(model);
    embeddingJoin = `LEFT JOIN item_embeddings ee ON ee.item_id = i.id AND ee.model = $5`;
    needsEmbedding = 'ee.item_id IS NULL';
  }
  const { rows: items } = await query<PendingItem>(
    `SELECT i.id AS item_id, i.headline, i.summary, left(i.content_text, $3) AS text,
            coalesce(s.custom_title, f.title) AS feed, i.url, i.published_date,
            ${needsTags} AS needs_tags, ${needsEmbedding} AS needs_embedding
       ${VISIBLE}
       LEFT JOIN item_enrichment ie ON ie.item_id = i.id
       ${embeddingJoin}
      WHERE (i.content_status IS NULL OR i.content_status <> 'pending')
        AND (${needsTags} OR ${needsEmbedding})
      ORDER BY coalesce(i.published_date, i.created_at) DESC, i.id DESC
      LIMIT $4`,
    values,
  );

  let topics: PendingTopic[] = [];
  if (withVectors) {
    const { rows } = await query<{ slug: string; name: string; description: string; keywords: string[] }>(
      `SELECT t.slug, t.name, t.description, t.keywords FROM topics t
        WHERE t.user_id = $1
          AND NOT EXISTS (SELECT 1 FROM topic_embeddings te WHERE te.topic_id = t.id AND te.model = $2)
        ORDER BY t.slug`,
      [userId, model],
    );
    topics = rows.map((t) => ({ slug: t.slug, name: t.name, text: topicText(t) }));
  }
  return { items, topics };
}

function topicText(t: { name: string; description: string; keywords: string[] }): string {
  return [t.name, t.description, t.keywords.length ? `Keywords: ${t.keywords.join(', ')}` : '']
    .filter((s) => s.trim())
    .join('\n\n');
}

// ---------------------------------------------------------------- writing results

export interface EnrichmentInput {
  item_id: string;
  tags?: string[];
  summary?: string | null;
  /** The model that produced the tags and summary, for the record. */
  model?: string | null;
  embedding?: Embedding;
}

export interface SaveResult {
  updated: string[];
  not_found: string[];
}

/** Stores tags, summaries and embeddings for items the user can see. */
export async function saveEnrichment(userId: number, entries: EnrichmentInput[]): Promise<SaveResult> {
  const wantsVectors = entries.some((e) => e.embedding);
  if (wantsVectors) await requireVectors();
  // Validate everything before writing anything.
  const vectorsById = new Map(
    entries.flatMap((e) => (e.embedding ? [[e.item_id, vectorLiteral(e.embedding)] as const] : [])),
  );

  const ids = entries.map((e) => e.item_id).filter((id) => /^\d+$/.test(id));
  const { rows } = ids.length
    ? await query<{ id: string }>(`SELECT i.id ${VISIBLE} WHERE i.id = ANY($2::bigint[])`, [userId, ids])
    : { rows: [] };
  const visible = new Set(rows.map((r) => r.id));
  const result: SaveResult = { updated: [], not_found: [] };

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const e of entries) {
      if (!visible.has(e.item_id)) {
        result.not_found.push(e.item_id);
        continue;
      }
      if (e.tags !== undefined || e.summary !== undefined) {
        await client.query(
          `INSERT INTO item_enrichment (item_id, tags, summary, model, enriched_at)
           VALUES ($1, coalesce($2::text[], '{}'), $3, $4, now())
           ON CONFLICT (item_id) DO UPDATE SET
             tags = coalesce($2::text[], item_enrichment.tags),
             summary = CASE WHEN $5 THEN $3 ELSE item_enrichment.summary END,
             model = coalesce($4, item_enrichment.model),
             enriched_at = now()`,
          [
            e.item_id,
            e.tags === undefined ? null : normalizeTags(e.tags),
            e.summary?.trim() || null,
            e.model?.trim() || null,
            e.summary !== undefined,
          ],
        );
      }
      const vector = vectorsById.get(e.item_id);
      if (vector && e.embedding) {
        await client.query(
          `INSERT INTO item_embeddings (item_id, model, embedding) VALUES ($1, $2, $3::vector)
           ON CONFLICT (item_id, model) DO UPDATE SET embedding = EXCLUDED.embedding, created_at = now()`,
          [e.item_id, e.embedding.model.trim(), vector],
        );
      }
      result.updated.push(e.item_id);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return result;
}

// ---------------------------------------------------------------- tags

export interface TagCount {
  tag: string;
  count: number;
}

/** Tags in use on the user's items, most common first. */
export async function listTags(userId: number, sinceDays?: number): Promise<TagCount[]> {
  const { rows } = await query<TagCount>(
    `SELECT t.tag, count(*)::int AS count
       ${VISIBLE}
       JOIN item_enrichment ie ON ie.item_id = i.id
       CROSS JOIN LATERAL unnest(ie.tags) AS t(tag)
      WHERE $2::int IS NULL OR coalesce(i.published_date, i.created_at) >= now() - make_interval(days => $2::int)
      GROUP BY t.tag ORDER BY count DESC, t.tag`,
    [userId, sinceDays ?? null],
  );
  return rows;
}

// ---------------------------------------------------------------- topics

export interface Topic {
  slug: string;
  name: string;
  description: string;
  keywords: string[];
  updated_at: Date;
  /** Models that have embedded this topic's current description. */
  embedding_models: string[];
}

export interface TopicInput {
  name?: string;
  description?: string;
  keywords?: string[];
}

export async function listTopics(userId: number): Promise<Topic[]> {
  const withVectors = await vectorsEnabled();
  const models = withVectors
    ? `coalesce((SELECT array_agg(te.model ORDER BY te.model) FROM topic_embeddings te WHERE te.topic_id = t.id), '{}')`
    : `'{}'::text[]`;
  const { rows } = await query<Topic>(
    `SELECT t.slug, t.name, t.description, t.keywords, t.updated_at, ${models} AS embedding_models
       FROM topics t WHERE t.user_id = $1 ORDER BY lower(t.name)`,
    [userId],
  );
  return rows;
}

export async function getTopic(userId: number, slug: string): Promise<Topic> {
  const topic = (await listTopics(userId)).find((t) => t.slug === slug);
  if (!topic) throw new NotFoundError(`Topic ${slug} not found`);
  return topic;
}

function cleanKeywords(keywords: string[]): string[] {
  return [...new Set(keywords.map((k) => k.trim()).filter(Boolean))].slice(0, 50);
}

/**
 * Creates or updates a topic, by slug. Changing what the topic says (name, description or
 * keywords) discards its embeddings, so the enricher picks it up again.
 */
export async function upsertTopic(userId: number, slugInput: string, input: TopicInput): Promise<Topic> {
  const slug = slugify(slugInput);
  const { rows: existing } = await query<{ id: number; name: string; description: string; keywords: string[] }>(
    'SELECT id, name, description, keywords FROM topics WHERE user_id = $1 AND slug = $2',
    [userId, slug],
  );
  const current = existing[0];
  const next = {
    name: input.name?.trim() || current?.name || slugInput.trim(),
    description: input.description?.trim() ?? current?.description ?? '',
    keywords: input.keywords ? cleanKeywords(input.keywords) : (current?.keywords ?? []),
  };
  if (!current) {
    await query(
      `INSERT INTO topics (user_id, slug, name, description, keywords) VALUES ($1, $2, $3, $4, $5)`,
      [userId, slug, next.name, next.description, next.keywords],
    );
    return getTopic(userId, slug);
  }
  const changed =
    next.name !== current.name ||
    next.description !== current.description ||
    next.keywords.join('\n') !== current.keywords.join('\n');
  if (changed) {
    await query(
      `UPDATE topics SET name = $2, description = $3, keywords = $4, updated_at = now() WHERE id = $1`,
      [current.id, next.name, next.description, next.keywords],
    );
    if (await vectorsEnabled()) await query('DELETE FROM topic_embeddings WHERE topic_id = $1', [current.id]);
  }
  return getTopic(userId, slug);
}

export async function deleteTopic(userId: number, slug: string): Promise<void> {
  const r = await query('DELETE FROM topics WHERE user_id = $1 AND slug = $2', [userId, slug]);
  if (r.rowCount === 0) throw new NotFoundError(`Topic ${slug} not found`);
}

export async function saveTopicEmbedding(userId: number, slug: string, embedding: Embedding): Promise<Topic> {
  await requireVectors();
  const vector = vectorLiteral(embedding);
  const { rows } = await query<{ id: number }>('SELECT id FROM topics WHERE user_id = $1 AND slug = $2', [
    userId,
    slug,
  ]);
  if (!rows[0]) throw new NotFoundError(`Topic ${slug} not found`);
  await query(
    `INSERT INTO topic_embeddings (topic_id, model, embedding) VALUES ($1, $2, $3::vector)
     ON CONFLICT (topic_id, model) DO UPDATE SET embedding = EXCLUDED.embedding, created_at = now()`,
    [rows[0].id, embedding.model.trim(), vector],
  );
  return getTopic(userId, slug);
}

// ---------------------------------------------------------------- status

export interface EnrichmentStatus {
  vectors_enabled: boolean;
  items: number;
  tagged: number;
  /** Items with an embedding, per model. */
  embedded: Record<string, number>;
  topics: number;
}

export async function enrichmentStatus(userId: number): Promise<EnrichmentStatus> {
  const withVectors = await vectorsEnabled();
  const { rows } = await query<{ items: number; tagged: number }>(
    `SELECT count(*)::int AS items, count(ie.item_id)::int AS tagged
       ${VISIBLE} LEFT JOIN item_enrichment ie ON ie.item_id = i.id`,
    [userId],
  );
  const embedded: Record<string, number> = {};
  if (withVectors) {
    const { rows: perModel } = await query<{ model: string; n: number }>(
      `SELECT ee.model, count(*)::int AS n ${VISIBLE}
         JOIN item_embeddings ee ON ee.item_id = i.id GROUP BY ee.model ORDER BY ee.model`,
      [userId],
    );
    for (const r of perModel) embedded[r.model] = r.n;
  }
  const { rows: t } = await query<{ n: number }>('SELECT count(*)::int AS n FROM topics WHERE user_id = $1', [
    userId,
  ]);
  return { vectors_enabled: withVectors, ...rows[0], embedded, topics: t[0].n };
}
