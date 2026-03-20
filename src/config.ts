/**
 * Configuration — Environment variable loading and validation
 *
 * Uses Zod for runtime validation of all environment variables.
 */

import { z } from 'zod';

// ─── Schema ─────────────────────────────────────────────────────────

const configSchema = z.object({
  /** FortiManager host URL */
  fmgHost: z.string().url('FMG_HOST must be a valid URL (e.g., https://fmg.example.com)'),

  /** FortiManager HTTPS port */
  fmgPort: z.coerce.number().int().min(1).max(65535).default(443),

  /** API token for authentication */
  fmgApiToken: z.string().min(1, 'FMG_API_TOKEN is required'),

  /** Whether to verify TLS certificates */
  fmgVerifySsl: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /** API spec version to use */
  fmgApiVersion: z.enum(['7.4', '7.6']).default('7.6'),

  /** MCP transport mode */
  mcpTransport: z.enum(['http', 'stdio']).default('stdio'),

  /** HTTP server port (only for http transport) */
  mcpHttpPort: z.coerce.number().int().min(1).max(65535).default(8000),

  /** Optional Bearer token required on all HTTP MCP requests (recommended for HTTP transport) */
  mcpAuthToken: z.string().min(1).optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

// ─── Loader ─────────────────────────────────────────────────────────

/**
 * Load and validate configuration from environment variables.
 * Throws a descriptive error if validation fails.
 */
export function loadConfig(): AppConfig {
  const result = configSchema.safeParse({
    fmgHost: process.env['FMG_HOST'],
    fmgPort: process.env['FMG_PORT'],
    fmgApiToken: process.env['FMG_API_TOKEN'],
    fmgVerifySsl: process.env['FMG_VERIFY_SSL'],
    fmgApiVersion: process.env['FMG_API_VERSION'],
    mcpTransport: process.env['MCP_TRANSPORT'],
    mcpHttpPort: process.env['MCP_HTTP_PORT'],
    mcpAuthToken: process.env['MCP_AUTH_TOKEN'],
  });

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${issues}`);
  }

  return result.data;
}
