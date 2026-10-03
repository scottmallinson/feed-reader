-- Core schema for the feed reader.
-- Single-tenant by default, but every piece of user state is keyed by user_id.

CREATE TABLE IF NOT EXISTS users (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO users (id, name) VALUES (1, 'default') ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT max(id) FROM users), 1));

CREATE TABLE IF NOT EXISTS feeds (
  id            serial PRIMARY KEY,
  url           text NOT NULL UNIQUE,
  title         text,
  slug          text UNIQUE,
  site_url      text,
  last_fetched  timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Boards are user-defined collections ("Machine Learning", "News").
CREATE TABLE IF NOT EXISTS boards (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug)
);

-- Which feeds a user follows; a subscription can be filed under a board.
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feed_id     integer NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  board_id    integer REFERENCES boards(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, feed_id)
);

CREATE TABLE IF NOT EXISTS items (
  id              bigserial PRIMARY KEY,
  feed_id         integer NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid            text NOT NULL,
  url             text,
  headline        text NOT NULL,
  author          text,
  summary         text,           -- plain-text excerpt
  full_content    text,           -- sanitized HTML
  content_text    text,           -- plain text of full_content, for search + AI
  thumbnail_url   text,
  published_date  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  search          tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(headline, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(content_text, '')), 'C')
  ) STORED,
  UNIQUE (feed_id, guid)
);

CREATE INDEX IF NOT EXISTS items_search_idx ON items USING gin (search);
CREATE INDEX IF NOT EXISTS items_feed_published_idx ON items (feed_id, published_date DESC);
CREATE INDEX IF NOT EXISTS items_url_idx ON items (feed_id, url);

-- Per-user item state. A missing row means unread / not saved.
CREATE TABLE IF NOT EXISTS user_items (
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id     bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  is_read     boolean NOT NULL DEFAULT false,
  is_saved    boolean NOT NULL DEFAULT false,
  board_id    integer REFERENCES boards(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);

CREATE INDEX IF NOT EXISTS user_items_board_idx ON user_items (user_id, board_id) WHERE board_id IS NOT NULL;
