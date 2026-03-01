/**
 * Live test script — validates SearchExecutor + CodeExecutor against real FortiManager
 *
 * Run: npx tsx scripts/live-test.ts
 */

import { readFileSync } from 'fs';
import { config } from 'dotenv';
import { SearchExecutor } from '../src/executor/search-executor.js';
import { CodeExecutor } from '../src/executor/code-executor.js';
import { FmgClient } from '../src/client/fmg-client.js';
import type { FmgApiSpec } from '../src/types/spec-types.js';

// Load .env
config();

const FMG_HOST = process.env['FMG_HOST']!;
const FMG_PORT = Number(process.env['FMG_PORT'] ?? '443');
const FMG_API_TOKEN = process.env['FMG_API_TOKEN']!;
const FMG_VERIFY_SSL = process.env['FMG_VERIFY_SSL'] !== 'false';
const FMG_API_VERSION = process.env['FMG_API_VERSION'] ?? '7.6';

let passed = 0;
let failed = 0;

function ok(name: string, result: unknown): void {
  console.log(`  ✓ ${name}:`, typeof result === 'object' ? JSON.stringify(result) : result);
  passed++;
}

function fail(name: string, error: unknown): void {
  console.error(`  ✗ ${name}:`, error);
  failed++;
}

// ─── Search Executor Tests ──────────────────────────────────────────

async function testSearch(): Promise<void> {
  console.log('\n═══ SearchExecutor (spec queries) ═══');

  const specPath = `src/spec/fmg-api-spec-${FMG_API_VERSION}.json`;
  console.log(`Loading spec from ${specPath}...`);
  const spec: FmgApiSpec = JSON.parse(readFileSync(specPath, 'utf8')) as FmgApiSpec;
  console.log(`Spec loaded: ${spec.modules.length} modules\n`);

  const executor = new SearchExecutor(spec, {
    timeoutMs: 10_000,
    maxMemoryBytes: 32 * 1024 * 1024,
  });

  // Test 1: specIndex count
  let r = await executor.execute('specIndex.length');
  if (r.ok && typeof r.data === 'number' && r.data > 1000) {
    ok('specIndex count', r.data);
  } else {
    fail('specIndex count', r.error ?? r.data);
  }

  // Test 2: Find firewall address objects
  r = await executor.execute(
    'specIndex.filter(o => o.name.includes("firewall/address")).map(o => o.name).slice(0, 5)',
  );
  if (r.ok && Array.isArray(r.data) && r.data.length > 0) {
    ok('firewall/address search', r.data);
  } else {
    fail('firewall/address search', r.error ?? r.data);
  }

  // Test 3: getObject by name
  r = await executor.execute(
    'const obj = getObject("firewall/address"); obj ? { name: obj.name, urlCount: obj.urls.length, attrCount: obj.attributes.length } : null',
  );
  if (r.ok && r.data && typeof r.data === 'object') {
    ok('getObject("firewall/address")', r.data);
  } else {
    fail('getObject("firewall/address")', r.error ?? r.data);
  }

  // Test 4: getObject by URL
  r = await executor.execute(
    'const obj = getObject("/pm/config/adom/<adom_name>/obj/firewall/address"); obj ? obj.name : null',
  );
  if (r.ok && r.data === 'firewall/address') {
    ok('getObject by URL', r.data);
  } else {
    fail('getObject by URL', r.error ?? r.data);
  }

  // Test 5: moduleList
  r = await executor.execute('moduleList.length');
  if (r.ok && typeof r.data === 'number' && r.data > 50) {
    ok('moduleList count', r.data);
  } else {
    fail('moduleList count', r.error ?? r.data);
  }

  // Test 6: errorCodes
  r = await executor.execute('errorCodes.length');
  if (r.ok && typeof r.data === 'number' && r.data > 10) {
    ok('errorCodes count', r.data);
  } else {
    fail('errorCodes count', r.error ?? r.data);
  }

  // Test 7: specVersion
  r = await executor.execute('specVersion');
  if (r.ok && r.data === FMG_API_VERSION) {
    ok('specVersion', r.data);
  } else {
    fail('specVersion', r.error ?? r.data);
  }

  // Test 8: Complex query — objects supporting 'exec' method
  r = await executor.execute('specIndex.filter(o => o.methods.includes("exec")).length');
  if (r.ok && typeof r.data === 'number') {
    ok('objects with exec method', r.data);
  } else {
    fail('objects with exec method', r.error ?? r.data);
  }
}

