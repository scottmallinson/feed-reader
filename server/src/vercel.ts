// Vercel Function entry: the Express app (REST API, /mcp and /api/cron/refresh) as one handler.
// The web UI is served as static files by Vercel; there is no in-process scheduler here, since
// Vercel Cron (or any external scheduler) calls GET /api/cron/refresh instead.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from './api/app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { ensureUser } from './db/repo.js';

const app = createApp();

let ready: Promise<void> | undefined;

/** Migrates once per instance; a failed attempt is retried on the next request. */
function init(): Promise<void> {
  ready ??= (async () => {
    await migrate();
    await ensureUser(config.userId);
  })().catch((err) => {
    ready = undefined;
    throw err;
  });
  return ready;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    await init();
  } catch (err) {
    console.error('startup failed', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Database unavailable' }));
    return;
  }
  app(req as Parameters<typeof app>[0], res as Parameters<typeof app>[1]);
}
