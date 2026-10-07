import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import * as repo from '../db/repo.js';
import { NoFeedFoundError, resolveFeedUrl } from '../ingest/discover.js';
import { BookmarksParseError, parseBookmarks } from '../ingest/bookmarks.js';
import { drainPendingBookmarks } from '../ingest/bookmark-fetch.js';
import { OpmlParseError, parseOpml } from '../ingest/opml.js';
import { refreshFeed } from '../ingest/ingest.js';
import { runIngestion } from '../ingest/scheduler.js';
import { mcpHttpHandler } from '../mcp/http.js';

const id = z.coerce.number().int().positive();
const status = z.enum(['read', 'unread', 'all']);

const listQuery = z.object({
  feed_id: id.optional(),
  board_id: id.optional(),
  status: status.default('all'),
  saved: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  content: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const opmlBody = z.object({ opml: z.string().min(1) });
const bookmarksBody = z.object({ html: z.string().min(1) });
const subscribeBody = z.object({ url: z.url(), board_id: id.nullable().optional() });
const feedPatch = z
  .object({
    board_id: id.nullable().optional(),
    url: z.url().optional(),
    // A custom display name; null or "" restores the feed's own title.
    title: z.string().trim().max(200).nullable().optional(),
  })
  .refine((p) => p.board_id !== undefined || p.url !== undefined || p.title !== undefined, {
    message: 'Nothing to update',
  });
const boardBody = z.object({ name: z.string().trim().min(1).max(100) });
const itemPatch = z.object({
  is_read: z.boolean().optional(),
  is_saved: z.boolean().optional(),
  board_id: id.nullable().optional(),
});
const markReadBody = z.union([
  z.object({ item_ids: z.array(z.string()).min(1), is_read: z.boolean().default(true) }),
  z.object({ feed_id: id.optional(), board_id: id.optional(), all: z.literal(true).optional() }),
]);

function bearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

function requireToken(req: Request, res: Response, next: NextFunction) {
  if (!config.apiToken) {
    // A public deployment without a token would expose everything; refuse instead.
    if (config.onVercel) {
      res.status(503).json({ error: 'API_TOKEN must be set on this deployment' });
      return;
    }
    return next();
  }
  if (bearer(req) === config.apiToken) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

/** Scheduled refreshes authenticate with CRON_SECRET (sent by Vercel Cron) or the API token. */
function requireCronAuth(req: Request, res: Response, next: NextFunction) {
  const secrets = [config.cronSecret, config.apiToken].filter(Boolean);
  if (secrets.length === 0 && !config.onVercel) return next();
  if (secrets.includes(bearer(req))) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

export interface AppOptions {
  userId?: number;
  webDistDir?: string;
  /** Called after bookmarks are imported, to start fetching their pages. Defaults to fetching in-process. */
  startBookmarkFetch?: () => void;
}

export function createApp(opts: AppOptions = {}) {
  const userId = opts.userId ?? config.userId;
  const startBookmarkFetch =
    opts.startBookmarkFetch ??
    (() => {
      // Serverless functions stop after the response; there the scheduled passes do the fetching.
      if (config.bookmarkFetchOnImport) void drainPendingBookmarks();
    });
  const app = express();
  app.disable('x-powered-by');
  // OPML imports can be a few MB; Vercel caps request bodies at 4.5 MB.
  app.use(express.json({ limit: '4mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/cron/refresh', requireCronAuth, async (_req, res) => {
    res.json({ summary: await runIngestion() });
  });

  const api = express.Router();
  api.use(requireToken);

  // ------------------------------------------------------------ boards
  api.get('/boards', async (_req, res) => {
    res.json(await repo.listBoards(userId));
  });
  api.post('/boards', async (req, res) => {
    const { name } = boardBody.parse(req.body);
    res.status(201).json(await repo.createBoard(userId, name));
  });
  api.delete('/boards/:id', async (req, res) => {
    await repo.deleteBoard(userId, id.parse(req.params.id));
    res.status(204).end();
  });

  // ------------------------------------------------------------ feeds
  api.get('/feeds', async (_req, res) => {
    res.json(await repo.listFeeds(userId));
  });
  api.post('/feeds', async (req, res) => {
    const body = subscribeBody.parse(req.body);
    // Accept a site's address as well as its feed URL.
    const feedUrl = await resolveFeedUrl(body.url);
    const feedId = await repo.subscribe(userId, feedUrl, body.board_id ?? null);
    const result = await refreshFeed(feedId);
    res.status(201).json({ ...(await repo.getFeed(userId, feedId)), refresh: result });
  });
  // Import subscriptions from OPML: raw XML body, or JSON { opml: "<opml>..." }.
  api.post(
    '/opml',
    express.text({ type: ['text/xml', 'application/xml', 'text/x-opml', 'application/octet-stream'], limit: '4mb' }),
    async (req, res) => {
      const xml = typeof req.body === 'string' ? req.body : opmlBody.parse(req.body).opml;
      const { feeds, invalid } = parseOpml(xml);
      const result = await repo.importFeeds(userId, feeds);
      res.json({ ...result, invalid });
    },
  );
  // Import saved links from a Netscape bookmarks file (e.g. Feedly's "Saved For Later" export):
  // raw HTML body, or JSON { html }. Links join the saved list; article text is fetched afterwards.
  api.post(
    '/bookmarks',
    express.text({ type: ['text/html', 'text/plain'], limit: '4mb' }),
    async (req, res) => {
      const html = typeof req.body === 'string' ? req.body : bookmarksBody.parse(req.body).html;
      const { bookmarks, invalid, duplicates } = parseBookmarks(html);
      const result = await repo.importBookmarks(userId, bookmarks);
      if (result.imported > 0) startBookmarkFetch();
      res.json({ ...result, duplicates, invalid, report: await repo.bookmarkReport(userId) });
    },
  );
  // Fetch progress for imported bookmarks, including the links found to be dead.
  api.get('/bookmarks/report', async (_req, res) => {
    res.json(await repo.bookmarkReport(userId));
  });
  api.patch('/feeds/:id', async (req, res) => {
    let feedId = id.parse(req.params.id);
    const patch = feedPatch.parse(req.body);
    await repo.getFeed(userId, feedId);
    let refresh: Awaited<ReturnType<typeof refreshFeed>> | undefined;
    if (patch.url !== undefined) {
      // Same rules as following: a site's address resolves to the feed it advertises.
      const feedUrl = await resolveFeedUrl(patch.url);
      const before = feedId;
      feedId = await repo.changeFeedUrl(userId, feedId, feedUrl);
      // Fetch straight away so the user sees whether the new address works.
      if (feedId !== before || (await repo.getFeed(userId, feedId)).last_fetched === null) {
        refresh = await refreshFeed(feedId);
      }
    }
    if (patch.title !== undefined) await repo.setFeedTitle(userId, feedId, patch.title);
    if (patch.board_id !== undefined) await repo.setFeedBoard(userId, feedId, patch.board_id);
    res.json({ ...(await repo.getFeed(userId, feedId)), ...(refresh ? { refresh } : {}) });
  });
  api.delete('/feeds/:id', async (req, res) => {
    await repo.unsubscribe(userId, id.parse(req.params.id));
    res.status(204).end();
  });
  api.post('/feeds/:id/refresh', async (req, res) => {
    const feedId = id.parse(req.params.id);
    await repo.getFeed(userId, feedId);
    res.json(await refreshFeed(feedId));
  });
  // Awaited rather than fire-and-forget so it also completes on serverless platforms.
  api.post('/refresh', async (_req, res) => {
    res.json({ summary: await runIngestion() });
  });

  // ------------------------------------------------------------ items
  api.get('/items', async (req, res) => {
    const q = listQuery.parse(req.query);
    if (q.q?.trim()) {
      const board = q.board_id
        ? (await repo.listBoards(userId)).find((b) => b.id === q.board_id)
        : undefined;
      res.json(
        await repo.searchItems(userId, {
          keyword: q.q,
          status: q.status,
          savedOnly: q.saved,
          boardSlug: board?.slug,
          feedId: q.feed_id,
          limit: Math.min(q.limit, 50),
        }),
      );
      return;
    }
    res.json(
      await repo.listItems(userId, {
        feedId: q.feed_id,
        boardId: q.board_id,
        status: q.status,
        saved: q.saved,
        includeContent: q.content,
        limit: q.limit,
        offset: q.offset,
      }),
    );
  });
  api.get('/items/:id', async (req, res) => {
    res.json(await repo.getItem(userId, req.params.id));
  });
  api.patch('/items/:id', async (req, res) => {
    res.json(await repo.updateItemState(userId, req.params.id, itemPatch.parse(req.body)));
  });
  api.post('/items/mark-read', async (req, res) => {
    const body = markReadBody.parse(req.body);
    if ('item_ids' in body) {
      const ids = await repo.markItemsRead(userId, body.item_ids, body.is_read);
      res.json({ updated: ids.length, item_ids: ids });
      return;
    }
    const updated = await repo.markAllRead(userId, { feedId: body.feed_id, boardId: body.board_id });
    res.json({ updated });
  });

  app.use('/api', api);

  // Streamable HTTP MCP endpoint, so remote/HTTP MCP clients can share the API's port.
  app.all('/mcp', requireToken, mcpHttpHandler(userId));

  // Serve the built web app when it is available.
  const webDistOption = opts.webDistDir ?? config.webDistDir;
  const webDist = webDistOption ? path.resolve(webDistOption) : undefined;
  if (webDist && existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/|\/mcp).*/, (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request', issues: err.issues });
    } else if (err instanceof OpmlParseError || err instanceof BookmarksParseError) {
      res.status(400).json({ error: err.message });
    } else if (err instanceof NoFeedFoundError) {
      res.status(422).json({ error: err.message });
    } else if (err instanceof repo.ConflictError) {
      res.status(409).json({ error: err.message });
    } else if (err instanceof repo.NotFoundError) {
      res.status(404).json({ error: err.message });
    } else if (err instanceof TypeError && /Invalid URL/i.test(err.message)) {
      res.status(400).json({ error: 'Invalid URL' });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return app;
}
