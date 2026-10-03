import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.js';
import * as repo from '../db/repo.js';
import type { ItemRow } from '../db/repo.js';

const RESOURCE_ITEM_COUNT = 20;

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function toolError(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function brief(item: ItemRow) {
  return {
    item_id: item.id,
    headline: item.headline,
    summary: item.summary,
    feed: item.feed_title,
    url: item.url,
    published_date: item.published_date?.toISOString() ?? null,
    is_read: item.is_read,
    is_saved: item.is_saved,
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}\n[…truncated; call get_full_article for the rest]`;
}

/** Renders items as one Markdown document an LLM can read straight through. */
function concatenate(title: string, items: ItemRow[]): string {
  if (items.length === 0) return `# ${title}\n\nNo unread articles.`;
  const sections = items.map((it) => {
    const meta = [
      `item_id: ${it.id}`,
      it.feed_title && `feed: ${it.feed_title}`,
      it.published_date && `published: ${it.published_date.toISOString()}`,
      it.url && `url: ${it.url}`,
    ]
      .filter(Boolean)
      .join(' | ');
    const body = it.content_text || it.summary || '';
    return `## ${it.headline}\n${meta}\n\n${truncate(body, config.mcpResourceItemChars)}`;
  });
  return `# ${title}\n\n${items.length} most recent unread articles.\n\n${sections.join('\n\n---\n\n')}`;
}

const stringOrList = z.union([z.string(), z.array(z.string())]);
const toList = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/**
 * Builds an MCP server bound to one user's reader state. The server keeps no state of its
 * own: every call goes straight to Postgres, so a fresh instance per request is fine.
 */
export function createMcpServer(userId = config.userId): McpServer {
  const server = new McpServer(
    { name: 'feed-reader', version: '0.1.0' },
    {
      instructions:
        'Access to the user\'s self-hosted RSS/Atom feed reader. Use search_feed_items to find ' +
        'articles (full-text search, filterable by feed, board, read status and age), then ' +
        'get_full_article for the complete text of the relevant ones. Call mark_as_read on items ' +
        'you have processed when the user asks you to clean up their inbox. Boards and ' +
        'subscriptions are also exposed as resources (feed://boards/{slug}, ' +
        'feed://subscriptions/{slug}) containing their newest unread articles.',
    },
  );

  // ---------------------------------------------------------------- tools

  server.registerTool(
    'search_feed_items',
    {
      title: 'Search feed items',
      description:
        'Full-text search across articles from the user\'s subscribed feeds. Returns matching ' +
        'item_id, headline, summary, feed, url and dates, best matches first. The keyword ' +
        'supports web-search syntax: `tiny LLM OR "small language model" -crypto`. Omit keyword ' +
        'to list the newest items matching the other filters.',
      inputSchema: {
        keyword: z
          .string()
          .optional()
          .describe('Search terms. Supports OR, "quoted phrases" and -exclusions.'),
        feed_name: stringOrList
          .optional()
          .describe(
            'Restrict to feeds whose title or URL contains this text (case-insensitive), e.g. "Arxiv" or ["Arxiv", "r/LocalAI"].',
          ),
        board: z.string().optional().describe('Restrict to a board, by slug (see list_feeds).'),
        status: z.enum(['read', 'unread', 'all']).default('all').describe('Read-state filter.'),
        saved_only: z.boolean().default(false).describe('Only items the user saved.'),
        since_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe('Only items published within the last N days, e.g. 7 for the past week.'),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const results = await repo.searchItems(userId, {
        keyword: args.keyword,
        feedNames: toList(args.feed_name),
        boardSlug: args.board,
        status: args.status,
        savedOnly: args.saved_only,
        sinceDays: args.since_days,
        limit: args.limit,
      });
      return json({ count: results.length, items: results.map(brief) });
    },
  );

  server.registerTool(
    'get_full_article',
    {
      title: 'Get full article',
      description:
        'Fetch the complete parsed text of one article by item_id (from search_feed_items), for deep reading and synthesis.',
      inputSchema: { item_id: z.string().describe('The item_id returned by search_feed_items.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ item_id }) => {
      try {
        const item = await repo.getItem(userId, item_id);
        const header = [
          `# ${item.headline}`,
          item.feed_title && `Feed: ${item.feed_title}`,
          item.author && `Author: ${item.author}`,
          item.published_date && `Published: ${item.published_date.toISOString()}`,
          item.url && `URL: ${item.url}`,
          `item_id: ${item.id} | read: ${item.is_read} | saved: ${item.is_saved}`,
        ]
          .filter(Boolean)
          .join('\n');
        const body = item.content_text || item.summary || '(This item has no text content.)';
        return { content: [{ type: 'text' as const, text: `${header}\n\n${body}` }] };
      } catch (err) {
        if (err instanceof repo.NotFoundError) return toolError(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    'mark_as_read',
    {
      title: 'Mark as read',
      description:
        'Mark one or more articles as read in the user\'s reader (or unread with is_read: false). Use after processing items to clean up the inbox.',
      inputSchema: {
        item_id: stringOrList.describe('An item_id, or a list of item_ids.'),
        is_read: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ item_id, is_read }) => {
      const requested = toList(item_id);
      const updated = await repo.markItemsRead(userId, requested, is_read);
      const missing = requested.filter((id) => !updated.includes(id));
      return json({ updated, ...(missing.length ? { not_found: missing } : {}) });
    },
  );

  server.registerTool(
    'list_feeds',
    {
      title: 'List feeds and boards',
      description:
        'List the user\'s boards and subscribed feeds with unread counts, slugs and resource URIs. Useful to discover valid feed_name and board values.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const [boards, feeds] = await Promise.all([repo.listBoards(userId), repo.listFeeds(userId)]);
      return json({
        boards: boards.map((b) => ({ ...b, resource: `feed://boards/${b.slug}` })),
        feeds: feeds.map((f) => ({
          id: f.id,
          title: f.title,
          url: f.url,
          slug: f.slug,
          board: boards.find((b) => b.id === f.board_id)?.slug ?? null,
          unread_count: f.unread_count,
          last_fetched: f.last_fetched,
          last_error: f.last_error,
          resource: f.slug ? `feed://subscriptions/${f.slug}` : null,
        })),
      });
    },
  );

  // ---------------------------------------------------------------- resources

  server.registerResource(
    'board',
    new ResourceTemplate('feed://boards/{slug}', {
      list: async () => ({
        resources: (await repo.listBoards(userId)).map((b) => ({
          uri: `feed://boards/${b.slug}`,
          name: b.name,
          description: `Board "${b.name}": ${b.unread_count} unread`,
          mimeType: 'text/markdown',
        })),
      }),
      complete: {
        slug: async (value) =>
          (await repo.listBoards(userId)).map((b) => b.slug).filter((s) => s.startsWith(value)),
      },
    }),
    {
      title: 'Board',
      description: `The ${RESOURCE_ITEM_COUNT} newest unread articles in a board, concatenated as Markdown.`,
      mimeType: 'text/markdown',
    },
    async (uri, { slug }) => {
      const board = await repo.getBoardBySlug(userId, String(slug));
      if (!board) throw new Error(`Unknown board: ${slug}`);
      const items = await repo.listItems(userId, {
        boardId: board.id,
        status: 'unread',
        includeContent: true,
        limit: RESOURCE_ITEM_COUNT,
      });
      return {
        contents: [
          { uri: uri.href, mimeType: 'text/markdown', text: concatenate(`Board: ${board.name}`, items) },
        ],
      };
    },
  );

  server.registerResource(
    'subscription',
    new ResourceTemplate('feed://subscriptions/{slug}', {
      list: async () => ({
        resources: (await repo.listFeeds(userId))
          .filter((f) => f.slug)
          .map((f) => ({
            uri: `feed://subscriptions/${f.slug}`,
            name: f.title ?? f.url,
            description: `Feed ${f.url}: ${f.unread_count} unread`,
            mimeType: 'text/markdown',
          })),
      }),
      complete: {
        slug: async (value) =>
          (await repo.listFeeds(userId))
            .flatMap((f) => (f.slug ? [f.slug] : []))
            .filter((s) => s.startsWith(value)),
      },
    }),
    {
      title: 'Subscription',
      description: `The ${RESOURCE_ITEM_COUNT} newest unread articles from one feed, concatenated as Markdown.`,
      mimeType: 'text/markdown',
    },
    async (uri, { slug }) => {
      const feed = await repo.getFeedBySlug(userId, String(slug));
      if (!feed) throw new Error(`Unknown subscription: ${slug}`);
      const items = await repo.listItems(userId, {
        feedId: feed.id,
        status: 'unread',
        includeContent: true,
        limit: RESOURCE_ITEM_COUNT,
      });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: concatenate(`Feed: ${feed.title ?? feed.url}`, items),
          },
        ],
      };
    },
  );

  return server;
}
