// MCP server entrypoint.
//   stdio (default): launched by Claude Desktop / IDEs as a subprocess.
//   --http:          standalone Streamable HTTP server on MCP_PORT (POST /mcp).
// stdout is the JSON-RPC channel in stdio mode, so all logging goes to stderr.
import express from 'express';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from '../config.js';
import { migrate } from '../db/migrate.js';
import { closePool } from '../db/pool.js';
import { ensureUser } from '../db/repo.js';
import { mcpHttpHandler } from './http.js';
import { createMcpServer } from './server.js';

const log = (msg: string) => console.error(`[feed-reader-mcp] ${msg}`);

await migrate(log);
await ensureUser(config.userId);

if (process.argv.includes('--http')) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.all('/mcp', (req, res, next) => {
    if (config.apiToken && req.headers.authorization !== `Bearer ${config.apiToken}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }, mcpHttpHandler());
  app.listen(config.mcpPort, () => log(`listening on http://localhost:${config.mcpPort}/mcp`));
} else {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  log('ready on stdio');
  const shutdown = async () => {
    await server.close();
    await closePool();
    process.exit(0);
  };
  process.stdin.on('end', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