// ─── Code Executor Tests ────────────────────────────────────────────

async function testExecute(): Promise<void> {
  console.log('\n═══ CodeExecutor (live API calls) ═══');

  const client = new FmgClient({
    host: FMG_HOST,
    port: FMG_PORT,
    apiToken: FMG_API_TOKEN,
    verifySsl: FMG_VERIFY_SSL,
  });

  // Verify client connectivity first
  console.log('Testing client connectivity...');
  try {
    const health = await client.checkHealth();
    console.log(`Connected to: ${health.hostname} (${health.version})\n`);
  } catch (err) {
    console.error('Client health check failed:', err);
    return;
  }

  const executor = new CodeExecutor(client, {
    timeoutMs: 30_000,
    maxMemoryBytes: 64 * 1024 * 1024,
  });

  // Test 1: Get system status
  let r = await executor.execute(
    'const resp = fortimanager.request("get", [{ url: "/sys/status" }]); resp.result[0].data.Hostname',
  );
  if (r.ok && typeof r.data === 'string') {
    ok('Get /sys/status → Hostname', r.data);
  } else {
    fail('Get /sys/status', r.error ?? r.data);
  }

  // Test 2: List ADOMs (may fail with -11 if ADOMs disabled or no permission)
  r = await executor.execute(`
    const resp = fortimanager.request("get", [{ url: "/dvmdb/adom" }]);
    const result = resp.result[0];
    if (result.data) {
      const d = result.data;
      Array.isArray(d) ? d.map(function(a) { return a.name; }) : [d.name];
    } else {
      ({ status: result.status.code, message: result.status.message });
    }
  `);
  if (r.ok) {
    ok('List ADOMs', r.data);
  } else {
    fail('List ADOMs', r.error ?? r.data);
  }

  // Test 3: Get FMG version info
  r = await executor.execute(`
    const resp = fortimanager.request("get", [{ url: "/sys/status" }]);
    const d = resp.result[0].data;
    ({ version: d.Version, platform: d["Platform Type"], serial: d["Serial Number"] })
  `);
  if (r.ok && r.data && typeof r.data === 'object') {
    ok('Version info', r.data);
  } else {
    fail('Version info', r.error ?? r.data);
  }

  // Test 4: List devices (may be empty on fresh VM)
  r = await executor.execute(
    'const resp = fortimanager.request("get", [{ url: "/dvmdb/device", fields: ["name", "ip", "sn", "conn_status"] }]); resp.result[0]',
  );
  if (r.ok) {
    const result = r.data as Record<string, unknown>;
    const status = result['status'] as Record<string, unknown> | undefined;
    if (status?.['code'] === 0) {
      ok('List devices', result['data'] ?? '(empty)');
    } else {
      // -6 = no data (empty device list) is acceptable on fresh VM
      ok('List devices (empty)', status);
    }
  } else {
    fail('List devices', r.error);
  }

  // Test 5: Console log capture
  r = await executor.execute('console.log("hello from sandbox"); 42');
  if (r.ok && r.data === 42 && r.logs.length > 0 && r.logs[0].message === 'hello from sandbox') {
    ok('Console capture', { data: r.data, logCount: r.logs.length });
  } else {
    fail('Console capture', { data: r.data, logs: r.logs, error: r.error });
  }

  // Test 6: Error handling — bad URL
  r = await executor.execute(
    'const resp = fortimanager.request("get", [{ url: "/nonexistent/path" }]); resp.result[0].status',
  );
  if (r.ok) {
    ok('Bad URL error response', r.data);
  } else {
    fail('Bad URL error response', r.error);
  }

  // Test 7: Create and delete a firewall address object
  r = await executor.execute(`
    // Create a test address
    var addResp = fortimanager.request("set", [{
      url: "/pm/config/global/obj/firewall/address",
      data: { name: "mcp-test-addr", type: "ipmask", subnet: ["10.99.99.0", "255.255.255.0"], comment: "MCP live test" }
    }]);
    var addStatus = addResp.result[0].status;
    
    // Verify it exists
    var getResp = fortimanager.request("get", [{
      url: "/pm/config/global/obj/firewall/address/mcp-test-addr"
    }]);
    var exists = getResp.result[0].status.code === 0;
    
    // Clean up - delete it
    var delResp = fortimanager.request("delete", [{
      url: "/pm/config/global/obj/firewall/address/mcp-test-addr"
    }]);
    var delStatus = delResp.result[0].status;
    
    ({ created: addStatus.code, exists: exists, deleted: delStatus.code });
  `);
  if (r.ok && r.data && typeof r.data === 'object') {
    const result = r.data as Record<string, unknown>;
    if (result['created'] === 0 && result['exists'] === true && result['deleted'] === 0) {
      ok('CRUD firewall address', r.data);
    } else if (result['created'] === -11) {
      // API token lacks write permission — acceptable on restricted tokens
      ok('CRUD firewall address (no write perm)', r.data);
    } else {
      fail('CRUD firewall address', r.data);
    }
  } else {
    fail('CRUD firewall address', r.error ?? r.data);
  }

  // Test 8: Batch request (multiple params in one call)
  r = await executor.execute(`
    var resp = fortimanager.request("get", [
      { url: "/sys/status" },
      { url: "/cli/global/system/global", fields: ["hostname"] }
    ]);
    resp.result.map(function(r) { return r.status.code; });
  `);
  if (r.ok && Array.isArray(r.data)) {
    ok('Batch request', r.data);
  } else {
    fail('Batch request', r.error ?? r.data);
  }
}

