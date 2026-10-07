# Feed Reader

An RSS/Atom reader (Feedly-style boards, read/saved state, three display modes, sharing) with a
built-in [Model Context Protocol](https://modelcontextprotocol.io) server, so Claude Desktop or
any MCP client can search, read and triage your feeds. Run it on your own machine or server, or
deploy it to Vercel with a free Neon Postgres database.

```
┌──────────────┐  REST /api   ┌──────────────────────────┐        ┌────────────┐
│ Web UI       │ ───────────▶ │ API + ingestion scheduler│ ─────▶ │ PostgreSQL │
│ (React/Vite) │              └──────────────────────────┘        │  tsvector  │
└──────────────┘                                                  │  search    │
┌──────────────┐  stdio or    ┌──────────────────────────┐        │            │
│ Claude /     │ ───────────▶ │ MCP server (stateless)   │ ─────▶ │            │
│ MCP client   │  HTTP /mcp   └──────────────────────────┘        └────────────┘
└──────────────┘
```

- **`server/`**: Node + TypeScript. Express REST API, the ingestion worker (`rss-parser`,
  Mozilla Readability, `sanitize-html`, `node-cron`), and the MCP server
  (`@modelcontextprotocol/sdk`). All three share one data layer (`server/src/db/repo.ts`).
- **`web/`**: React + Vite single-page app, served by the API in production.

## Deployment options

The same code runs in both modes; only the entry point and the scheduler differ.

|                     | Self-hosted (Docker or Node)                         | Vercel                                                        |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| Entry point         | `server/src/api/index.ts`, a long-running server     | `api/index.mjs` → `server/src/vercel.ts`, a Vercel Function   |
| Web UI              | Served by the API (`WEB_DIST_DIR`)                   | Static files on Vercel's CDN                                  |
| Database            | Any Postgres 14+ (`docker compose` includes one)     | Neon via the Vercel Marketplace (free plan)                   |
| Scheduled refresh   | In-process `node-cron`, every 15 minutes (`FETCH_CRON`), or the separate worker | `GET /api/cron/refresh` from Vercel Cron (daily on Hobby) and, optionally, GitHub Actions every 30 minutes |
| MCP                 | stdio for Claude Desktop, or HTTP at `/mcp`          | HTTP at `/mcp`                                                |
| `API_TOKEN`         | Optional, for trusted networks                       | Required: requests are refused without it                    |
| Migrations          | On startup                                           | On the first request to a new instance                        |

## Self-hosted (Docker)

```sh
docker compose up -d --build
open http://localhost:3000
```

Follow a feed from the sidebar (for example `https://rss.arxiv.org/rss/cs.CL` or
`https://www.reddit.com/r/LocalAI/.rss`). It is fetched right away and then every 15 minutes.
You can also paste a website's address (such as `https://simonwillison.net`): the reader uses the
RSS or Atom feed the page advertises, or a common feed path such as `/feed` or `/rss`.

To move from another reader, use **Import OPML…** in the sidebar with your reader's OPML export.
OPML folders become boards (an existing board with the same name is reused), feeds you already
follow are skipped, and so are repeats within the file. Two URLs count as the same feed when they
differ only by `http`/`https`, a leading `www.`, letter case in the host, a trailing slash or a
fragment. Imported feeds are fetched straight away in the background. Feeds and boards are listed
alphabetically.

To bring over saved articles, use **Import bookmarks…** with a Netscape bookmarks file (Feedly's
"Saved For Later" export, or a browser's). Every link lands in your **Saved** list (folders are
ignored) under an "Imported bookmarks" feed; links that match an article already in one of your
feeds are just marked saved, and repeats are skipped, so re-importing is safe. Imported links are
marked read, so they don't inflate your unread counts, and are dated by when you saved them.
Article text is fetched lazily in the background, most recently saved first. A server that stays
up keeps going right after the import. On Vercel the page does the driving: while links are pending
and the web UI is open it asks `POST /api/bookmarks/fetch` for one time-boxed batch after another
(`BOOKMARK_REQUEST_MS`, `BOOKMARK_CONCURRENCY` pages at once), so a few thousand links take well
under an hour. When the page is closed, every scheduled refresh also fetches a batch first, before
refreshing feeds (up to `BOOKMARK_BATCH` links within `BOOKMARK_BUDGET_MS`), and
`GET /api/cron/bookmarks` fetches a batch on its own for schedulers. A link that returns a 4xx (404, 410, 403…) or whose host no longer exists is marked dead
straight away; timeouts and 5xx errors are retried after `BOOKMARK_RETRY_MINUTES` and marked dead
after `BOOKMARK_MAX_ATTEMPTS` tries. When nothing is left to fetch the server logs the dead links,
and the sidebar lists them under **Dead links** (also at `GET /api/bookmarks/report`). Dead links
stay in your saved list with the title from the export.

To fix a feed whose address has changed, or to rename it, hover over it in the sidebar and click
**✎** (or the red **!** shown when its last fetch failed). You can enter a new feed URL or the
site's address, give the feed your own name (leave it blank to use the feed's own title) and move
it to another board. A new address is fetched straight away, so you can see whether it works.
Your subscription keeps its board, name and read state; if someone else follows the old address,
only your subscription moves.

