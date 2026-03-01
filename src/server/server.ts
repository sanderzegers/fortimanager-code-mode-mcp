/**
 * MCP Server — FortiManager Code Mode
 *
 * Registers two tools:
 * - `search` — Query the FortiManager API spec via sandboxed JavaScript
 * - `execute` — Run live FortiManager API calls via sandboxed JavaScript
 *
 * Each tool accepts JavaScript code as input and runs it in a QuickJS WASM sandbox.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SearchExecutor } from '../executor/search-executor.js';
import type { CodeExecutor } from '../executor/code-executor.js';
import type { ExecuteResult } from '../executor/types.js';

// ─── Tool Descriptions ─────────────────────────────────────────────

const SEARCH_TOOL_DESCRIPTION = `Search the FortiManager JSON-RPC API specification.

Write JavaScript code that queries the API spec to find URLs, objects, attributes, methods, and error codes.

## Available Globals

- \`specIndex\` — Array of all API objects (lightweight). Each entry:
  \`{ name, type, module, description, urls: string[], methods: string[], attributeNames: string[] }\`

- \`getObject(nameOrUrl)\` — Get full object details by name (e.g., "firewall/address") or URL path (e.g., "/pm/config/adom/{adom}/obj/firewall/address"). Returns the complete object with all attributes, or null.

- \`moduleList\` — Array of all modules: \`{ name, title, objectCount, methodCount }\`

- \`errorCodes\` — Array of all error codes: \`{ code, message }\`

- \`specVersion\` — API spec version string (e.g., "7.6")

- \`console.log()\` — Captured in output logs

## Return Value

Your code's final expression is the result. Use it to return the data you found.

## Examples

\`\`\`javascript
// Find all firewall-related objects
specIndex.filter(o => o.name.includes('firewall')).map(o => ({ name: o.name, urls: o.urls, type: o.type }))
\`\`\`

\`\`\`javascript
// Get full details of firewall/address object
getObject('firewall/address')
\`\`\`

\`\`\`javascript
// Search for objects by attribute name
specIndex.filter(o => o.attributeNames.includes('srcaddr')).map(o => o.name)
\`\`\`

\`\`\`javascript
// List all modules
moduleList
\`\`\`

\`\`\`javascript
// Find objects that support 'add' method
specIndex.filter(o => o.methods.includes('add')).map(o => ({ name: o.name, urls: o.urls }))
\`\`\`

\`\`\`javascript
// Search by URL pattern
specIndex.filter(o => o.urls.some(u => u.includes('/dvmdb/'))).map(o => ({ name: o.name, urls: o.urls }))
\`\`\``;

const EXECUTE_TOOL_DESCRIPTION = `Execute FortiManager JSON-RPC API calls via sandboxed JavaScript.

Write JavaScript code that calls the FortiManager API. The code runs in an async sandbox with access to the \`fortimanager\` proxy object.

## Available Globals

- \`fortimanager.request(method, params)\` — Send a JSON-RPC request to FortiManager
  - \`method\`: \`"get" | "set" | "add" | "update" | "delete" | "exec" | "clone" | "move"\`
  - \`params\`: Array of parameter objects, each with at least \`url\` field
  - Returns: \`{ id, result: [{ status: { code, message }, url, data? }] }\`

- \`console.log()\` — Captured in output logs

## Parameter Object Fields

- \`url\` (required) — API URL path (e.g., "/dvmdb/adom")
- \`data\` — Request payload for add/set/update/exec
- \`filter\` — Filter expression: \`["field", "operator", "value"]\`
- \`fields\` — Array of field names to return
- \`sortings\` — Sort order: \`[{ "field": 1 }]\` (1=asc, -1=desc)
- \`range\` — Pagination: \`[start, count]\`
- \`loadsub\` — Load sub-tables: \`0\` or \`1\`
- \`option\` — Request options: \`"count"\`, \`"object member"\`, \`"loadsub"\`, etc.

## Examples

\`\`\`javascript
// List all ADOMs
const resp = await fortimanager.request('get', [{ url: '/dvmdb/adom' }]);
resp.result[0].data
\`\`\`

\`\`\`javascript
// Get system status
const resp = await fortimanager.request('get', [{ url: '/sys/status' }]);
resp.result[0].data
\`\`\`

\`\`\`javascript
// List devices in an ADOM
const resp = await fortimanager.request('get', [{
  url: '/dvmdb/adom/root/device',
  fields: ['name', 'ip', 'sn', 'conn_status']
}]);
resp.result[0].data
\`\`\`

\`\`\`javascript
// Create a firewall address
const resp = await fortimanager.request('add', [{
  url: '/pm/config/adom/root/obj/firewall/address',
  data: { name: 'test-server', subnet: ['10.0.1.100', '255.255.255.255'] }
}]);
resp.result[0].status
\`\`\`

\`\`\`javascript
// Device proxy call — get interfaces from managed FortiGate
const resp = await fortimanager.request('exec', [{
  url: '/sys/proxy/json',
  data: {
    target: ['/adom/root/device/my-fortigate'],
    action: 'get',
    resource: '/api/v2/monitor/system/interface'
  }
}]);
resp.result[0].data
\`\`\``;

// ─── Server Factory ─────────────────────────────────────────────────

export interface CreateServerOptions {
  searchExecutor: SearchExecutor;
  codeExecutor: CodeExecutor;
  specVersion: string;
}

/**
 * Create and configure the MCP server with search and execute tools.
 */