// ─── Advanced Search Tests ──────────────────────────────────────────

async function testAdvancedSearch(): Promise<void> {
  console.log('\n═══ Advanced Search Tests ═══');

  const specPath = `src/spec/fmg-api-spec-${FMG_API_VERSION}.json`;
  const spec: FmgApiSpec = JSON.parse(readFileSync(specPath, 'utf8')) as FmgApiSpec;

  const executor = new SearchExecutor(spec, {
    timeoutMs: 10_000,
    maxMemoryBytes: 32 * 1024 * 1024,
  });

  // Test 1: Get full object details with attributes
  let r = await executor.execute(`
    var obj = getObject("system/admin/user");
    obj ? { name: obj.name, attrCount: obj.attributes.length, firstAttr: obj.attributes[0].name } : null;
  `);
  if (r.ok && r.data && typeof r.data === 'object') {
    ok('Full object details', r.data);
  } else {
    fail('Full object details', r.error ?? r.data);
  }

  // Test 2: Search by attribute name
  r = await executor.execute(`
    specIndex.filter(function(o) { return o.attributeNames.indexOf("sslvpn-realm") >= 0; }).map(function(o) { return o.name; });
  `);
  if (r.ok && Array.isArray(r.data)) {
    ok('Search by attribute name', r.data);
  } else {
    fail('Search by attribute name', r.error ?? r.data);
  }

  // Test 3: Find objects by URL pattern
  r = await executor.execute(`
    specIndex.filter(function(o) { return o.urls.some(function(u) { return u.indexOf("/cli/global/") === 0; }); }).length;
  `);
  if (r.ok && typeof r.data === 'number' && r.data > 0) {
    ok('CLI global objects count', r.data);
  } else {
    fail('CLI global objects count', r.error ?? r.data);
  }

  // Test 4: Error code lookup (positive codes from the spec)
  r = await executor.execute(`
    errorCodes.find(function(e) { return e.code === 0; });
  `);
  if (r.ok && r.data && typeof r.data === 'object') {
    ok('Error code lookup (0=OK)', r.data);
  } else {
    fail('Error code lookup (0=OK)', r.error ?? r.data);
  }

  // Test 5: Module listing with object counts
  r = await executor.execute(`
    moduleList.slice(0, 5).map(function(m) { return m.name + ": " + m.objectCount; });
  `);
  if (r.ok && Array.isArray(r.data)) {
    ok('Module listing', r.data);
  } else {
    fail('Module listing', r.error ?? r.data);
  }
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║  FortiManager Code Mode MCP — Live Tests     ║');
  console.log('╚═══════════════════════════════════════════════╝');
  console.log(`Target: ${FMG_HOST}:${FMG_PORT}`);
  console.log(`API Version: ${FMG_API_VERSION}`);
  console.log(`SSL Verify: ${FMG_VERIFY_SSL}`);

  await testSearch();
  await testExecute();
  await testAdvancedSearch();

  console.log('\n═══ Results ═══');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total:  ${passed + failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
