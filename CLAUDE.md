# Developer Protocol

**Server:** ntfy-mcp-server
**Version:** 2.3.0
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.11.0`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/sdk` ^1.29.0
**Zod:** ^4.4.3

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.
>
> **ntfy upstream API docs:** mirrored under `docs/ntfy/` — `publish.md`, `subscribe/api.md`, `emojis.md`, `examples.md`, `index.md`. See `docs/ntfy/SOURCES.md` for the pinned commit and refresh steps.

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, you can suggest relevant options based on the current project state. Some common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch` for control flow. The narrow `try/catch` blocks in this codebase exist solely to translate upstream ntfy errors into typed contract failures via `ctx.fail()` before re-throwing; everything else bubbles for framework auto-classification. Use error factories (`notFound()`, `forbidden()`, `validationError()`, …) when no contract entry fits.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Auth scope is the configured `NTFY_BASE_URL`.** When a tool's `base_url` argument differs from the configured base, `NtfyService` strips the auth header before sending — never widen this to "always forward credentials" without explicit operator opt-in.
- **`base_url` overrides are validated before they are dereferenced.** Absolute `http(s)` form is enforced unconditionally (`assertAbsoluteHttpUrl`, plus the advertised `BASE_URL_PATTERN` on all three tool schemas); the private-address guard and redirect refusal are opt-in behind `NTFY_BLOCK_PRIVATE_HOSTS` so LAN and stdio deployments keep working. Registered servers bypass the guard — that is the operator's lever for a deliberate private target, so keep the bypass set sourced from every `cfg.servers[]` entry, not from the credentialed subset.
- **Side effects that leave the notification drawer ask the user first.** A clear/delete, or a publish carrying `email` / `call` / a `broadcast` or `http` action, routes through `confirmAction` before the upstream call. A declined, cancelled, or unparseable elicit response fails with `consent_declined`; a client that never advertised elicitation proceeds on the tool annotations alone — refusing there would break clients on calls that work today. Streamable HTTP is always that case: the framework builds a fresh `McpServer` per request, so `getClientCapabilities()` never sees the `initialize` handshake and `ctx.elicit` is undefined regardless of what the client advertised. Consent is a stdio guarantee until the framework closes that gap (`cyanheads/mcp-ts-core#312`).
- **Secrets in env vars only** — never hardcoded. `NTFY_AUTH_TOKEN` is mutually exclusive with `NTFY_AUTH_USERNAME` / `NTFY_AUTH_PASSWORD`; the basic-auth pair must be set together. Validation enforces this at config load.
- **Treat topic names as secrets.** Anyone who knows a topic name can publish or subscribe — surface that in tool descriptions and never log full topic names at info level when the topic is private.

---

## Patterns

### Tool

`ntfy_search_emoji_tags` — minimal in-memory tool, illustrates the basic shape:

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getEmojiTagService } from '@/services/emoji-tags/emoji-tag-service.js';

export const ntfySearchEmojiTags = tool('ntfy_search_emoji_tags', {
  description:
    "Look up ntfy emoji tag short codes. Use the returned `tag` strings in `ntfy_publish_message`'s `tags` field…",
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    query: z.string().optional().describe('Substring to match (case-insensitive).'),
    limit: z.number().int().positive().max(200).default(25).describe('Max matches.'),
  }),
  output: z.object({
    matches: z.array(z.object({
      tag: z.string().describe('Short code.'),
      emoji: z.string().describe('Rendered Unicode emoji.'),
    })).describe('Tag → emoji rows.'),
  }),
  // Agent-facing meta (parsed query, true total, truncation, empty-result
  // notice) rides `enrichment` — both client surfaces, no `format()` entry.
  enrichment: {
    effectiveQuery: z.string().optional().describe('Query as the server parsed it.'),
    totalCount: z.number().describe('Total matches before truncation.'),
    truncated: z.boolean().describe('True when more matched than `limit`.'),
    notice: z.string().optional().describe('Guidance when nothing matched.'),
  },

  handler(input, ctx) {
    const { matches, total, truncated } = getEmojiTagService().search(input.query, input.limit);
    if (input.query) ctx.enrich.echo(input.query);
    ctx.enrich.total(total);
    ctx.enrich({ truncated });
    if (matches.length === 0) ctx.enrich.notice('No tags matched — try a shorter substring.');
    return { matches };
  },

  format: (result) => [{
    type: 'text',
    text: result.matches.length === 0
      ? 'No emoji tags matched.'
      : result.matches.map(m => `| \`${m.tag}\` | ${m.emoji} |`).join('\n'),
  }],
});
```

`ntfy_publish_message` — typed error contract with upstream classification:

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { getNtfyService } from '@/services/ntfy/ntfy-service.js';

export const ntfyPublishMessage = tool('ntfy_publish_message', {
  description: 'Send or update a push notification on an ntfy topic…',
  annotations: { openWorldHint: true },
  input: /* … */,
  output: /* … */,

  errors: [
    { reason: 'forbidden_topic', code: JsonRpcErrorCode.Forbidden,
      when: 'Auth required for the target topic.',
      recovery: 'Try a public topic instead; if this topic must stay protected, ask the operator to provision ntfy auth credentials.' },
    { reason: 'rate_limited', code: JsonRpcErrorCode.RateLimited,
      when: 'Upstream returned 429 after retries were exhausted.',
      retryable: true,
      recovery: "Wait the rate-limit window before retrying." },
  ],

  async handler(input, ctx) {
    const topic = input.topic ?? getServerConfig().defaultTopic;
    if (!topic) {
      throw validationError('Topic is required when NTFY_DEFAULT_TOPIC is unset.', {
        recovery: { hint: 'Pass a `topic` argument or configure NTFY_DEFAULT_TOPIC.' },
      });
    }
    try {
      const response = await getNtfyService().publish({ topic, ...input }, { signal: ctx.signal });
      return { id: response.id, /* … */ };
    } catch (err) {
      if (isAuthCode(getCode(err))) {
        throw ctx.fail('forbidden_topic', getMessage(err) || `Forbidden for topic ${topic}`);
      }
      throw err; // Let framework auto-classify the rest
    }
  },
});
```

