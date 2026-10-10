-- Enrichment: tags, short summaries and (optionally) embeddings, written by an external enricher
-- such as an n8n workflow calling a local model. The reader stores them and searches with them;
-- it never calls a model itself.

-- Tags and summaries describe an article's content, not a user's state, so they are per item.
CREATE TABLE IF NOT EXISTS item_enrichment (
  item_id      bigint PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  tags         text[] NOT NULL DEFAULT '{}',
  summary      text,
  model        text,
  enriched_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS item_enrichment_tags_idx ON item_enrichment USING gin (tags);

-- Topics are a user's standing interests ("home automation", a project they work on). The
-- description is free text: the enricher embeds it, and searches rank items by similarity to it.
CREATE TABLE IF NOT EXISTS topics (
  id           serial PRIMARY KEY,
  user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug         text NOT NULL,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  keywords     text[] NOT NULL DEFAULT '{}',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug)
);

-- Embeddings need the pgvector extension (Neon, Supabase and the pgvector/pgvector Docker image
-- have it). Without it everything else works and searching by similarity is unavailable.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector is not available (%); embeddings are disabled', SQLERRM;
  END;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    -- No fixed dimension, so any embedding model works; vectors are only compared within one
    -- model. A personal reader holds few enough recent items for an exact (unindexed) scan.
    EXECUTE $sql$
      CREATE TABLE IF NOT EXISTS item_embeddings (
        item_id     bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        model       text NOT NULL,
        embedding   vector NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (item_id, model)
      )
    $sql$;
    EXECUTE $sql$
      CREATE TABLE IF NOT EXISTS topic_embeddings (
        topic_id    integer NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        model       text NOT NULL,
        embedding   vector NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (topic_id, model)
      )
    $sql$;
  END IF;
END
$$;
