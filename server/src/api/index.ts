import { config } from '../config.js';
import { migrate } from '../db/migrate.js';
import { ensureUser } from '../db/repo.js';
import { startScheduler } from '../ingest/scheduler.js';
import { createApp } from './app.js';

await migrate();
await ensureUser(config.userId);

createApp().listen(config.port, () => {
  console.log(`feed-reader API listening on http://localhost:${config.port}`);
  console.log(`MCP (Streamable HTTP) available at http://localhost:${config.port}/mcp`);
});

if (config.ingestInProcess) startScheduler();
