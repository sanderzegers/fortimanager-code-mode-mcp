/**
 * API Spec Coverage Report & Validation
 *
 * Analyses the generated spec JSON for coverage metrics and optionally
 * validates a sample of URLs against a live FortiManager instance.
 *
 * Run modes:
 *   npx tsx scripts/spec-coverage.ts                 # Offline report only
 *   npx tsx scripts/spec-coverage.ts --validate      # + live URL validation
 *   npx tsx scripts/spec-coverage.ts --validate --sample 200  # custom sample size
 *   npx tsx scripts/spec-coverage.ts --version 7.4   # specify spec version
 *
 * Env: Requires .env with FMG_HOST, FMG_API_TOKEN when using --validate
 */

import { readFileSync } from 'fs';
import { config } from 'dotenv';
import { FmgClient } from '../src/client/fmg-client.js';
import type { FmgApiSpec, FmgObjectDef, FmgAttributeDef } from '../src/types/spec-types.js';
import { FmgApiError } from '../src/client/types.js';

config();

// ─── CLI Args ───────────────────────────────────────────────────────

const VALIDATE = process.argv.includes('--validate');
const SAMPLE_SIZE = (() => {
  const idx = process.argv.indexOf('--sample');
  return idx >= 0 ? Number(process.argv[idx + 1]) : 100;
})();
const SPEC_VERSION = (() => {
  const idx = process.argv.indexOf('--version');
  return idx >= 0 ? process.argv[idx + 1] : (process.env['FMG_API_VERSION'] ?? '7.6');
})();

// ─── Helpers ────────────────────────────────────────────────────────

