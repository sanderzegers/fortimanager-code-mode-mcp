/**
 * FortiManager Code Mode MCP Server — Entry Point
 *
 * Wires everything together:
 * 1. Validate configuration (env vars)
 * 2. Load the API spec JSON
 * 3. Pre-warm QuickJS WASM module
 * 4. Create FortiManager client
 * 5. Create QuickJS executors (search + code)
 * 6. Build MCP server with two tools
 * 7. Start the chosen transport (stdio or HTTP)
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { FmgClient } from './client/fmg-client.js';
import { SearchExecutor } from './executor/search-executor.js';
import { CodeExecutor } from './executor/code-executor.js';
import { getQuickJSModule } from './executor/executor.js';
import { createMcpServer } from './server/server.js';
import { startStdioTransport, startHttpTransport } from './server/transport.js';
import type { FmgApiSpec } from './types/spec-types.js';

// ─── Helpers ────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Simple structured logger that writes to stderr (stdout reserved for stdio transport) */
const logger = {
  info: (msg: string, ...args: unknown[]): void => {
    // eslint-disable-next-line no-console
    console.error(`[INFO] ${msg}`, ...args);
  },
  warn: (msg: string, ...args: unknown[]): void => {
    // eslint-disable-next-line no-console
    console.error(`[WARN] ${msg}`, ...args);
  },
  error: (msg: string, ...args: unknown[]): void => {
    // eslint-disable-next-line no-console
    console.error(`[ERROR] ${msg}`, ...args);
  },
};

/**
 * Load the API spec JSON file for the configured version.
 */
async function loadSpec(version: string): Promise<FmgApiSpec> {
  const specPath = resolve(__dirname, `spec/fmg-api-spec-${version}.json`);
  logger.info(`Loading API spec from ${specPath}...`);

  let raw: string;
  try {
    raw = await readFile(specPath, 'utf-8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to load API spec for version ${version}: ${message}. ` +
        `Ensure fmg-api-spec-${version}.json exists in the spec/ directory.`,
    );
  }

  let spec: FmgApiSpec;
  try {
    spec = JSON.parse(raw) as FmgApiSpec;
  } catch {
    throw new Error(
      `Failed to parse API spec for version ${version}: invalid JSON. ` +
        `The spec file may be corrupted — try regenerating it.`,
    );
  }

  // Minimal shape validation
  if (
    !spec.version ||
    typeof spec.version !== 'string' ||
    !Array.isArray(spec.modules) ||
    spec.modules.length === 0
  ) {
    throw new Error(
      `Invalid API spec for version ${version}: missing or empty "version" or "modules" field. ` +
        `The spec file may be corrupted — try regenerating it.`,
    );
  }

  const totalObjects = spec.modules.reduce((sum, m) => sum + m.objects.length, 0);
  logger.info(
    `Loaded API spec v${spec.version} — ${String(spec.modules.length)} modules, ${String(totalObjects)} objects`,
  );

  return spec;
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info('FortiManager Code Mode MCP Server starting...');

  // 1. Load and validate configuration
  const config = loadConfig();
  logger.info(
    `Config: FMG=${config.fmgHost}:${String(config.fmgPort)}, API=${config.fmgApiVersion}, transport=${config.mcpTransport}`,
  );

  // 2. Load API spec
  const specStart = Date.now();
  const spec = await loadSpec(config.fmgApiVersion);
  logger.info(`Spec loaded in ${String(Date.now() - specStart)}ms`);

  // 3. Pre-warm QuickJS WASM module (avoids cold-start on first search call)
  const wasmStart = Date.now();
  await getQuickJSModule();
  logger.info(`QuickJS WASM initialized in ${String(Date.now() - wasmStart)}ms`);

  // 4. Create FortiManager client
  const client = new FmgClient({
    host: config.fmgHost,
    port: config.fmgPort,
    apiToken: config.fmgApiToken,
    verifySsl: config.fmgVerifySsl,
  });
  logger.info('FortiManager client created');

  // 5. Startup health check (non-fatal — search tool works without FMG)
  try {
    const health = await client.checkHealth();
    if (health.connected) {
      logger.info(
        `FortiManager connected — ${health.hostname ?? 'unknown'} v${health.version ?? 'unknown'}`,
      );
    } else {
      logger.warn(
        'FortiManager health check failed — execute tool may not work. Search tool is unaffected.',
      );
    }
  } catch {
    logger.warn('FortiManager unreachable — execute tool may not work. Search tool is unaffected.');
  }

  // 6. Create executors
  const executorStart = Date.now();
  const searchExecutor = new SearchExecutor(spec);
  const codeExecutor = new CodeExecutor(client);
  logger.info(`Executors created in ${String(Date.now() - executorStart)}ms`);

  // 7. Create MCP server
  const server = createMcpServer({
    searchExecutor,
    codeExecutor,
    specVersion: config.fmgApiVersion,
  });
  logger.info('MCP server created with search + execute tools');

  // 8. Start transport
  if (config.mcpTransport === 'stdio') {
    await startStdioTransport(server, logger);
  } else {
    await startHttpTransport(server, config, logger);
  }
}

main().catch((err: unknown) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
