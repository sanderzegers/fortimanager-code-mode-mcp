/**
 * Unit Tests — SearchExecutor (QuickJS sandbox with API spec)
 *
 * Tests the search executor with a minimal sample spec.
 * Validates spec index querying, getObject(), console capture, error handling.
 */

import { describe, it, expect } from 'vitest';
import { SearchExecutor } from '../executor/search-executor.js';
import { SAMPLE_SPEC } from './fixtures/index.js';

// ─── Setup ──────────────────────────────────────────────────────────

// Use shorter timeout for tests
const executor = new SearchExecutor(SAMPLE_SPEC, {
  timeoutMs: 5_000,
  maxMemoryBytes: 16 * 1024 * 1024,
});

// ─── Tests ──────────────────────────────────────────────────────────

describe('SearchExecutor', () => {
  describe('basic execution', () => {
    it('evaluates a simple expression', async () => {
      const result = await executor.execute('1 + 2');

      expect(result.ok).toBe(true);
      expect(result.data).toBe(3);
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it('returns undefined for statements', async () => {
      const result = await executor.execute('var x = 42;');

      expect(result.ok).toBe(true);
      expect(result.data).toBeUndefined();
    });

    it('handles string return values', async () => {
      const result = await executor.execute('"hello"');

      expect(result.ok).toBe(true);
      expect(result.data).toBe('hello');
    });
  });

  describe('specIndex global', () => {
    it('specIndex is available and populated', async () => {
      const result = await executor.execute('specIndex.length');

      expect(result.ok).toBe(true);
      expect(result.data).toBe(3); // sys/status + firewall/address + firewall/addrgrp
    });

    it('can filter specIndex by name', async () => {
      const result = await executor.execute(
        'specIndex.filter(o => o.name.includes("firewall")).map(o => o.name)',
      );

      expect(result.ok).toBe(true);
      expect(result.data).toEqual(['firewall/address', 'firewall/addrgrp']);
    });

    it('index entries have expected shape', async () => {
      const result = await executor.execute('specIndex.find(o => o.name === "firewall/address")');

      expect(result.ok).toBe(true);
      const entry = result.data as Record<string, unknown>;
      expect(entry['name']).toBe('firewall/address');
      expect(entry['type']).toBe('table');
      expect(entry['module']).toBe('firewall');
      expect(entry['urls']).toContain('/pm/config/adom/{adom}/obj/firewall/address');
      expect(entry['methods']).toContain('get');
      expect(entry['methods']).toContain('add');
      expect(entry['attributeNames']).toContain('name');
      expect(entry['attributeNames']).toContain('subnet');
    });

    it('can search by attribute name', async () => {
      const result = await executor.execute(
        'specIndex.filter(o => o.attributeNames.includes("subnet")).map(o => o.name)',
      );

      expect(result.ok).toBe(true);
      expect(result.data).toEqual(['firewall/address']);
    });

    it('can search by URL pattern', async () => {
      const result = await executor.execute(
        'specIndex.filter(o => o.urls.some(u => u.includes("/adom/"))).map(o => o.name)',
      );

      expect(result.ok).toBe(true);
      expect(result.data).toEqual(['firewall/address', 'firewall/addrgrp']);
    });
  });

  describe('getObject()', () => {
    it('retrieves full object details by name', async () => {
      const result = await executor.execute('getObject("firewall/address")');

      expect(result.ok).toBe(true);
      const obj = result.data as Record<string, unknown>;
      expect(obj['name']).toBe('firewall/address');
      expect(obj['type']).toBe('table');
      expect(obj['description']).toContain('IPv4 address');
      expect(obj['attributes']).toHaveLength(5);
    });

    it('retrieves object by URL path', async () => {
      const result = await executor.execute(
        'getObject("/pm/config/adom/{adom}/obj/firewall/address")',
      );

      expect(result.ok).toBe(true);
      const obj = result.data as Record<string, unknown>;
      expect(obj['name']).toBe('firewall/address');
    });

    it('returns null for non-existent object', async () => {
      const result = await executor.execute('getObject("does/not/exist")');

      expect(result.ok).toBe(true);
      expect(result.data).toBeNull();
    });
  });

  describe('specVersion', () => {
    it('exposes the spec version string', async () => {
      const result = await executor.execute('specVersion');

      expect(result.ok).toBe(true);
      expect(result.data).toBe('7.6');
    });
  });

  describe('moduleList', () => {
    it('lists all modules', async () => {
      const result = await executor.execute('moduleList');

      expect(result.ok).toBe(true);
      const modules = result.data as Array<Record<string, unknown>>;
      expect(modules).toHaveLength(2);
      expect(modules[0]!['name']).toBe('sys');
      expect(modules[1]!['name']).toBe('firewall');
    });

    it('modules have object and method counts', async () => {
      const result = await executor.execute('moduleList.find(m => m.name === "firewall")');

      expect(result.ok).toBe(true);
      const mod = result.data as Record<string, unknown>;
      expect(mod['objectCount']).toBe(2);
      expect(mod['methodCount']).toBe(5);
    });
  });

  describe('errorCodes', () => {
    it('exposes error codes array', async () => {
      const result = await executor.execute('errorCodes');

      expect(result.ok).toBe(true);
      const errors = result.data as Array<Record<string, unknown>>;
      expect(errors).toHaveLength(4);
      expect(errors[0]).toEqual({ code: 0, message: 'Success' });
    });
  });

  describe('console capture', () => {
    it('captures console.log output', async () => {
      const result = await executor.execute('console.log("hello from sandbox"); 42');

      expect(result.ok).toBe(true);
      expect(result.data).toBe(42);
      expect(result.logs).toHaveLength(1);
      expect(result.logs[0]!.level).toBe('log');
      expect(result.logs[0]!.message).toBe('hello from sandbox');
    });

    it('captures multiple log levels', async () => {
      const result = await executor.execute(`
        console.log("info msg");
        console.warn("warn msg");
        console.error("error msg");
        true
      `);

      expect(result.ok).toBe(true);
      expect(result.logs).toHaveLength(3);
      expect(result.logs[0]!.level).toBe('log');
      expect(result.logs[1]!.level).toBe('warn');
      expect(result.logs[2]!.level).toBe('error');
    });

    it('stringifies objects in console.log', async () => {
      const result = await executor.execute('console.log({ key: "value" }); null');

      expect(result.ok).toBe(true);
      expect(result.logs[0]!.message).toContain('"key"');
      expect(result.logs[0]!.message).toContain('"value"');
    });
  });

  describe('error handling', () => {
    it('returns error for syntax errors', async () => {
      const result = await executor.execute('function {{{');

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns error for runtime exceptions', async () => {
      const result = await executor.execute('throw new Error("boom")');

      expect(result.ok).toBe(false);
      expect(result.error).toContain('boom');
    });

    it('returns error for reference errors', async () => {
      const result = await executor.execute('nonExistentVariable');

      expect(result.ok).toBe(false);
      expect(result.error).toContain('not defined');
    });
  });

  describe('sandbox isolation', () => {
    it('does not have access to Node.js globals', async () => {
      const result = await executor.execute('typeof process');

      expect(result.ok).toBe(true);
      expect(result.data).toBe('undefined');
    });

    it('does not have access to require', async () => {
      const result = await executor.execute('typeof require');

      expect(result.ok).toBe(true);
      expect(result.data).toBe('undefined');
    });

    it('does not leak state between executions', async () => {
      await executor.execute('var testGlobal = 999;');
      const result = await executor.execute('typeof testGlobal');

      expect(result.ok).toBe(true);
      expect(result.data).toBe('undefined');
    });
  });
});
