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

// ─── Rate Limiter ───────────────────────────────────────────────────

/** Simple sliding-window rate limiter per client IP */
class RateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly windows: Map<string, number[]> = new Map();

  constructor(windowMs: number = 60_000, maxRequests: number = 60) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  /** Returns true if the request is allowed, false if rate-limited */
  allow(clientIp: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let timestamps = this.windows.get(clientIp);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(clientIp, timestamps);
    }

    // Remove expired timestamps
    while (timestamps.length > 0 && timestamps[0]! < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= this.maxRequests) {
      return false;
    }

    timestamps.push(now);
    return true;
  }

  /** Periodically clean up stale entries (call every ~5 minutes) */
  cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [ip, timestamps] of this.windows) {
      while (timestamps.length > 0 && timestamps[0]! < cutoff) {
        timestamps.shift();
      }
      if (timestamps.length === 0) {
        this.windows.delete(ip);
      }
    }
  }
}

// ─── Request Stats ──────────────────────────────────────────────────

interface RequestStats {
  totalRequests: number;
  mcpRequests: number;
  healthRequests: number;
  rateLimited: number;
  errors: number;
  startedAt: string;
}

function createStats(): RequestStats {
  return {
    totalRequests: 0,
    mcpRequests: 0,
    healthRequests: 0,
    rateLimited: 0,
    errors: 0,
    startedAt: new Date().toISOString(),
  };
}

/** Extract client IP from request (supports X-Forwarded-For) */
function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0]?.trim() ?? 'unknown';
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Start the Stdio transport — reads from stdin, writes to stdout.
 */
export async function startStdioTransport(server: McpServer, logger: Logger): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('MCP server listening on stdio');

  // Graceful shutdown for stdio transport
  const shutdown = (): void => {
    logger.info('Shutting down stdio transport...');
    void transport.close().catch(() => {
      /* ignore close errors */
    });
    void server.close().catch(() => {
      /* ignore close errors */
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
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

  const stats = createStats();
  const rateLimiter = new RateLimiter(60_000, 60); // 60 requests per minute per IP

  // Periodic cleanup of rate limiter state (every 5 minutes)
  const cleanupInterval = setInterval(() => {
    rateLimiter.cleanup();
  }, 300_000);
  cleanupInterval.unref(); // Don't prevent process exit

  await server.connect(transport);

  const httpServer = createServer(
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    async (req: IncomingMessage, res: ServerResponse) => {
      const startTime = Date.now();
      const clientIp = getClientIp(req);
      stats.totalRequests++;

      try {
        const url = req.url ?? '/';

        // Health-check endpoint (not rate-limited)
        if (url === '/health' && req.method === 'GET') {
          stats.healthRequests++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'ok',
              version: '0.1.0',
              uptime: Math.floor((Date.now() - new Date(stats.startedAt).getTime()) / 1000),
              stats: {
                totalRequests: stats.totalRequests,
                mcpRequests: stats.mcpRequests,
                rateLimited: stats.rateLimited,
                errors: stats.errors,
              },
            }),
          );
          return;
        }

        // Rate limiting for MCP endpoint
        if (url === '/mcp' && !rateLimiter.allow(clientIp)) {
          stats.rateLimited++;
          logger.info(`Rate limited: ${clientIp} ${req.method ?? 'UNKNOWN'} ${url}`);
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': '60',
          });
          res.end(JSON.stringify({ error: 'Too many requests. Limit: 60 per minute.' }));
          return;
        }

        // MCP endpoint — handle POST, GET, DELETE for Streamable HTTP
        if (url === '/mcp') {
          stats.mcpRequests++;
          logger.info(
            `MCP ${req.method ?? 'UNKNOWN'} from ${clientIp}`,
          );
          await transport.handleRequest(req, res);
          const elapsed = Date.now() - startTime;
          logger.info(`MCP ${req.method ?? 'UNKNOWN'} completed in ${String(elapsed)}ms`);
          return;
        }

        // Fallback
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      } catch (err: unknown) {
        stats.errors++;
        logger.error('HTTP handler error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      }
    },
  );

  httpServer.listen(config.mcpHttpPort, () => {
    logger.info(`MCP HTTP server listening on port ${String(config.mcpHttpPort)}`);
    logger.info(`  Health:  http://localhost:${String(config.mcpHttpPort)}/health`);
    logger.info(`  MCP:     http://localhost:${String(config.mcpHttpPort)}/mcp`);
  });

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down HTTP server...');
    clearInterval(cleanupInterval);
    httpServer.close();
    void transport.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
