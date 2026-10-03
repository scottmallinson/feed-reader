function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://feeds:feeds@localhost:5432/feeds',
  /** The user whose state the API and MCP server read and write. */
  userId: int('FEED_USER_ID', 1),
  port: int('PORT', 3000),
  /** Optional shared secret; when set, the REST API and MCP HTTP endpoint require `Authorization: Bearer <token>`. */
  apiToken: process.env.API_TOKEN || undefined,
  /** Run the ingestion scheduler inside the API process. */
  ingestInProcess: bool('INGEST_IN_PROCESS', true),
  fetchCron: process.env.FETCH_CRON ?? '*/15 * * * *',
  fetchConcurrency: int('FETCH_CONCURRENCY', 4),
  fetchTimeoutMs: int('FETCH_TIMEOUT_MS', 20000),
  /** Fetch the linked page and run Readability when a feed only ships a short excerpt. */
  extractFullArticles: bool('EXTRACT_FULL_ARTICLES', true),
  /** Items whose feed content is shorter than this (in characters of text) get Readability extraction. */
  extractMinChars: int('EXTRACT_MIN_CHARS', 600),
  userAgent:
    process.env.USER_AGENT ?? 'feed-reader/0.1 (+https://github.com/scottmallinson/feed-reader)',
  mcpPort: int('MCP_PORT', 3001),
  /** Max characters of article text per item when an MCP resource concatenates a board. */
  mcpResourceItemChars: int('MCP_RESOURCE_ITEM_CHARS', 4000),
  webDistDir: process.env.WEB_DIST_DIR,
};
