# ntfy-mcp-server — Design

Wraps the [ntfy](https://ntfy.sh) HTTP publish/subscribe API so an LLM agent can send push notifications, manage previously-published messages, poll cached topic history, and discover emoji tag short codes. Targets `ntfy.sh` by default but works against any self-hosted ntfy server via `NTFY_BASE_URL`. Auth is optional (token or basic), required only for protected topics, phone calls, and email features.

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `ntfy_publish_message` | Send or update a push notification on a topic. Supports title, priority (1–5), emoji/free-form tags (use `ntfy_search_emoji_tags` to look up short codes), click URL, action buttons, URL attachments, icon, markdown, scheduled delivery (`delay`), email forwarding, voice call, and `sequence_id` for updating a prior message. Topics are created on first publish. | `topic`, `message`, `title?`, `priority?`, `tags?`, `click?`, `attach?`, `icon?`, `filename?`, `markdown?`, `actions?`, `delay?`, `email?`, `call?`, `sequence_id?`, `cache?`, `firebase?`, `base_url?` | `openWorldHint: true` |
| `ntfy_manage_message` | Clear (mark read & dismiss) or delete a previously-sent notification by its `sequence_id`. Append-only — the original message stays in cache; subscribers receive a clear or delete signal and update the notification accordingly. | `topic`, `sequence_id`, `operation: 'clear' \| 'delete'`, `base_url?` | `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `ntfy_fetch_messages` | Poll cached messages from one or more topics with optional filters. Returns a snapshot, not a live stream. Useful for confirming delivery, replaying missed alerts, or auditing topic activity. | `topic` (single or comma-list), `since?`, `scheduled?`, `priority?`, `tags?`, `title?`, `message?`, `id?`, `limit?`, `base_url?` | `readOnlyHint: true`, `openWorldHint: true` |
| `ntfy_search_emoji_tags` | Look up emoji tag short codes from the bundled reference. Use the returned `tag` strings in `ntfy_publish_message`'s `tags` field to render emojis on the recipient's device. Filter by substring; without a query, returns a curated default set. | `query?`, `limit?` | `readOnlyHint: true`, `openWorldHint: false` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `ntfy://{topic}` | Snapshot of a topic's recently-cached messages — latest 20 from the last 1 hour, plus the topic's browser URL. Discoverable "what's happening on topic X" lookup; for filters, custom windows, or replay use `ntfy_fetch_messages`. `application/json`. | None — fixed window. |

### Prompts

None. The publish tool is self-explanatory; no recurring multi-message templates worth structuring.

---

## Overview

ntfy is a pub/sub HTTP service for push notifications. Anyone with a topic name can publish; subscribers (phones, browsers, scripts) get the message. The MCP server is a thin authenticated wrapper: it lets agents send rich notifications (title, priority, tags/emojis, click actions, action buttons, scheduled delivery, attachments-by-URL, email/voice forwarding), manage prior messages by `sequence_id`, and read back cached topic history.

**Primary user goal:** an agent finishes a long-running task / detects an event / reaches a checkpoint, and notifies the human via their phone.

**Secondary goals:** progress updates (publish then update via `sequence_id`), reminders (`delay`/`at`), dead-man's-switch alerts (re-scheduled message), and audit/replay (`fetch`).

## Requirements

- Default to `https://ntfy.sh`; configurable for self-hosted ntfy via `NTFY_BASE_URL`.
- Optional auth: Bearer token (`tk_...`) or HTTP Basic. Both must work; only one is configured per server instance.
- Optional `NTFY_DEFAULT_TOPIC` so trivially-configured servers can omit `topic` from tool calls.
- Honour ntfy's documented limits (4096-byte message body, 15 MB attachment URL, ≤3 actions per message, delay 10s–3 days). Surface limit-related rejections from the server as recoverable errors.
- Treat the topic as a secret (it's a password-equivalent) — never log topic names at `info` level; redact in error messages where the topic itself is the failure cause.
- No local file uploads in v1. URL-based attachments only (`attach` field); the agent provides a public URL.

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `NtfyService` | ntfy HTTP API (`POST /` for JSON publish, `PUT /<topic>/<sequence_id>/clear`, `DELETE /<topic>/<sequence_id>`, `GET /<topic>/json?poll=1&...`). Wraps `fetchWithTimeout` + `withRetry` from `@cyanheads/mcp-ts-core/utils`. Each method accepts an optional per-call `baseUrl` override; when omitted, falls back to `NTFY_BASE_URL`. Auth header (Bearer or Basic) is injected only when the resolved base URL matches the configured one — overrides go out unauthenticated. | `ntfy_publish_message`, `ntfy_manage_message`, `ntfy_fetch_messages`, `ntfy://{topic}` |
| `EmojiTagService` | In-memory map of tag short code → emoji, parsed at startup from a TS module generated at build time from `docs/ntfy/emojis.md`. No external deps. | `ntfy_search_emoji_tags` |

`NtfyService` resilience: retry boundary is the full publish/fetch round trip; backoff base 500ms with 3 attempts; `withRetry` enriches the final error with attempt count. 429 responses retry with the upstream `Retry-After` honoured (or 2× base if absent). 4xx other than 408/429 do not retry.

## Config

All env vars are optional except where noted. The server runs unauthenticated against `ntfy.sh` with no defaults if nothing is set.

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `NTFY_BASE_URL` | No | `https://ntfy.sh` | Base URL of the ntfy server (no trailing slash). |
| `NTFY_DEFAULT_TOPIC` | No | — | Topic used when a tool call omits `topic`. Without this, `topic` is required on every call. |
| `NTFY_AUTH_TOKEN` | Conditional | — | Bearer access token (`tk_...`). Mutually exclusive with `NTFY_AUTH_USERNAME` / `NTFY_AUTH_PASSWORD` — startup hard-fails with a config error if both modes are set, to avoid silent ambiguity about which credential was used. |
| `NTFY_AUTH_USERNAME` | Conditional | — | Basic auth username. Required together with `NTFY_AUTH_PASSWORD`. Mutually exclusive with `NTFY_AUTH_TOKEN`. |
| `NTFY_AUTH_PASSWORD` | Conditional | — | Basic auth password. Required together with `NTFY_AUTH_USERNAME`. Mutually exclusive with `NTFY_AUTH_TOKEN`. |
| `NTFY_REQUEST_TIMEOUT_MS` | No | `15000` | Per-request HTTP timeout in milliseconds. |
| `NTFY_MAX_RETRIES` | No | `3` | Max retry attempts for transient upstream failures (5xx, network, 429). |

## Implementation Order

1. **Config & service skeleton** — `src/config/server-config.ts` (Zod schema, lazy parse), bare `NtfyService` with auth-header builder + `fetchWithTimeout` wrapper.
2. **Emoji tag data** — `scripts/build-emoji-tags.ts` parses `docs/ntfy/emojis.md` → emits `src/services/emoji-tags/data.generated.ts`. `EmojiTagService` consumes it. Search uses substring match.
3. **`ntfy_publish_message`** — main tool; calls `NtfyService.publish()` (POST `/` JSON body). Cover all publish fields. Smoke test against `ntfy.sh/<random_topic>` from the phone app.
4. **`ntfy_manage_message`** — clear/delete via `NtfyService.manage()`. Verify subscriber receives `message_clear` / `message_delete` events.
5. **`ntfy_fetch_messages`** + **`ntfy://{topic}`** resource — `NtfyService.fetch()` (GET with `poll=1`); parse NDJSON response into a typed array, surface `since` / filter args. The resource is a thin wrapper that calls `fetch()` with fixed defaults (`since: '1h'`, `limit: 20`).
6. **`ntfy_search_emoji_tags`** — emoji discovery surface.
7. **devcheck pass** — lint, format, typecheck, security audit.
8. **Field test** — exercise every tool with realistic inputs against `ntfy.sh`.

Each step is independently testable.

---

## Domain Mapping

User goals (anchor for tool selection):

1. Notify when a long-running task succeeds or fails.
2. Send a progress update that overwrites a prior notification.
3. Schedule a reminder for a future time / dead-man's-switch alert.
4. Send an alert with action buttons (open URL, fire HTTP webhook, copy to clipboard).
5. Forward a critical alert to email and/or voice call in addition to the phone push.
6. Confirm a notification was actually delivered (poll `since=` recent).
7. Discover the right emoji tag for an alert ("warning", "tada", "cd", etc.).

Underlying domain operations the ntfy API supports:

| Noun | Operations | Tool path |
|:-----|:-----------|:----------|
| Message | publish (with all 18 publish params), update (publish with `sequence_id`), clear, delete, list/poll | `ntfy_publish_message`, `ntfy_manage_message`, `ntfy_fetch_messages` |
| Topic | implicit (created on first publish, no separate API); per-topic snapshot lookup | `ntfy://{topic}` |
| Emoji tag | search reference (substring + limit) | `ntfy_search_emoji_tags` |

Excluded entirely (stays in the ntfy web app — recovery requires vendor UI):
- Account / billing / tier management
- Verifying email or phone number for `email: yes` / `call: yes`
- Access-control rules, ACL grants, token issuance

These are administrative and irreversible-on-mistake; the agent never needs them.

## Workflow Analysis

`ntfy_publish_message` is one upstream POST per call. Updates use the same call with `sequence_id` set, so no separate workflow shape is needed.

`ntfy_manage_message` is one upstream `PUT` (clear) or `DELETE` (delete) call.

`ntfy_fetch_messages` is one upstream `GET <topic>/json?poll=1&...` request, response parsed line-by-line as NDJSON.

No multi-call workflows — every tool maps to a single upstream HTTP request. The retry boundary in `NtfyService` covers the full round trip including response parsing, classifying HTML error pages and partial responses as transient (retryable) rather than as serialization errors.

## Tool Detail

> Every field declared in an `output` schema below also appears in the corresponding `format()` rendering. The framework's `format-parity` linter enforces this at startup, so MCP clients without `structuredContent` support (e.g., Claude Desktop) see the same data as clients that read the structured surface (e.g., Claude Code) — `format()` is the markdown twin, not a reduced summary.

### `ntfy_publish_message`

**Purpose:** the workhorse. Single tool covers every publish use case.

**Inputs (highlights):**

- `topic: string` — required when `NTFY_DEFAULT_TOPIC` is unset; optional otherwise. Length 1–64, `^[a-zA-Z0-9_-]+$`.
- `message: string` — body. Up to ~4096 bytes (server-enforced; longer is automatically converted to an attachment by ntfy). Empty/missing body is replaced server-side with the literal string `"triggered"`; pass a deliberate body even for ping-style notifications so subscribers see real content.
- `title?: string` — notification title. Defaults to the topic URL on the recipient's device when omitted.
- `priority?: 1 | 2 | 3 | 4 | 5` — min/low/default/high/max. Numeric on the wire even when callers think in names. Defaults server-side to `3`.
- `tags?: string[]` — emoji short codes (rendered as emojis prepended to the title) or free-form labels (shown as a tag list below the body). Up to ~10. Use `ntfy_search_emoji_tags` to discover available short codes.
- `click?: string` (URL) — opened on tap. `http://`/`https://` open the browser; `mailto:`, `geo:`, `ntfy://` open registered apps.
- `attach?: string` (URL) — attachment fetched by URL. No local file upload — host the file somewhere reachable first.
- `icon?: string` (URL) — JPEG/PNG icon shown next to the message body. Cached by the client for 24h.
- `filename?: string` — overrides the attachment's display filename in the client.
- `markdown?: boolean` — render body as Markdown (web app only at this time on the recipient side; mobile apps render plain text).
- `actions?: Action[]` — up to 3 buttons. Discriminated union on the `action` field:

| `action` | Required fields | Optional fields |
|:---------|:----------------|:----------------|
| `view` | `label` (button text), `url` (target — supports `http://`, `https://`, `mailto:`, `geo:`, `ntfy://`, etc.) | `clear` (dismiss the notification when tapped, default `false`) |
| `broadcast` | `label` | `intent` (Android intent name; ntfy uses a default when omitted), `extras` (record of `string → string` extras passed with the broadcast), `clear` |
| `http` | `label`, `url` | `method` (default `POST`), `headers` (record of `string → string`), `body` (request body), `clear` |
| `copy` | `label`, `value` (text copied to the device clipboard) | `clear` |

- `delay?: string` — duration (`30m`, `2h`, `1d`), Unix timestamp, or natural-language time (`tomorrow, 10am`, `Tuesday, 7am`). Min 10s, max 3 days (server-enforced). Server parses — pass through verbatim.
- `email?: string` — address to forward to (`"phil@example.com"`), or `"yes"` to use the authenticated user's first verified address.
- `call?: string` — phone number in `+CCNNNNNNNNNN` format, or `"yes"` to use the authenticated user's first verified number. Requires an authenticated ntfy account with a verified phone number; ntfy.sh limits this to Pro plans.
- `sequence_id?: string` — provide to update or replace a previously-published message instead of creating a new one. Same value used by `ntfy_manage_message` for clear/delete. Constrained to `^[a-zA-Z0-9_-]{1,64}$` because the value ends up in URL paths for clear/delete (`/<topic>/<sequence_id>/clear`).
- `cache?: boolean` (default `true`) — set `false` to skip server-side caching (live subscribers still receive it, but `ntfy_fetch_messages` and reconnecting clients won't see it). Sent as the `X-Cache: no` HTTP header — ntfy's JSON publish API doesn't accept `cache` in the body.
- `firebase?: boolean` (default `true`) — set `false` to skip Firebase Cloud Messaging forwarding (delays Android delivery up to 15 min unless instant delivery is enabled on the recipient's app). Sent as the `X-Firebase: no` HTTP header — ntfy's JSON publish API doesn't accept `firebase` in the body.
- `base_url?: string` — overrides the configured `NTFY_BASE_URL` for this single call. Useful for one-off publishes to a different ntfy host (e.g., default is self-hosted, but a public-topic ping goes to `ntfy.sh`). When the override differs from the configured base URL, server-configured auth credentials are **not** forwarded — the request goes out unauthenticated to avoid leaking the server's identity to an arbitrary URL the agent picked. For protected topics on alternate hosts, run a separate server instance with its own credentials.

**Output:**

```ts
{
  id: string;                 // server-assigned message ID — use as sequence_id to update later
  time: number;               // Unix seconds when ntfy accepted the message (not delivery time)
  topic: string;              // topic the message was published to
  url: string;                // human-readable topic URL (e.g., "https://ntfy.sh/mytopic"); SYNTHESIZED by the tool from `${baseUrl}/${topic}` — ntfy does not return this in its response
  expires?: number;           // Unix seconds when the message ages out of server cache; ABSENT when published with cache: false
  sequence_id?: string;       // ABSENT on a fresh publish; PRESENT only when the call updated an earlier message and the input sequence_id differed from the new id
  scheduled?: boolean;        // true ONLY when `delay` was set and the message is queued for later delivery; ABSENT/false on immediate publishes
  title?: string;             // echo of input title; ABSENT when not set (recipient defaults to the topic URL)
  message?: string;           // echo of input message; "triggered" when the input body was empty
  priority?: 1|2|3|4|5;       // echo of input priority; ABSENT when default (3)
  tags?: string[];            // echo of input tags; ABSENT when no tags were set
  click?: string;             // echo of input click URL; ABSENT when not set
  attachment?: { name: string; url: string; type?: string; size?: number; expires?: number };  // ABSENT when no attachment was set; matches the documented JSON message format used by subscribe responses
}
```

**`format()`** renders id, topic, URL, scheduled-vs-delivered banner, title (when present), tags as inline chips, priority badge, message body, a Markdown link to the click URL when present, and an `Attachment: [name](url)` line when present. Every output field above appears in the rendered text.

**Errors (typed contract):**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `forbidden_topic` | `Forbidden` | Auth required for the target topic. | Try a public topic instead; if this topic must stay protected, ask the operator to provision ntfy auth credentials for the server before retrying. |
| `rate_limited` | `RateLimited` | 429 from upstream after retries exhausted. | Wait the rate-limit window (typically minutes on ntfy.sh's free tier) before retrying, or reduce publish frequency. |
| `payload_too_large` | `InvalidParams` | Message body or attachment exceeds server limits. | Shorten the message (≤4096 bytes plain) or host the long content as an external URL via `attach`. |
| `unverified_contact` | `InvalidParams` | `email`/`call` set but the authenticated user has no verified address/number, or auth is missing. | Drop the `email`/`call` field and resend; if forwarding is essential, ask the operator to verify the address or number in the ntfy account settings. |

Baseline `ServiceUnavailable` / `ValidationError` / `Timeout` bubble freely.

### `ntfy_manage_message`

Inputs: `topic`, `sequence_id`, `operation: 'clear' | 'delete'`, `base_url?: string` (per-call override; same auth-isolation rule as `ntfy_publish_message` — configured credentials are not forwarded when the override differs from `NTFY_BASE_URL`). Output: `{ id, topic, sequence_id, operation, time }` echoing the emitted event. Idempotent — clearing a cleared message or deleting a deleted message is a no-op.

**Errors:**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `forbidden_topic` | `Forbidden` | Auth required for the target topic. | Try an unprotected topic instead; if this topic must stay protected, ask the operator to provision ntfy auth credentials for the server before retrying. |
| `not_found` | `NotFound` | The `sequence_id` was never published to this topic, or the cache window has elapsed. | Confirm the topic and `sequence_id` were correct (call `ntfy_fetch_messages` to inspect what's still cached), or accept that the message has aged out (default cache window is 12h). |

### `ntfy_fetch_messages`

**Inputs:**

- `topic: string` — single topic or comma-separated list (e.g., `"alerts"` or `"alerts,backups,phil_alerts"`). Required when `NTFY_DEFAULT_TOPIC` is unset.
- `since?: string` — defaults to `"10m"` as a tool-level guardrail (ntfy's own default is `"all"`; the tighter window keeps the most common "did my recent notification land?" use case cheap and avoids returning the *oldest* messages first when the cache is large and `limit` truncates). Accepts a duration (`30s`, `10m`, `2h`, `1d`), a Unix timestamp, a message ID, or the keywords `"all"` (every cached message — up to ~12h on ntfy.sh) or `"latest"` (only the most recent message).
- `scheduled?: boolean` — default `false`. Set `true` to include delayed/not-yet-delivered messages.
- `priority?: (1|2|3|4|5)[]` — match any priority in the list (logical **OR**). Empty/omitted matches all priorities.
- `tags?: string[]` — match all tags in the list (logical **AND**). Empty/omitted matches all messages regardless of tags.
- `id?: string` — exact-match a single message ID.
- `title?: string` — exact-match against the title string.
- `message?: string` — exact-match against the message body.
- `limit?: number` — client-side cap on returned messages, default `20`, max `100`. The tool truncates after the limit and sets `truncated: true` so the agent knows more remain.
- `base_url?: string` — per-call override of `NTFY_BASE_URL`. Same auth-isolation rule as `ntfy_publish_message`.

Single round trip — no streaming.

**Output:**

```ts
{
  messages: Array<{
    id: string;                   // message ID — pass back as `since` to paginate or as `sequence_id` to manage
    time: number;                 // Unix seconds when ntfy accepted the message
    event: 'message' | 'message_clear' | 'message_delete' | 'poll_request';
    topic: string;                // matching topic (one of the requested topics on multi-topic queries)
    expires?: number;             // Unix seconds when the message ages out of cache; ABSENT when published with cache: false
    sequence_id?: string;         // PRESENT on update / clear / delete events pointing back to the original message; ABSENT on initial publishes
    title?: string;               // ABSENT when no title was set (recipient clients fall back to the topic URL)
    message?: string;             // ABSENT on clear/delete events; truncated to ~500 chars when the body is longer
    messageTruncated?: number;    // count of additional chars dropped from `message`; ABSENT when the full body fits
    priority?: 1|2|3|4|5;         // ABSENT when the message was sent at the default priority (3)
    tags?: string[];              // ABSENT when no tags were set
    click?: string;               // ABSENT when no click URL was set
    actions?: Action[];           // same shape as the publish input's `actions`; ABSENT when none
    attachment?: { name: string; url: string; type?: string; size?: number; expires?: number };  // ABSENT when no attachment
  }>;
  count: number;                  // number of messages returned in this response
  truncated: boolean;             // true when the server returned more messages than `limit` and the tail was dropped — refetch with a tighter `since` or use `id` to target a specific message
}
```

The tool filters out `open` and `keepalive` events client-side (they're connection-level frames, not notification data). `format()` renders a compact list — id, event type, title, priority badge, tag chips, and the (possibly truncated) message body — with `(N chars more)` suffix on truncated messages and an `…and X more` footer when `truncated` is true. Every output field above appears in the rendered text.

**Errors:**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `forbidden_topic` | `Forbidden` | Auth required for the target topic. | Try an unprotected topic instead; if this topic must stay protected, ask the operator to provision ntfy auth credentials for the server before retrying. |
| `invalid_since` | `InvalidParams` | `since` value couldn't be parsed by ntfy (bad duration, malformed timestamp, or unknown message ID). | Use one of: `"all"`, `"latest"`, a duration like `"10m"` / `"2h"` / `"1d"`, a Unix timestamp (seconds), or a known message ID. |

### `ntfy_search_emoji_tags`

Inputs: `query?: string` (substring match against tag name), `limit?: number` (default 25, max 200).

Output: `{ matches: Array<{ tag: string; emoji: string }>, total: number, truncated: boolean }`. The bundled `docs/ntfy/emojis.md` is a flat tag→emoji list — no aliases or categories to surface.

`format()` renders a Markdown table of `tag` → `emoji` rows, with a footer noting `total` matches and any `truncated` overflow.

No domain failure modes — input validation and out-of-the-box errors only.

## Resource Detail

### `ntfy://{topic}`

Per-topic snapshot. Reuses `NtfyService.fetch()` with fixed defaults so a client can say "show me topic X" without parameterizing a tool. For filtering, custom windows, multi-topic queries, or replay use `ntfy_fetch_messages`.

`topic` follows the same `1–64`, `^[a-zA-Z0-9_-]+$` constraint as the publish input. Resources can't take query params, so per-call `base_url` overrides don't apply here — always uses configured `NTFY_BASE_URL` with configured auth.

**Output (`application/json`):**

```ts
{
  topic: string;            // requested topic name
  url: string;              // browser URL `${baseUrl}/${topic}`; SYNTHESIZED, not returned by ntfy
  baseUrl: string;          // resolved ntfy server base URL (matches configured NTFY_BASE_URL)
  since: '1h';              // fixed snapshot window
  messages: Array<{...}>;   // same shape as ntfy_fetch_messages output's messages[]
  count: number;            // number of messages in this snapshot
  truncated: boolean;       // true when more than 20 messages fell within the window
}
```

**Errors:** same `forbidden_topic` contract as `ntfy_fetch_messages`. Resolves to a single upstream `GET` via the same `NtfyService.fetch()` retry boundary.

## Design Decisions

- **One publish tool, not many.** ntfy's 18 publish parameters could fan out into themed tools (`alert`, `progress`, `reminder`, `phone-call`), but the API is one POST and the agent benefits from seeing all options in one place. Splitting forces the LLM to pick a tool before knowing what shape the call should take. Single tool keeps tool-selection cheap.
- **Updates ride publish, not their own tool.** `sequence_id` is a publish parameter — separating an `update` tool would duplicate the entire input schema for one extra field. Documented in publish's description.
- **Clear and delete consolidated.** Both are post-publish management actions on a sequence. A single `ntfy_manage_message` with `operation` enum is tighter than two tools that share 90% of their schema. Both are dropped from the same handler.
- **No local file upload.** Binary uploads from an LLM are awkward — the agent rarely has a file in hand, and adding a `localFilePath` parameter ties the tool to stdio mode and the agent's filesystem context. URL attachments cover the realistic LLM workflow; local files belong to a future `ntfy_upload_attachment` tool if demand surfaces.
- **No subscribe/streaming tool.** ntfy's subscribe endpoint is a long-lived connection. MCP tool calls are request/response. `ntfy_fetch_messages` covers the use case (poll on demand) without inventing an awkward tool that returns streaming data.
- **Topic exposed as a resource AND as fetch-tool input.** `ntfy://{topic}` returns a default-friendly snapshot — discoverable as a URI, no parameters, "what's happening here." `ntfy_fetch_messages` covers parameterized queries (filters, custom windows, multi-topic, larger pulls). Same data path, different ergonomics: resources answer "what is X," tools answer "do X with these params."
- **Topic is treated as a secret.** Topic names function as access tokens for unprotected ntfy servers. The server logs topics at `debug` only; tool descriptions warn agents not to invent guessable names.
- **Auth credentials are server-config, not tool-input.** A token in a tool argument would log on every call and bloat schemas. One server instance ↔ one identity; multi-tenant scenarios run multiple servers.
- **`base_url` is overridable per-call; auth is not.** Configured credentials are scoped to the configured `NTFY_BASE_URL`. When `base_url` is set to anything other than the configured value, the request goes out unauthenticated — preventing the agent from leaking server-configured tokens to an arbitrary URL it picked. The override exists for ad-hoc publishes/fetches against public ntfy servers; protected topics on alternate hosts need a separate server instance.

## Known Limitations

- Phone calls and `email: yes` require server-side authenticated users with verified contacts. The MCP server can't verify these; failures surface as `unverified_contact`.
- Message templating (Go template fields, `?template=github` etc.) is intentionally **not** exposed. The LLM can format messages itself before sending; templating is for non-LLM webhook bridges.
- Action buttons cap at 3 per message — server-enforced.
- Rate limits on `ntfy.sh`: 60 requests-at-once burst, refill 1/5s, 250 messages/day, 5 emails/day. Agents that exceed these get `rate_limited`.
- No webhook/GET publishing. The server uses JSON publish exclusively (POST `/`) for clarity and richer params.

## API Reference

- Publish: `POST /` with JSON body for the fields documented in [`docs/ntfy/publish.md#publish-as-json`](./ntfy/publish.md#publish-as-json). `cache` and `firebase` are not JSON body fields — send them as the `X-Cache` / `X-Firebase` headers instead (see [`docs/ntfy/publish.md#list-of-all-parameters`](./ntfy/publish.md#list-of-all-parameters)).
- Manage: `PUT /<topic>/<sequence_id>/clear` (or `/read` alias) for clear; `DELETE /<topic>/<sequence_id>` for delete.
- Fetch: `GET /<topic>/json?poll=1&since=...&priority=...&tags=...&...` — NDJSON response, one message per line.
- Auth: `Authorization: Bearer <token>` or `Authorization: Basic <base64(user:pass)>`.
- Limits: see [`docs/ntfy/publish.md#limitations`](./ntfy/publish.md#limitations).
- Emoji reference: [`docs/ntfy/emojis.md`](./ntfy/emojis.md).
