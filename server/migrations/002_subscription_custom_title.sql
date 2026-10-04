-- A user's own display name for a feed; overrides the title the feed publishes.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS custom_title text;