## Deploy to Vercel

The repo deploys to Vercel as-is (`vercel.json`). The web UI is served as static files, and the
REST API, `/mcp` and the refresh endpoint run as a single Vercel Function
(`api/index.mjs` → `server/src/vercel.ts`). Migrations run automatically on the first request.

1. Import the GitHub repo as a new Vercel project (keep the default settings; `vercel.json`
   supplies the build).
2. Add a database: **Storage → Create Database → Neon** (the free plan is enough) and connect
   it to the project. The integration sets `DATABASE_URL`, which the app uses (it also accepts
   `POSTGRES_URL`).
3. Set these environment variables:
   - `API_TOKEN`: **required.** The deployment refuses API and MCP requests without it. The
     web UI asks for it once and keeps it in the browser.
   - `CRON_SECRET`: a random string. Vercel Cron sends it to `/api/cron/refresh`.
4. Redeploy.

Feeds refresh when you add them, when you press refresh in the UI, and on a schedule:

- **Vercel Cron** calls `GET /api/cron/refresh` once a day (06:00 UTC), the most the Hobby plan
  allows. On Pro you can change the schedule in `vercel.json` to `*/15 * * * *`.
- **GitHub Actions** (`.github/workflows/refresh-feeds.yml`) can call it every 30 minutes. Set the
  repository variable `FEED_READER_URL` (for example `https://your-app.vercel.app`) and the
  repository secret `CRON_SECRET` to enable it.

MCP clients connect to `https://your-app.vercel.app/mcp` with `Authorization: Bearer <API_TOKEN>`,
for example `npx mcp-remote https://your-app.vercel.app/mcp --header "Authorization: Bearer <API_TOKEN>"`.

## Local development

Requires Node 20+ and PostgreSQL 14+.

```sh
npm install
createdb feeds                      # or: docker compose --profile dev up -d db db-port
export DATABASE_URL=postgres://feeds:feeds@localhost:5432/feeds
npm run dev:api                     # API on :3000 (runs migrations + scheduler)
npm run dev:web                     # UI on :5173, proxies /api to :3000
```

Other scripts: `npm test` (needs a Postgres database; set `TEST_DATABASE_URL`, default
`postgres://feeds:feeds@localhost:5432/feeds_test`), `npm run typecheck`, `npm run build`,
`npm run migrate`, and `npm run worker -w server` to run ingestion as a separate process
(set `INGEST_IN_PROCESS=false` on the API when you do). All settings are listed in
[`.env.example`](.env.example).

## Data model

