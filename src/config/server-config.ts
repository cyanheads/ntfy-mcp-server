/**
 * @fileoverview Server-specific configuration parsed from environment
 * variables. The schema is the single source of truth for ntfy connection
 * settings; the framework's core config covers transport / auth / storage.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z
  .object({
    baseUrl: z
      .string()
      .url()
      .default('https://ntfy.sh')
      .transform((u) => u.replace(/\/+$/, ''))
      .describe('Base URL of the ntfy server (no trailing slash).'),
    defaultTopic: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional()
      .describe('Topic used when a tool call omits topic.'),
    authToken: z
      .string()
      .min(1)
      .optional()
      .describe('Bearer access token (mutually exclusive with username/password).'),
    authUsername: z
      .string()
      .min(1)
      .optional()
      .describe('Basic auth username (paired with authPassword).'),
    authPassword: z
      .string()
      .min(1)
      .optional()
      .describe('Basic auth password (paired with authUsername).'),
    requestTimeoutMs: z.coerce.number().int().positive().default(15_000),
    maxRetries: z.coerce.number().int().min(0).default(3),
  })
  .superRefine((cfg, ctx) => {
    const hasToken = Boolean(cfg.authToken);
    const hasUser = Boolean(cfg.authUsername);
    const hasPass = Boolean(cfg.authPassword);
    if (hasToken && (hasUser || hasPass)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'NTFY_AUTH_TOKEN is mutually exclusive with NTFY_AUTH_USERNAME / NTFY_AUTH_PASSWORD — set one mode only.',
        path: ['authToken'],
      });
    }
    if (hasUser !== hasPass) {
      ctx.addIssue({
        code: 'custom',
        message: 'NTFY_AUTH_USERNAME and NTFY_AUTH_PASSWORD must be set together for basic auth.',
        path: hasUser ? ['authPassword'] : ['authUsername'],
      });
    }
  });

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'NTFY_BASE_URL',
    defaultTopic: 'NTFY_DEFAULT_TOPIC',
    authToken: 'NTFY_AUTH_TOKEN',
    authUsername: 'NTFY_AUTH_USERNAME',
    authPassword: 'NTFY_AUTH_PASSWORD',
    requestTimeoutMs: 'NTFY_REQUEST_TIMEOUT_MS',
    maxRetries: 'NTFY_MAX_RETRIES',
  });
  return _config;
}

/** Test/setup hook — drop the cached parse so the next call re-reads `process.env`. */
export function resetServerConfig(): void {
  _config = undefined;
}