### Resource

`ntfy://{topic}` — snapshot resource that delegates to the same service the polling tool uses:

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { forbidden } from '@cyanheads/mcp-ts-core/errors';
import { getNtfyService } from '@/services/ntfy/ntfy-service.js';

export const ntfyTopicResource = resource('ntfy://{topic}', {
  name: 'ntfy-topic-snapshot',
  description: "Snapshot of a topic's last 20 messages from the past hour…",
  mimeType: 'application/json',
  params: z.object({
    topic: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/).describe('Topic name.'),
  }),

  async handler(params, ctx) {
    try {
      const raw = await getNtfyService().fetch(
        { topic: params.topic, since: '1h' },
        { signal: ctx.signal },
      );
      return { topic: params.topic, messages: raw, /* … */ };
    } catch (err) {
      if (isAuthCode(getCode(err))) {
        throw forbidden(getMessage(err) || `Forbidden for topic ${params.topic}`, {
          recovery: { hint: 'Try an unprotected topic.' },
        }, { cause: err });
      }
      throw err;
    }
  },
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z
  .object({
    baseUrl: z.string().url().default('https://ntfy.sh').transform((u) => u.replace(/\/+$/, '')),
    defaultTopic: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/).optional(),
    authToken: z.string().min(1).optional(),
    authUsername: z.string().min(1).optional(),
    authPassword: z.string().min(1).optional(),
    requestTimeoutMs: z.coerce.number().int().positive().default(15_000),
    maxRetries: z.coerce.number().int().min(0).default(3),
  })
  .superRefine((cfg, ctx) => {
    // token vs username/password are mutually exclusive; basic-auth pair must be set together.
  });

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'NTFY_BASE_URL',
    defaultTopic: 'NTFY_DEFAULT_TOPIC',
    authToken: 'NTFY_AUTH_TOKEN',
    /* … */
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so validation errors name the actual variable (`NTFY_AUTH_TOKEN`) rather than the internal path (`authToken`). It throws a `ConfigurationError` the framework catches and prints as a clean startup banner.

---

## Context

Handlers receive a unified `ctx` object. Key properties this server uses today (the framework exposes more — see `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md`):

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.signal` | `AbortSignal` forwarded into `NtfyService` calls so client cancellations propagate to upstream HTTP. |
| `ctx.elicit` | Present only when the client advertised elicitation — never over Streamable HTTP, where the per-request `McpServer` misses the handshake (`cyanheads/mcp-ts-core#312`). Reached through `confirmAction()`, never called directly from a handler — it centralizes the boolean confirmation schema and the "no elicitation, proceed on annotations" fallback. |
| `ctx.fail(reason, ...)` | Throw a typed contract failure declared in the tool's `errors[]` array. Pair with `ctx.recoveryFor(reason)` to attach the declared `recovery` hint to the wire payload. |
| `ctx.enrich(...)` | Accumulate agent-facing success-path context (empty-result notices, query/filter echo, pagination totals) declared in a tool's `enrichment` block — reaches both `structuredContent` and `content[]`. Helpers: `.notice()`, `.total()`, `.echo()`. |
| `ctx.requestId` | Unique request ID. Surfaces in logs and error payloads. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive a typed `ctx.fail(reason, …)` keyed by the declared reason union. TypeScript catches `ctx.fail('typo')` at compile time, `data.reason` is auto-populated for observability, and the linter enforces conformance against the handler body. The `recovery` field is required descriptive metadata for the agent's next move (≥ 5 words, lint-validated); for the wire payload's `data.recovery.hint` (which the framework mirrors into `content[]` text), pass it explicitly at the throw site when dynamic context matters: `ctx.fail('reason', msg, { recovery: { hint: '...' } })`. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`);
  return item;
}
```