| Table           | Purpose                                                                     |
| --------------- | --------------------------------------------------------------------------- |
| `feeds`         | `url`, `title`, `slug`, `last_fetched`, `last_error`                        |
| `items`         | `headline`, `summary` (plain-text excerpt), `full_content` (sanitized HTML), `content_text` (plain text), `thumbnail_url`, `published_date`; a generated, GIN-indexed `tsvector` weights headline > summary > body |
| `boards`        | User collections such as "Machine Learning" or "News"                        |
| `subscriptions` | Which feeds a user follows, optionally filed under a board                  |
| `user_items`    | Per-user `is_read`, `is_saved` and an optional `board_id` pin                |

An item belongs to a board when its feed is filed there or when it was pinned to the board
individually. Migrations live in `server/migrations/` and run automatically on startup.

### Ingestion

Every `FETCH_CRON` tick, each subscribed feed is fetched (`FETCH_CONCURRENCY` at a time) and
parsed (RSS 2.0, Atom and RDF). Items are deduplicated by GUID and by URL, both within the
batch and against what is already stored. HTML is sanitized (no scripts, styles or event
handlers, absolute URLs) and also flattened to text for search and the AI. If a feed only ships
a teaser (shorter than `EXTRACT_MIN_CHARS`), the article page is fetched and run through
Readability to get the full body, excerpt and lead image. Fetch errors are stored on the feed
and shown in the sidebar.

## Web UI

- **Display modes:** *Headlines* (dense list), *Magazine* (thumbnail plus the first 200
  characters of the summary) and *Full* (sanitized article HTML inline). Your choice is
  remembered.
- **State:** toggle read/unread and saved, pin an item to a board, mark a feed, a board or
  everything as read. Opening an article marks it read. In the reader, `j`/`k` move between
  articles and `Esc` closes it.
- **Sharing:** the Web Share API (the native share sheet on mobile) when available, plus
  Buffer, Pinterest, Tumblr, email and copy-link.
- **Search:** Postgres full-text search with web-search syntax (`tiny LLM OR "small language model" -crypto`).

## MCP server

The MCP server keeps no state of its own: every call goes straight to Postgres, so you can run
any number of instances.

### Tools

| Tool                | Arguments                                                                                           | Returns |
| ------------------- | --------------------------------------------------------------------------------------------------- | ------- |
| `search_feed_items` | `keyword?` (websearch syntax), `feed_name?` (string or list, matched against feed title/URL), `board?`, `status` (`read`/`unread`/`all`), `saved_only`, `since_days?`, `limit` | JSON list of `item_id`, `headline`, `summary`, `feed`, `url`, `published_date`, `is_read`, `is_saved` |
| `get_full_article`  | `item_id`                                                                                           | Full article text with metadata |
| `mark_as_read`      | `item_id` (string or list), `is_read` (default `true`)                                              | Updated ids, plus `not_found` for any unknown ids |
| `list_feeds`        | (none)                                                                                              | Boards and feeds with slugs, unread counts and resource URIs |

### Resources

- `feed://boards/{slug}`: the 20 newest unread articles in a board, as one Markdown document.
- `feed://subscriptions/{slug}`: the same for a single feed.

Both are listable and support slug autocompletion. Each article's text is capped at
`MCP_RESOURCE_ITEM_CHARS`, and `get_full_article` returns the full text.

### Connecting Claude Desktop

**stdio (recommended for a local install).** Build once with `npm run build`, then add this to
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "feed-reader": {
      "command": "node",
      "args": ["/absolute/path/to/feed-reader/server/dist/mcp/index.js"],
      "env": { "DATABASE_URL": "postgres://feeds:feeds@localhost:5432/feeds" }
    }
  }
}
```

If you run the stack with Docker, either start it with `--profile dev` so Postgres is
reachable on `localhost:5432`, or run the MCP server inside the app container:

```json
{
  "mcpServers": {
    "feed-reader": {
      "command": "docker",
      "args": ["compose", "-f", "/absolute/path/to/feed-reader/docker-compose.yml",
               "exec", "-T", "app", "node", "dist/mcp/index.js"]
    }
  }
}
```

**Streamable HTTP.** The API also serves MCP at `http://localhost:3000/mcp` (stateless, so it
needs no session affinity). Use it from any client that supports remote MCP servers, or bridge
it into Claude Desktop with `npx mcp-remote http://localhost:3000/mcp`. When `API_TOKEN` is set,
send `Authorization: Bearer <token>`. To run MCP on its own port instead, use
`npm run mcp -w server -- --http` (port `MCP_PORT`).

