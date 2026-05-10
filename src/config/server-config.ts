/**
 * @fileoverview Server-specific configuration parsed from environment
 * variables. The schema is the single source of truth for ntfy connection
 * settings; the framework's core config covers transport / auth / storage.
 *
 * Two configuration shapes are supported:
 *  - `NTFY_SERVERS` — JSON array of `{ baseUrl, authToken? | authUsername?+authPassword? }`
 *    entries. First entry is the default base used when a tool call omits
 *    `base_url`. Auth credentials are scoped to the specific base they were
 *    declared with; per-call `base_url` overrides that match a registered
 *    base forward that base's auth, anything else goes out unauthenticated.
 *  - Single-server shorthand (`NTFY_BASE_URL`, `NTFY_AUTH_TOKEN`,
 *    `NTFY_AUTH_USERNAME`, `NTFY_AUTH_PASSWORD`) — convenience for the
 *    common one-server case, expressed internally as a single-entry registry.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { configurationError } from '@cyanheads/mcp-ts-core/errors';

const NtfyServerEntrySchema = z
  .object({
    baseUrl: z
      .string()
      .url()
      .transform((u) => u.replace(/\/+$/, ''))
      .describe('Base URL of the ntfy server (no trailing slash).'),
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
  })
  .superRefine((entry, ctx) => {
    const hasToken = Boolean(entry.authToken);
    const hasUser = Boolean(entry.authUsername);
    const hasPass = Boolean(entry.authPassword);
    if (hasToken && (hasUser || hasPass)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'A bearer token and basic auth (username/password) are mutually exclusive — set one or the other.',
        path: ['authToken'],
      });
    }
    if (hasUser !== hasPass) {
      ctx.addIssue({
        code: 'custom',
        message: 'Basic auth requires both a username and a password.',
        path: hasUser ? ['authPassword'] : ['authUsername'],
      });
    }
  });

export type NtfyServerEntry = z.infer<typeof NtfyServerEntrySchema>;

const ServerConfigSchema = z.object({
  servers: z
    .array(NtfyServerEntrySchema)
    .min(1)
    .superRefine((arr, ctx) => {
      const seen = new Set<string>();
      for (let i = 0; i < arr.length; i++) {
        const base = arr[i]?.baseUrl;
        if (base === undefined) continue;
        if (seen.has(base)) {
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate server baseUrl: ${base}`,
            path: [i, 'baseUrl'],
          });
        }
        seen.add(base);
      }
    }),
  defaultTopic: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional()
    .describe('Topic used when a tool call omits topic.'),
  requestTimeoutMs: z.coerce.number().int().positive().default(15_000),
  maxRetries: z.coerce.number().int().min(0).default(3),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= loadFromEnv(typeof process !== 'undefined' ? process.env : {});
  return _config;
}

/** Test/setup hook — drop the cached parse so the next call re-reads `process.env`. */
export function resetServerConfig(): void {
  _config = undefined;
}

interface RawEnv {
  /** 1.x alias for NTFY_AUTH_TOKEN. Accepted with a deprecation warning. */
  NTFY_API_KEY?: string | undefined;
  NTFY_AUTH_PASSWORD?: string | undefined;
  NTFY_AUTH_TOKEN?: string | undefined;
  NTFY_AUTH_USERNAME?: string | undefined;
  NTFY_BASE_URL?: string | undefined;
  NTFY_DEFAULT_TOPIC?: string | undefined;
  NTFY_MAX_RETRIES?: string | undefined;
  NTFY_REQUEST_TIMEOUT_MS?: string | undefined;
  NTFY_SERVERS?: string | undefined;
}

function loadFromEnv(env: RawEnv | NodeJS.ProcessEnv): ServerConfig {
  const serversInput = env.NTFY_SERVERS
    ? parseServersJson(env.NTFY_SERVERS)
    : [singleServerFromEnv(env)];

  const result = ServerConfigSchema.safeParse({
    servers: serversInput,
    defaultTopic: env.NTFY_DEFAULT_TOPIC,
    requestTimeoutMs: env.NTFY_REQUEST_TIMEOUT_MS,
    maxRetries: env.NTFY_MAX_RETRIES,
  });

  if (!result.success) {
    throw configurationError(formatIssues(result.error.issues, env));
  }
  return result.data;
}

function parseServersJson(raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw configurationError(
      `NTFY_SERVERS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw configurationError('NTFY_SERVERS must be a JSON array of server entries.');
  }
  return parsed;
}

function singleServerFromEnv(env: RawEnv | NodeJS.ProcessEnv): Record<string, unknown> {
  const authToken = env.NTFY_AUTH_TOKEN ?? env.NTFY_API_KEY;
  if (!env.NTFY_AUTH_TOKEN && env.NTFY_API_KEY) {
    warnDeprecatedApiKey();
  }
  return {
    baseUrl: env.NTFY_BASE_URL ?? 'https://ntfy.sh',
    ...(authToken ? { authToken } : {}),
    ...(env.NTFY_AUTH_USERNAME ? { authUsername: env.NTFY_AUTH_USERNAME } : {}),
    ...(env.NTFY_AUTH_PASSWORD ? { authPassword: env.NTFY_AUTH_PASSWORD } : {}),
  };
}

/**
 * Emits a one-shot stderr warning when the deprecated 1.x `NTFY_API_KEY` env
 * var supplies the bearer token. Goes to stderr because config parsing runs
 * before the framework logger is initialized.
 */
function warnDeprecatedApiKey(): void {
  if (typeof process === 'undefined') return;
  process.stderr.write(
    '[ntfy-mcp-server] NTFY_API_KEY is deprecated; rename to NTFY_AUTH_TOKEN to silence this warning.\n',
  );
}

function formatIssues(issues: z.ZodIssue[], env: RawEnv | NodeJS.ProcessEnv): string {
  const usingRegistry = Boolean(env.NTFY_SERVERS);
  const lines = issues.map((issue) => {
    const path = issue.path.join('.');
    const envVar = usingRegistry
      ? envVarForRegistryPath(issue.path)
      : envVarForSingleServerPath(path);
    return envVar ? `  - ${envVar} (${path}): ${issue.message}` : `  - ${path}: ${issue.message}`;
  });
  return `Server config validation failed:\n${lines.join('\n')}`;
}

function envVarForSingleServerPath(path: string): string | undefined {
  switch (path) {
    case 'servers.0.baseUrl':
      return 'NTFY_BASE_URL';
    case 'servers.0.authToken':
      return 'NTFY_AUTH_TOKEN';
    case 'servers.0.authUsername':
      return 'NTFY_AUTH_USERNAME';
    case 'servers.0.authPassword':
      return 'NTFY_AUTH_PASSWORD';
    case 'defaultTopic':
      return 'NTFY_DEFAULT_TOPIC';
    case 'requestTimeoutMs':
      return 'NTFY_REQUEST_TIMEOUT_MS';
    case 'maxRetries':
      return 'NTFY_MAX_RETRIES';
    default:
      return;
  }
}

function envVarForRegistryPath(path: readonly PropertyKey[]): string | undefined {
  if (path[0] === 'servers') {
    const idx = String(path[1]);
    const rest = path.slice(2).map(String).join('.');
    return `NTFY_SERVERS[${idx}].${rest}`;
  }
  return envVarForSingleServerPath(path.map(String).join('.'));
}