export function createMcpServer(options: CreateServerOptions): McpServer {
  const { searchExecutor, codeExecutor, specVersion } = options;

  const server = new McpServer(
    {
      name: 'fortimanager-code-mode',
      version: '0.1.0',
    },
    {
      capabilities: { tools: {} },
      instructions: [
        'FortiManager Code Mode MCP Server.',
        `Connected to FMG API spec version ${specVersion}.`,
        '',
        'Use the `search` tool to explore the FortiManager API specification.',
        'Use the `execute` tool to run live API calls against FortiManager.',
        '',
        'Workflow: Search first to find the right URLs and attributes, then execute API calls.',
      ].join('\n'),
    },
  );

  // ── Search Tool ───────────────────────────────────────────────

  server.registerTool(
    'search',
    {
      title: 'Search FMG API Spec',
      description: SEARCH_TOOL_DESCRIPTION,
      inputSchema: {
        code: z
          .string()
          .describe(
            'JavaScript code to execute against the API spec. The final expression is returned as the result.',
          ),
      },
    },
    async ({ code }) => {
      const result = await searchExecutor.execute(code);
      return formatToolResult(result);
    },
  );

  // ── Execute Tool ──────────────────────────────────────────────

  server.registerTool(
    'execute',
    {
      title: 'Execute FMG API Call',
      description: EXECUTE_TOOL_DESCRIPTION,
      inputSchema: {
        code: z
          .string()
          .describe(
            'JavaScript code to execute against the live FortiManager API. Supports async/await.',
          ),
      },
    },
    async ({ code }) => {
      const result = await codeExecutor.execute(code);
      return formatToolResult(result);
    },
  );

  return server;
}

// ─── Constants ──────────────────────────────────────────────────────

/** Maximum size of a tool result in characters before truncation */
const MAX_RESULT_SIZE = 100_000; // ~100 KB

// ─── Result Formatting ──────────────────────────────────────────────

function formatToolResult(result: ExecuteResult) {
  const parts: Array<{ type: 'text'; text: string }> = [];

  // Add console logs if any
  if (result.logs.length > 0) {
    const logText = result.logs.map((l) => `[${l.level}] ${l.message}`).join('\n');
    parts.push({ type: 'text' as const, text: `--- Console Output ---\n${logText}` });
  }

  // Add result or error
  if (result.ok) {
    let dataStr =
      result.data !== undefined
        ? typeof result.data === 'string'
          ? result.data
          : JSON.stringify(result.data, null, 2)
        : '(no return value)';

    // Truncate oversized results to prevent flooding the MCP client
    if (dataStr.length > MAX_RESULT_SIZE) {
      const truncatedSize = dataStr.length;
      dataStr =
        dataStr.slice(0, MAX_RESULT_SIZE) +
        `\n\n--- TRUNCATED (${String(truncatedSize)} chars total, showing first ${String(MAX_RESULT_SIZE)}) ---` +
        '\nTip: Use .slice(), .filter(), or specific field selections to reduce output size.';
    }

    parts.push({ type: 'text' as const, text: dataStr });
  } else {
    parts.push({
      type: 'text' as const,
      text: `Error: ${result.error ?? 'Unknown error'}`,
    });
  }

  // Add execution time
  parts.push({
    type: 'text' as const,
    text: `\n--- Executed in ${result.durationMs}ms ---`,
  });

  return {
    content: parts,
    isError: !result.ok,
  };
}