**Declare contracts inline on each tool, even when similar across tools.** The contract is part of the tool's documented public surface — reading one tool definition file should give the full picture. Don't extract a shared `errors[]` constant or contract module to deduplicate; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  config/
    server-config.ts                    # NTFY_* env vars (Zod schema, lazy-parsed)
  services/
    ntfy/
      ntfy-service.ts                   # HTTP client (publish, manage, fetch)
      base-url-guard.ts                 # base_url override validation + SSRF guard
      error-classifier.ts               # Map upstream errors → contract reasons
      message-shape.ts                  # Normalize/truncate a message envelope
      types.ts                          # Domain types (NtfyMessage, NtfyAction, …)
    emoji-tags/
      emoji-tag-service.ts              # In-memory tag → emoji lookup
      data.generated.ts                 # Generated from docs/ntfy/emojis.md
  mcp-server/
    tools/definitions/
      ntfy-publish-message.tool.ts      # Send/update a notification
      ntfy-manage-message.tool.ts       # Clear/delete by sequence_id
      ntfy-fetch-messages.tool.ts       # Poll cached messages with filters
      ntfy-search-emoji-tags.tool.ts    # Look up emoji short codes
    tools/utils/
      confirm-action.ts                 # ctx.elicit consent gate for side effects
    resources/definitions/
      ntfy-topic.resource.ts            # ntfy://{topic} snapshot
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-docs.tool.ts` |
| Tool/resource/prompt names | snake_case | `search_docs` |
| Directories | kebab-case | `src/services/doc-search/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts shell out to `bun`. `npm run <cmd>` works too, but the scripts assume Bun is on the PATH.

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript via `scripts/build.ts` |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run tree` | Regenerate `docs/tree.md` |
| `bun run format` | Auto-fix formatting (Biome) |
| `bun run lint:mcp` | Validate MCP definitions against the spec |
| `bun run test` | Run the Vitest test suite |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/<minor>.x/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run scripts/build-emoji-tags.ts` | Regenerate `src/services/emoji-tags/data.generated.ts` from `docs/ntfy/emojis.md` |

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected.

**Adding an env var:** `server.json` always (registry discovery, `environmentVariables[]`). `manifest.json` only when the var is required with no default, or when bundle users should be prompted for it — then it needs both `mcp_config.env` and a `user_config` field. `lint:packaging` (run by `devcheck`) enforces exactly that pairing and checks the names match. Optional vars carrying a default stay out of `manifest.json`, which is why `user_config` is empty today.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series using the `.x` semver-wildcard convention. Source of truth is `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/2.0.x/2.0.0.md`) — one file per released version, shipped in the npm package. At release time, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited, never renamed, never moved. Read it to remember the frontmatter + section layout when scaffolding a new per-version file. `CHANGELOG.md` is a **navigation index** (header + link + one-line summary per version), regenerated by `bun run changelog:build`. Devcheck hard-fails on drift. Never hand-edit `CHANGELOG.md`.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true flags security fixes
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section. When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

**Section order** (Keep a Changelog): Added, Changed, Deprecated, Removed, Fixed, Security. Include only sections with entries — don't ship empty headers.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getMyService } from '@/services/my-domain/my-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.signal` forwarded to upstream HTTP calls
- [ ] Handlers throw on failure — `ctx.fail()` for declared contract reasons, error factories or plain `Error` for everything else; no defensive try/catch (the only `try`/`catch` in this codebase translates upstream errors into contract reasons before re-throwing)
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] Agent-facing meta (empty-result notices, query/filter echo, pagination totals) lives in an `enrichment` block populated via `ctx.enrich(...)`, not in `output` or `format()`-only text; enrichment keys disjoint from `output`
- [ ] ntfy-specific: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] ntfy-specific: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] ntfy-specific: tests include at least one sparse payload case with omitted upstream fields
- [ ] ntfy-specific: per-call `base_url` overrides go out unauthenticated when they differ from the configured base — never widen this without explicit operator opt-in
- [ ] Registered in `createApp()` arrays in `src/index.ts`
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `bun run devcheck` passes
