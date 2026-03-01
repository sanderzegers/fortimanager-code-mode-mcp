/**
 * Transport layer — Stdio or Streamable HTTP
 *
 * Configures and starts the appropriate MCP transport based on
 * the MCP_TRANSPORT environment variable.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppConfig } from '../config.js';

/** Logger matching the shape used in index.ts */
interface Logger {
  info: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

/**
 * Start the Stdio transport — reads from stdin, writes to stdout.
 */
export async function startStdioTransport(server: McpServer, logger: Logger): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('MCP server listening on stdio');
}

/**
 * Start the Streamable HTTP transport — spins up a Node.js HTTP server.
 */
export async function startHttpTransport(
  server: McpServer,
  config: AppConfig,
  logger: Logger,
): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  await server.connect(transport);

  const httpServer = createServer(
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '/';

      // Health-check endpoint
      if (url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: '0.1.0' }));
        return;
      }

      // MCP endpoint — handle POST, GET, DELETE for Streamable HTTP
      if (url === '/mcp') {
        await transport.handleRequest(req, res);
        return;
      }

      // Fallback
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    },
  );

  httpServer.listen(config.mcpHttpPort, () => {
    logger.info(`MCP HTTP server listening on port ${String(config.mcpHttpPort)}`);
    logger.info(`  Health:  http://localhost:${String(config.mcpHttpPort)}/health`);
    logger.info(`  MCP:     http://localhost:${String(config.mcpHttpPort)}/mcp`);
  });

  // Graceful shutdown
  const shutdown = (): void => {
    logger.info('Shutting down HTTP server...');
    httpServer.close();
    void transport.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