function heading(title: string): void {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function row(label: string, value: string | number): void {
  console.log(`  ${label.padEnd(40)} ${value}`);
}

function pct(n: number, total: number): string {
  if (total === 0) return '0.0%';
  return `${((n / total) * 100).toFixed(1)}%`;
}

// ─── Spec Analysis ──────────────────────────────────────────────────

interface SpecStats {
  version: string;
  build: string;
  moduleCount: number;
  objectCount: number;
  tableCount: number;
  objectTypeCount: number;
  commandCount: number;
  totalUrls: number;
  uniqueUrls: number;
  totalAttributes: number;
  uniqueAttributeNames: number;
  totalMethods: number;
  methodDistribution: Record<string, number>;
  urlPrefixDistribution: Record<string, number>;
  typeDistribution: Record<string, number>;
  modulesWithZeroObjects: string[];
  objectsWithZeroUrls: string[];
  objectsWithZeroAttributes: string[];
  attributeTypeDistribution: Record<string, number>;
  errorCodeCount: number;
  maxAttributesPerObject: { name: string; count: number };
  maxUrlsPerObject: { name: string; count: number };
  avgAttributesPerObject: number;
  avgUrlsPerObject: number;
}

function analyzeSpec(spec: FmgApiSpec): SpecStats {
  const allObjects: FmgObjectDef[] = spec.modules.flatMap((m) => m.objects);
  const allUrls = allObjects.flatMap((o) => o.urls.map((u) => u.path));
  const allAttrs = allObjects.flatMap((o) => o.attributes);

  // Method distribution
  const methodDist: Record<string, number> = {};
  for (const obj of allObjects) {
    for (const m of obj.methods) {
      methodDist[m] = (methodDist[m] ?? 0) + 1;
    }
  }

  // URL prefix distribution (first 2 segments)
  const urlPrefixDist: Record<string, number> = {};
  for (const url of allUrls) {
    const prefix = url.split('/').slice(0, 3).join('/');
    urlPrefixDist[prefix] = (urlPrefixDist[prefix] ?? 0) + 1;
  }

  // Type distribution
  const typeDist: Record<string, number> = {};
  for (const obj of allObjects) {
    typeDist[obj.type] = (typeDist[obj.type] ?? 0) + 1;
  }

  // Attribute type distribution
  const attrTypeDist: Record<string, number> = {};
  function countAttrTypes(attrs: FmgAttributeDef[]): void {
    for (const a of attrs) {
      attrTypeDist[a.type] = (attrTypeDist[a.type] ?? 0) + 1;
      if (a.children) countAttrTypes(a.children);
    }
  }
  countAttrTypes(allAttrs);

  // Extremes
  let maxAttrs = { name: '', count: 0 };
  let maxUrls = { name: '', count: 0 };
  for (const obj of allObjects) {
    if (obj.attributes.length > maxAttrs.count) {
      maxAttrs = { name: obj.name, count: obj.attributes.length };
    }
    if (obj.urls.length > maxUrls.count) {
      maxUrls = { name: obj.name, count: obj.urls.length };
    }
  }

  const uniqueAttrNames = new Set(allAttrs.map((a) => a.name));

  return {
    version: spec.version,
    build: spec.build,
    moduleCount: spec.modules.length,
    objectCount: allObjects.length,
    tableCount: allObjects.filter((o) => o.type === 'table').length,
    objectTypeCount: allObjects.filter((o) => o.type === 'object').length,
    commandCount: allObjects.filter((o) => o.type === 'command').length,
    totalUrls: allUrls.length,
    uniqueUrls: new Set(allUrls).size,
    totalAttributes: allAttrs.length,
    uniqueAttributeNames: uniqueAttrNames.size,
    totalMethods: Object.values(methodDist).reduce((a, b) => a + b, 0),
    methodDistribution: methodDist,
    urlPrefixDistribution: urlPrefixDist,
    typeDistribution: typeDist,
    modulesWithZeroObjects: spec.modules.filter((m) => m.objects.length === 0).map((m) => m.name),
    objectsWithZeroUrls: allObjects.filter((o) => o.urls.length === 0).map((o) => o.name),
    objectsWithZeroAttributes: allObjects
      .filter((o) => o.attributes.length === 0)
      .map((o) => o.name)
      .slice(0, 20),
    attributeTypeDistribution: attrTypeDist,
    errorCodeCount: spec.errors.length,
    maxAttributesPerObject: maxAttrs,
    maxUrlsPerObject: maxUrls,
    avgAttributesPerObject:
      allObjects.length > 0 ? Math.round(allAttrs.length / allObjects.length) : 0,
    avgUrlsPerObject:
      allObjects.length > 0 ? Math.round((allUrls.length / allObjects.length) * 10) / 10 : 0,
  };
}

function printSpecReport(stats: SpecStats): void {
  heading(`Spec Coverage Report — v${stats.version} (build ${stats.build})`);

  console.log('\n─── Overview ───');
  row('Modules', stats.moduleCount);
  row('Objects (total)', stats.objectCount);
  row('  Tables', stats.tableCount);
  row('  Objects (singleton)', stats.objectTypeCount);
  row('  Commands', stats.commandCount);
  row('URLs (total)', stats.totalUrls);
  row('URLs (unique)', stats.uniqueUrls);
  row('Attributes (total)', stats.totalAttributes);
  row('Attribute names (unique)', stats.uniqueAttributeNames);
  row('Error codes', stats.errorCodeCount);

  console.log('\n─── Averages & Extremes ───');
  row('Avg attributes / object', stats.avgAttributesPerObject);
  row('Avg URLs / object', stats.avgUrlsPerObject);
  row(
    'Max attributes',
    `${stats.maxAttributesPerObject.count} (${stats.maxAttributesPerObject.name})`,
  );
  row('Max URLs', `${stats.maxUrlsPerObject.count} (${stats.maxUrlsPerObject.name})`);

  console.log('\n─── Method Distribution ───');
  const sortedMethods = Object.entries(stats.methodDistribution).sort((a, b) => b[1] - a[1]);
  for (const [method, count] of sortedMethods) {
    row(method, `${count} (${pct(count, stats.objectCount)})`);
  }

  console.log('\n─── Object Type Distribution ───');
  for (const [type, count] of Object.entries(stats.typeDistribution)) {
    row(type, `${count} (${pct(count, stats.objectCount)})`);
  }

  console.log('\n─── Attribute Type Distribution (top 15) ───');
  const sortedAttrTypes = Object.entries(stats.attributeTypeDistribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  for (const [type, count] of sortedAttrTypes) {
    row(type, `${count} (${pct(count, stats.totalAttributes)})`);
  }

  console.log('\n─── URL Prefix Distribution (top 10) ───');
  const sortedPrefixes = Object.entries(stats.urlPrefixDistribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [prefix, count] of sortedPrefixes) {
    row(prefix, `${count} (${pct(count, stats.totalUrls)})`);
  }

  if (stats.modulesWithZeroObjects.length > 0) {
    console.log('\n─── Modules with 0 objects ───');
    for (const name of stats.modulesWithZeroObjects) {
      console.log(`  - ${name}`);
    }
  }

  if (stats.objectsWithZeroUrls.length > 0) {
    console.log('\n─── ⚠ Objects with 0 URLs ───');
    for (const name of stats.objectsWithZeroUrls) {
      console.log(`  - ${name}`);
    }
  }
}

// ─── Live Validation ────────────────────────────────────────────────

interface ValidationResult {
  url: string;
  objectName: string;
  method: string;
  statusCode: number;
  statusMessage: string;
  valid: boolean;
  responseHasData: boolean;
}

/**
 * Select a stratified random sample of URLs from the spec.
 * Ensures coverage across URL prefixes, not just random picks.
 */
function selectSample(spec: FmgApiSpec, sampleSize: number): { url: string; objectName: string }[] {
  const allObjects = spec.modules.flatMap((m) => m.objects);

  // Collect all concrete URLs (replace template vars with "root" or similar)
  const candidates: { url: string; objectName: string; prefix: string }[] = [];
  for (const obj of allObjects) {
    for (const u of obj.urls) {
      // Replace ADOM placeholder with "root" for probing
      const concreteUrl = u.path.replace(/<adom_name>/g, 'root').replace(/<pkg_path>/g, 'default');
      // Only include "table" URLs (listing endpoints), skip object-level URLs with named params
      // because those would require a specific object name to exist
      const hasNamedParam = /<[^>]+>/.test(concreteUrl);
      if (!hasNamedParam) {
        const prefix = concreteUrl.split('/').slice(0, 3).join('/');
        candidates.push({ url: concreteUrl, objectName: obj.name, prefix });
      }
    }
  }

  if (candidates.length <= sampleSize) return candidates;

  // Stratified sampling: group by prefix, take proportional samples
  const byPrefix = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const group = byPrefix.get(c.prefix) ?? [];
    group.push(c);
    byPrefix.set(c.prefix, group);
  }

  const result: { url: string; objectName: string }[] = [];
  const prefixes = [...byPrefix.keys()].sort();

  // Allocate per-prefix quota proportionally
  for (const prefix of prefixes) {
    const group = byPrefix.get(prefix)!;
    const quota = Math.max(1, Math.round((group.length / candidates.length) * sampleSize));
    // Shuffle and take quota
    const shuffled = group.sort(() => Math.random() - 0.5);
    for (let i = 0; i < Math.min(quota, shuffled.length) && result.length < sampleSize; i++) {
      result.push({ url: shuffled[i].url, objectName: shuffled[i].objectName });
    }
  }

  return result;
}

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
async function validateUrls(
  client: FmgClient,
  spec: FmgApiSpec,
  sampleSize: number,
): Promise<void> {
  heading('Live Validation');

  const FMG_HOST = process.env['FMG_HOST']!;
  const health = await client.checkHealth();
  console.log(`\nTarget: ${FMG_HOST}`);
  console.log(`FMG Version: ${health.version}`);
  console.log(`Spec Version: ${spec.version}`);

  const sample = selectSample(spec, sampleSize);
  console.log(
    `\nProbing ${sample.length} URLs (from ${spec.modules.flatMap((m) => m.objects).flatMap((o) => o.urls).length} total)...`,
  );

  const results: ValidationResult[] = [];
  let okCount = 0;
  let permDenied = 0;
  let invalidUrl = 0;
  let otherError = 0;
  let hasData = 0;

  const startMs = Date.now();

  for (let i = 0; i < sample.length; i++) {
    const { url, objectName } = sample[i];

    try {
      const response = await client.rawRequest<Record<string, unknown>>('get', [{ url }]);
      const result = response.result[0];
      const code: number = result?.status?.code ?? -999;
      const msg: string = result?.status?.message ?? 'unknown';
      const valid = code === 0 || code === -11; // 0 = OK, -11 = no permission (URL itself is valid)
      const respHasData = result?.data !== undefined && result?.data !== null;

      results.push({
        url,
        objectName,
        method: 'get',
        statusCode: code,
        statusMessage: msg,
        valid,
        responseHasData: respHasData,
      });

      if (code === 0) {
        okCount++;
        if (respHasData) hasData++;
      } else if (code === -11) {
        permDenied++;
      } else if (code === -6) {
        invalidUrl++;
      } else {
        otherError++;
      }
    } catch (err: unknown) {
      const msg: string = err instanceof Error ? err.message : String(err);
      const statusCode: number = err instanceof FmgApiError ? err.statusCode : -999;
      const isPermDenied: boolean = statusCode === -11;
      const isInvalidUrl: boolean = statusCode === -6;

      results.push({
        url,
        objectName,
        method: 'get',
        statusCode,
        statusMessage: msg.slice(0, 100),
        valid: isPermDenied, // -11 means URL is valid, just no permission
        responseHasData: false,
      });

      if (isPermDenied) permDenied++;
      else if (isInvalidUrl) invalidUrl++;
      else otherError++;
    }

    // Progress indicator
    if ((i + 1) % 25 === 0 || i === sample.length - 1) {
      process.stdout.write(`\r  Progress: ${i + 1}/${sample.length}`);
    }
  }

  const durationMs = Date.now() - startMs;
  console.log('');

  // ─── Summary ────────────────────────────────────────────────────
  const validCount = okCount + permDenied;
  const invalidCount = invalidUrl + otherError;

  console.log('\n─── Validation Summary ───');
  row('URLs probed', sample.length);
  row('Valid (200 OK)', okCount);
  row('Valid (permission denied, -11)', permDenied);
  row('Invalid URL (-6)', invalidUrl);
  row('Other errors', otherError);
  row('─────────────────────────────', '──────');
  row('Valid total', `${validCount} (${pct(validCount, sample.length)})`);
  row('Invalid total', `${invalidCount} (${pct(invalidCount, sample.length)})`);
  row('With data', hasData);
  row('Duration', `${durationMs}ms (${(durationMs / sample.length).toFixed(0)}ms/req)`);

  // ─── Discrepancies ─────────────────────────────────────────────
  const discrepancies = results.filter((r) => !r.valid);
  if (discrepancies.length > 0) {
    console.log(`\n─── ⚠ Discrepancies (${discrepancies.length}) ───`);
    // Group by status code
    const byCode = new Map<number, ValidationResult[]>();
    for (const d of discrepancies) {
      const group = byCode.get(d.statusCode) ?? [];
      group.push(d);
      byCode.set(d.statusCode, group);
    }
    for (const [code, items] of [...byCode.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(`\n  Status ${code} (${items[0].statusMessage}):`);
      for (const item of items.slice(0, 10)) {
        console.log(`    ${item.objectName}`);
        console.log(`      URL: ${item.url}`);
      }
      if (items.length > 10) {
        console.log(`    ... and ${items.length - 10} more`);
      }
    }
  } else {
    console.log('\n  ✓ No discrepancies — all probed URLs are valid on live FMG');
  }

  // ─── Per-prefix breakdown ─────────────────────────────────────
  console.log('\n─── Per-Prefix Validation ───');
  const byPrefix = new Map<string, { valid: number; invalid: number }>();
  for (const r of results) {
    const prefix = r.url.split('/').slice(0, 3).join('/');
    const entry = byPrefix.get(prefix) ?? { valid: 0, invalid: 0 };
    if (r.valid) entry.valid++;
    else entry.invalid++;
    byPrefix.set(prefix, entry);
  }
  for (const [prefix, counts] of [...byPrefix.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const total = counts.valid + counts.invalid;
    const status = counts.invalid === 0 ? '✓' : '⚠';
    row(`${status} ${prefix}`, `${counts.valid}/${total} valid`);
  }
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment */

// ─── Cross-Spec Comparison ──────────────────────────────────────────

function compareSpecs(stats74: SpecStats, stats76: SpecStats): void {
  heading('Spec Comparison: v7.4 vs v7.6');

  const fields: [string, keyof SpecStats][] = [
    ['Modules', 'moduleCount'],
    ['Objects', 'objectCount'],
    ['Tables', 'tableCount'],
    ['Objects (singleton)', 'objectTypeCount'],
    ['Commands', 'commandCount'],
    ['URLs (total)', 'totalUrls'],
    ['URLs (unique)', 'uniqueUrls'],
    ['Attributes (total)', 'totalAttributes'],
    ['Attribute names (unique)', 'uniqueAttributeNames'],
    ['Error codes', 'errorCodeCount'],
  ];

  console.log(
    `\n  ${'Metric'.padEnd(35)} ${'v7.4'.padStart(8)} ${'v7.6'.padStart(8)} ${'Δ'.padStart(8)} ${'%'.padStart(8)}`,
  );
  console.log(
    `  ${'─'.repeat(35)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)}`,
  );

  for (const [label, key] of fields) {
    const v74 = stats74[key] as number;
    const v76 = stats76[key] as number;
    const delta = v76 - v74;
    const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
    const pctStr = v74 > 0 ? `${((delta / v74) * 100).toFixed(1)}%` : 'N/A';
    console.log(
      `  ${label.padEnd(35)} ${String(v74).padStart(8)} ${String(v76).padStart(8)} ${deltaStr.padStart(8)} ${pctStr.padStart(8)}`,
    );
  }
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║  FortiManager API Spec — Coverage & Validation      ║');
  console.log('╚═══════════════════════════════════════════════════════╝');

  // Load requested spec
  const specPath = `src/spec/fmg-api-spec-${SPEC_VERSION}.json`;
  console.log(`\nLoading spec: ${specPath}...`);
  const spec: FmgApiSpec = JSON.parse(readFileSync(specPath, 'utf8')) as FmgApiSpec;

  const stats = analyzeSpec(spec);
  printSpecReport(stats);

  // Try loading the other version for comparison
  const otherVersion = SPEC_VERSION === '7.6' ? '7.4' : '7.6';
  const otherPath = `src/spec/fmg-api-spec-${otherVersion}.json`;
  try {
    const otherSpec: FmgApiSpec = JSON.parse(readFileSync(otherPath, 'utf8')) as FmgApiSpec;
    const otherStats = analyzeSpec(otherSpec);

    if (SPEC_VERSION === '7.6') {
      compareSpecs(otherStats, stats);
    } else {
      compareSpecs(stats, otherStats);
    }
  } catch {
    console.log(`\n  (Skipping comparison — ${otherPath} not found)`);
  }

  // Live validation if requested
  if (VALIDATE) {
    const FMG_HOST = process.env['FMG_HOST'];
    const FMG_API_TOKEN = process.env['FMG_API_TOKEN'];
    if (!FMG_HOST || !FMG_API_TOKEN) {
      console.error('\n✗ --validate requires FMG_HOST and FMG_API_TOKEN in .env');
      process.exit(1);
    }

    const client = new FmgClient({
      host: FMG_HOST,
      port: Number(process.env['FMG_PORT'] ?? '443'),
      apiToken: FMG_API_TOKEN,
      verifySsl: process.env['FMG_VERIFY_SSL'] !== 'false',
    });

    await validateUrls(client, spec, SAMPLE_SIZE);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
