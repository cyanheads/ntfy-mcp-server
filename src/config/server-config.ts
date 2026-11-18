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
 *
 * Credentials live in those auth fields only: a base URL carrying them
 * (`https://user:password@host`) fails startup, naming the fields to move them
 * to, and no startup message quotes a base URL.
 *
 * `NTFY_ENABLE_EMOJI_TAGS` is parsed on its own by `isEmojiTagsEnabled()`,
 * since it is read at module load rather than inside `createApp()`.
 * `NTFY_CLAMP_LIMITS` (`clampLimits`) is read through `getServerConfig()` on
 * every `tools/list` and every `limit` and `wait_seconds` parse (`limit-clamp.ts`), so `setup()`'s
 * own call is what fails startup on an invalid value.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { normalizeEnv, parseEnvConfig } from '@cyanheads/mcp-ts-core/config';
import { configurationError } from '@cyanheads/mcp-ts-core/errors';

import { withoutEmptyUserinfo, withoutTrailingSlashes } from '@/services/ntfy/base-url-guard.js';

/**
 * The `params.reason` of the issue an entry's `baseUrl` raises when it carries
 * credentials. The entry schema cannot tell which variable the entry came
 * from, so `formatIssues` words the fields to move them to.
 */
const CREDENTIALS_IN_URL = 'credentials_in_url';

/**
 * True for a URL that parses with a username or a password. One that does not
 * parse is `.url()`'s to report — Zod runs this check either way.
 */
function carriesCredentials(raw: string): boolean {
  const url = URL.parse(raw);
  return Boolean(url && (url.username || url.password));
}