### Example

> Summarize the latest developments about tiny LLM models from my Arxiv and r/LocalAI feeds
> from the past week.

1. Claude calls `search_feed_items({ keyword: "tiny LLM OR small language model", feed_name: ["Arxiv", "r/LocalAI"], since_days: 7 })`.
2. It picks the most relevant hits and calls `get_full_article({ item_id })` for each.
3. It writes the summary, and if you asked it to tidy up, calls `mark_as_read` with the ids it processed.

## REST API

All routes are under `/api` and accept or return JSON. When `API_TOKEN` is set they require
`Authorization: Bearer <token>`.

| Method   | Path                    | Notes |
| -------- | ----------------------- | ----- |
| `GET`    | `/boards`               | With unread counts |
| `POST`   | `/boards`               | `{ name }` |
| `DELETE` | `/boards/:id`           | Its feeds stay subscribed |
| `GET`    | `/feeds`                | Subscriptions with unread counts and last fetch status |
| `POST`   | `/feeds`                | `{ url, board_id? }`: subscribes and fetches right away. A web page's URL is replaced by the feed it advertises; `422` if it has none |
| `POST`   | `/bookmarks`            | Import a Netscape bookmarks file (`text/html` body or `{ html }`) into the saved list. Returns `imported`, `matchedExisting`, `alreadySaved`, `duplicates`, `invalid` and a `report`; `400` for a file with no links |
| `POST`   | `/bookmarks/fetch`      | Fetch one time-boxed batch of pending bookmarks (newest first). Returns `fetched`, `dead`, `retry`, `remaining` and the `report` |
| `GET`    | `/bookmarks/report`     | Background fetch progress for imported bookmarks: `total`, `pending`, `fetched` and the `dead` links with their errors |
| `POST`   | `/opml`                 | Import subscriptions: an OPML body (`text/xml` or `text/x-opml`) or `{ opml }`. Returns `added`, `skipped` (with `reason`), `boardsCreated` and `invalid`; `400` for a file that isn't OPML |
| `PATCH`  | `/feeds/:id`            | Any of `{ url, title, board_id }`. `url` may be a site's address (feed discovery) and is fetched straight away (`refresh` in the response); `409` if you already follow that feed. `title: null` restores the feed's own title |
| `DELETE` | `/feeds/:id`            | Unsubscribe |
| `POST`   | `/feeds/:id/refresh`    | Fetch one feed now |
| `POST`   | `/refresh`              | Run a full ingestion pass and return a summary |
| `GET`    | `/cron/bookmarks`       | Fetch one batch of pending bookmarks; same authentication as `/cron/refresh` |
| `GET`    | `/cron/refresh`         | Same, for schedulers. Accepts `CRON_SECRET` or `API_TOKEN` as the bearer token (open when neither is set, except on Vercel) |
| `GET`    | `/items`                | `feed_id`, `board_id`, `status`, `saved`, `content` (include HTML), `q` (full-text), `limit`, `offset` |
| `GET`    | `/items/:id`            | Includes `full_content` |
| `PATCH`  | `/items/:id`            | `{ is_read?, is_saved?, board_id? }` |
| `POST`   | `/items/mark-read`      | `{ item_ids, is_read? }` or `{ feed_id? , board_id? }` (everything when neither is given) |

## Security notes

- Feed HTML is sanitized on the server during ingestion and again in the browser (DOMPurify).
- With no `API_TOKEN`, anyone who can reach the port can read and change your reader state.
  Bind it to localhost or a trusted network, or set a token. On Vercel the token is mandatory.
- The fetcher requests whatever URLs you subscribe to, plus the article links in those feeds
  (for Readability). If the server is reachable by people you don't trust, put it behind a
  token so they can't make it fetch internal addresses.
