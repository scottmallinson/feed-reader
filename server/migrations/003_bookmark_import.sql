-- Bookmark imports (e.g. a Feedly "Saved For Later" export).
-- Imported links live in a per-user pseudo feed of kind 'bookmarks' that is never polled; their
-- article text is fetched lazily in the background, most recent first.
ALTER TABLE feeds ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'feed';

-- NULL for ordinary feed items. For imported bookmarks: pending -> fetched | dead.
ALTER TABLE items ADD COLUMN IF NOT EXISTS content_status text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS content_error text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS content_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS content_checked_at timestamptz;

CREATE INDEX IF NOT EXISTS items_content_pending_idx
  ON items (published_date DESC) WHERE content_status = 'pending';