const NtfyServerEntrySchema = z
  .object({
    baseUrl: z
      .string()
      .url()
      .refine((u) => !carriesCredentials(u), {
        message: 'The base URL carries credentials (user:password@).',
        params: { reason: CREDENTIALS_IN_URL },
      })
      .transform((u) => withoutEmptyUserinfo(withoutTrailingSlashes(u)))
      .describe('Base URL of the ntfy server (no trailing slash, no credentials).'),
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
    /**
     * Names the earlier entry, never the URL, so no startup message quotes a
     * base URL, whatever the entry's own checks found.
     */
    .superRefine((arr, ctx) => {
      const firstIndex = new Map<string, number>();
      for (let i = 0; i < arr.length; i++) {
        const base = arr[i]?.baseUrl;
        if (base === undefined) continue;
        const first = firstIndex.get(base);
        if (first !== undefined) {
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate server baseUrl: NTFY_SERVERS[${first}] registers the same base.`,
            path: [i, 'baseUrl'],
          });
        } else {
          firstIndex.set(base, i);
        }
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
  blockPrivateHosts: z
    .stringbool()
    .default(false)
    .describe(
      'When true, a per-call base_url override that is not a registered server must resolve to a public address, and its redirects are not followed.',
    ),
  clampLimits: z
    .stringbool()
    .default(true)
    .describe(
      "When true, a count above its per-call cap — a tool's `limit`, or `ntfy_fetch_messages`' `wait_seconds` (cap 40) — is served as the cap with a notice; when false, the schema advertises and enforces a maximum at the cap instead.",
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

const EmojiTagsFlagSchema = z.object({
  enabled: z
    .stringbool()
    .default(true)
    .describe('When false, `ntfy_search_emoji_tags` is disabled and no other surface names it.'),
});

let _config: ServerConfig | undefined;
let _emojiTagsEnabled: boolean | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= loadFromEnv(typeof process !== 'undefined' ? process.env : {});
  return _config;
}

/**
 * Whether `ntfy_search_emoji_tags` is offered (`NTFY_ENABLE_EMOJI_TAGS`,
 * default `true`). Parsed apart from `getServerConfig()` because definition
 * modules read it at load, before `createApp()` can render a
 * `ConfigurationError` as the startup banner — so an invalid value of any
 * other `NTFY_*` variable must not surface here. `parseEnvConfig` reads blank
 * and whole-value `${…}` placeholder values as unset, as `normalizeEnv` does.
 */
export function isEmojiTagsEnabled(): boolean {
  _emojiTagsEnabled ??= parseEnvConfig(EmojiTagsFlagSchema, {
    enabled: 'NTFY_ENABLE_EMOJI_TAGS',
  }).enabled;
  return _emojiTagsEnabled;
}

/** Test/setup hook — drop the cached parses so the next call re-reads `process.env`. */
export function resetServerConfig(): void {
  _config = undefined;
  _emojiTagsEnabled = undefined;
}

interface RawEnv {
  /** 1.x alias for NTFY_AUTH_TOKEN. Accepted with a deprecation warning. */
  NTFY_API_KEY?: string | undefined;
  NTFY_AUTH_PASSWORD?: string | undefined;
  NTFY_AUTH_TOKEN?: string | undefined;
  NTFY_AUTH_USERNAME?: string | undefined;
  NTFY_BASE_URL?: string | undefined;
  NTFY_BLOCK_PRIVATE_HOSTS?: string | undefined;
  NTFY_CLAMP_LIMITS?: string | undefined;
  NTFY_DEFAULT_TOPIC?: string | undefined;
  NTFY_MAX_RETRIES?: string | undefined;
  NTFY_REQUEST_TIMEOUT_MS?: string | undefined;
  NTFY_SERVERS?: string | undefined;
}

/**
 * Reads blank, whitespace-only, and whole-value `${…}` placeholder values as
 * unset — the rule the framework applies to its own config — so an optional
 * var stays unset and a defaulted one takes its default instead of failing
 * validation against the literal text an install host forwarded.
 */
function loadFromEnv(rawEnv: Record<string, string | undefined>): ServerConfig {
  const env: RawEnv = normalizeEnv(rawEnv);
  const serversInput = env.NTFY_SERVERS
    ? parseServersJson(env.NTFY_SERVERS)
    : [singleServerFromEnv(env)];

  const result = ServerConfigSchema.safeParse({
    servers: serversInput,
    defaultTopic: env.NTFY_DEFAULT_TOPIC,
    requestTimeoutMs: env.NTFY_REQUEST_TIMEOUT_MS,
    maxRetries: env.NTFY_MAX_RETRIES,
    blockPrivateHosts: env.NTFY_BLOCK_PRIVATE_HOSTS,
    clampLimits: env.NTFY_CLAMP_LIMITS,
  });

  if (!result.success) {
    throw configurationError(formatIssues(result.error.issues, env));
  }
  return result.data;
}

/**
 * `NTFY_SERVERS` parsed as JSON. A value that does not parse fails startup with
 * a message that quotes none of it and keeps no cause: the value holds
 * credentials, and a parser's own message quotes the text around the fault.
 */
function parseServersJson(raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configurationError(
      'NTFY_SERVERS is not valid JSON: check its quotes, commas, and brackets. It takes a JSON array of server entries, such as [{"baseUrl":"https://ntfy.example.com","authToken":"…"}].',
    );
  }
  if (!Array.isArray(parsed)) {
    throw configurationError('NTFY_SERVERS must be a JSON array of server entries.');
  }
  return parsed;
}

function singleServerFromEnv(env: RawEnv): Record<string, unknown> {
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

function formatIssues(issues: z.ZodIssue[], env: RawEnv): string {
  const usingRegistry = Boolean(env.NTFY_SERVERS);
  const lines = issues.map((issue) => {
    const path = issue.path.join('.');
    const envVar = usingRegistry
      ? envVarForRegistryPath(issue.path)
      : envVarForSingleServerPath(path);
    const message =
      issue.code === 'custom' && issue.params?.reason === CREDENTIALS_IN_URL
        ? credentialsInUrlMessage(usingRegistry)
        : issue.message;
    return envVar ? `  - ${envVar} (${path}): ${message}` : `  - ${path}: ${message}`;
  });
  return `Server config validation failed:\n${lines.join('\n')}`;
}

/** The fix for a base URL carrying credentials, worded for the variable it came from. */
function credentialsInUrlMessage(usingRegistry: boolean): string {
  return usingRegistry
    ? "The URL carries credentials (user:password@); remove them from it and set them as this entry's `authUsername` + `authPassword`, or `authToken`."
    : 'The URL carries credentials (user:password@); remove them from it and set them as NTFY_AUTH_USERNAME + NTFY_AUTH_PASSWORD, or NTFY_AUTH_TOKEN.';
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
    case 'blockPrivateHosts':
      return 'NTFY_BLOCK_PRIVATE_HOSTS';
    case 'clampLimits':
      return 'NTFY_CLAMP_LIMITS';
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
