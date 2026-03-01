/**
 * Test Fixtures — Sample data for unit and integration tests.
 */

import type { FmgApiSpec } from '../../types/spec-types.js';
import type { JsonRpcResponse } from '../../client/types.js';

// ─── Minimal API Spec ───────────────────────────────────────────────

/**
 * A small API spec with 2 modules, a few objects, and some error codes.
 * Used by SearchExecutor and MCP server integration tests.
 */
export const SAMPLE_SPEC: FmgApiSpec = {
  version: '7.6',
  build: '0001',
  generatedAt: '2026-01-01T00:00:00.000Z',
  modules: [
    {
      name: 'sys',
      title: 'System',
      methods: [
        { id: 'get', description: 'Retrieve objects' },
        { id: 'exec', description: 'Execute commands' },
      ],
      objects: [
        {
          name: 'sys/status',
          type: 'object',
          description: 'System status information including version and hostname.',
          urls: [{ path: '/sys/status', methods: ['get'] }],
          methods: ['get'],
          attributes: [
            {
              name: 'Version',
              type: 'string',
              description: 'FortiManager version',
              required: false,
            },
            {
              name: 'Hostname',
              type: 'string',
              description: 'FortiManager hostname',
              required: false,
            },
            {
              name: 'Serial Number',
              type: 'string',
              description: 'Unit serial number',
              required: false,
            },
          ],
        },
      ],
    },
    {
      name: 'firewall',
      title: 'Firewall Objects',
      methods: [
        { id: 'get', description: 'Retrieve objects' },
        { id: 'add', description: 'Create objects' },
        { id: 'set', description: 'Replace objects' },
        { id: 'update', description: 'Partially update objects' },
        { id: 'delete', description: 'Delete objects' },
      ],
      objects: [
        {
          name: 'firewall/address',
          type: 'table',
          description: 'IPv4 address objects used in firewall policies.',
          urls: [
            {
              path: '/pm/config/adom/{adom}/obj/firewall/address',
              methods: ['get', 'add', 'set', 'update', 'delete'],
            },
            {
              path: '/pm/config/global/obj/firewall/address',
              methods: ['get', 'add', 'set', 'update', 'delete'],
            },
          ],
          methods: ['get', 'add', 'set', 'update', 'delete'],
          attributes: [
            { name: 'name', type: 'string', description: 'Address name', required: true },
            { name: 'subnet', type: 'array', description: 'IP/Netmask pair', required: false },
            { name: 'type', type: 'integer', description: 'Address type', required: false },
            { name: 'comment', type: 'string', description: 'Comment', required: false },
            {
              name: 'associated-interface',
              type: 'string',
              description: 'Associated interface',
              required: false,
            },
          ],
        },
        {
          name: 'firewall/addrgrp',
          type: 'table',
          description: 'Firewall address groups.',
          urls: [
            {
              path: '/pm/config/adom/{adom}/obj/firewall/addrgrp',
              methods: ['get', 'add', 'set', 'update', 'delete'],
            },
          ],
          methods: ['get', 'add', 'set', 'update', 'delete'],
          attributes: [
            { name: 'name', type: 'string', description: 'Group name', required: true },
            { name: 'member', type: 'array', description: 'Member addresses', required: true },
            { name: 'comment', type: 'string', description: 'Comment', required: false },
          ],
        },
      ],
    },
  ],
  errors: [
    { code: 0, message: 'Success' },
    { code: -2, message: 'Invalid URL' },
    { code: -6, message: 'No permission' },
    { code: -10, message: 'Object not found' },
  ],
};

// ─── Sample JSON-RPC Responses ──────────────────────────────────────

export function makeSuccessResponse<T>(id: number, url: string, data: T): JsonRpcResponse<T> {
  return {
    id,
    result: [
      {
        status: { code: 0, message: 'OK' },
        url,
        data,
      },
    ],
  };
}

export function makeErrorResponse(
  id: number,
  url: string,
  code: number,
  message: string,
): JsonRpcResponse {
  return {
    id,
    result: [
      {
        status: { code, message },
        url,
      },
    ],
  };
}

// ─── Client Config ──────────────────────────────────────────────────

export const SAMPLE_CLIENT_CONFIG = {
  host: 'https://fmg.example.com',
  port: 443,
  apiToken: 'test-api-token-12345',
  verifySsl: true,
} as const;
