# ntfy-mcp-server — Design

Wraps the [ntfy](https://ntfy.sh) HTTP publish/subscribe API so an LLM agent can send push notifications, manage previously-published messages, poll cached topic history, and discover emoji tag short codes. Targets `ntfy.sh` by default but works against any self-hosted ntfy server via `NTFY_BASE_URL`. Auth is optional (token or basic), required only for protected topics, phone calls, and email features.

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `ntfy_publish_message` | Send or update a push notification on a topic. Supports title, priority (1–5), emoji/free-form tags (use `ntfy_search_emoji_tags` to look up short codes), click URL, action buttons, URL attachments, icon, markdown, scheduled delivery (`delay`), email forwarding, voice call, and `sequence_id` for updating a prior message. Topics are created on first publish. | `topic`, `message`, `title?`, `priority?`, `tags?`, `click?`, `attach?`, `icon?`, `filename?`, `markdown?`, `actions?`, `delay?`, `email?`, `call?`, `sequence_id?`, `cache?`, `firebase?`, `base_url?` | `openWorldHint: true` |
| `ntfy_manage_message` | Clear (mark read & dismiss) or delete a previously-sent notification by its `sequence_id`. Append-only — the original message stays in cache; subscribers receive a clear or delete signal and update the notification accordingly. | `topic`, `sequence_id`, `operation: 'clear' \| 'delete'`, `base_url?` | `destructiveHint: true`, `openWorldHint: true` |
| `ntfy_fetch_messages` | Poll cached messages from one or more topics with optional filters. Returns a snapshot, not a live stream. Useful for confirming delivery, replaying missed alerts, or auditing topic activity. | `topic` (single or comma-list), `since?`, `scheduled?`, `priority?`, `tags?`, `title?`, `message?`, `id?`, `limit?`, `cursor?`, `base_url?` | `readOnlyHint: true`, `openWorldHint: true` |
| `ntfy_search_emoji_tags` | Look up emoji tag short codes from the bundled reference. Use the returned `tag` strings in `ntfy_publish_message`'s `tags` field to render emojis on the recipient's device. Filter by substring; without a query, lists the reference from the start in its documented order. Disabled when `NTFY_ENABLE_EMOJI_TAGS=false`. | `query?`, `limit?`, `offset?` | `readOnlyHint: true`, `openWorldHint: false` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `ntfy://{topic}` | Snapshot of a topic's recently-cached messages — latest 20 from the last 1 hour, plus the topic's browser URL. Discoverable "what's happening on topic X" lookup; for filters, custom windows, or replay use `ntfy_fetch_messages`. `application/json`. | None — fixed window. |

### Skills

| Skill | URI | Description |
|:------|:----|:------------|
| `ntfy-guide` | `skill://ntfy-guide/SKILL.md` | Gates and identifier rules for the `ntfy_*` tools: choosing the topic, one sequence id through a notification's updates, clear, and delete, reminders, and reading fetched history. Published from root `skills/` via `createApp({ skills: 'skills' })`; listed in `resources/list` and served through the SDK's `skill://{+path}` template. |

### Prompts

None. The publish tool is self-explanatory; no recurring multi-message templates worth structuring.

---

## Overview

ntfy is a pub/sub HTTP service for push notifications. Anyone with a topic name can publish; subscribers (phones, browsers, scripts) get the message. The MCP server is a thin authenticated wrapper: it lets agents send rich notifications (title, priority, tags/emojis, click actions, action buttons, scheduled delivery, attachments-by-URL, email/voice forwarding), manage prior messages by `sequence_id`, and read back cached topic history.

**Primary user goal:** an agent finishes a long-running task / detects an event / reaches a checkpoint, and notifies the human via their phone.

**Secondary goals:** progress updates (publish then update via `sequence_id`), reminders (`delay`/`at`), dead-man's-switch alerts (re-scheduled message), and audit/replay (`fetch`).

## Requirements

- Default to `https://ntfy.sh`; configurable for self-hosted ntfy via `NTFY_BASE_URL`.
- Optional auth: Bearer token (`tk_...`) or HTTP Basic. Both must work; only one is configured per registered server.
- Optional `NTFY_DEFAULT_TOPIC` so trivially-configured servers can omit `topic` from tool calls.
- Honour ntfy's documented limits (4096-byte message body, 15 MB attachment URL, ≤3 actions per message, a `delay` at least 10s out and at most 3 days out by default — the maximum is per server, ntfy's `message-delay-limit`). Surface limit-related rejections from the server as recoverable errors.
- Treat the topic as a secret (it's a password-equivalent) — never log topic names at `info` level. A failure message may name the topic the caller passed, quoted as plain text, since that caller already holds it.
- No local file uploads in v1. URL-based attachments only (`attach` field); the agent provides a public URL.

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `NtfyService` | ntfy HTTP API (`POST /` for JSON publish, `PUT /<topic>/<sequence_id>/clear`, `DELETE /<topic>/<sequence_id>`, `GET /<topic>/json?poll=1&...`). Wraps a timed raw `fetch` in `withRetry` from `@cyanheads/mcp-ts-core/utils` — not `fetchWithTimeout`, which would replace the upstream status with `ServiceUnavailable` before `httpErrorFromResponse` can map it. Each method accepts an optional per-call `baseUrl` override; when omitted, falls back to `NTFY_BASE_URL`. Auth header (Bearer or Basic) is injected only when the resolved base URL matches a registered server (`NTFY_BASE_URL` or an `NTFY_SERVERS` entry), with that entry's credentials — any other override goes out unauthenticated. | `ntfy_publish_message`, `ntfy_manage_message`, `ntfy_fetch_messages`, `ntfy://{topic}` |
| `EmojiTagService` | In-memory map of tag short code → emoji, parsed at startup from a TS module generated at build time from `docs/ntfy/emojis.md`. No external deps. | `ntfy_search_emoji_tags` |

`NtfyService` resilience: the retry boundary is the full round trip — request, body read, and response parsing — for publish, manage, and fetch alike. Backoff base 500ms (±25% jitter, doubling) over `NTFY_MAX_RETRIES` retries — 4 attempts at the default 3; `withRetry` enriches the final error with the attempt count. 429 and 5xx responses retry with the upstream `Retry-After` honoured (or the exponential delay if absent); a `Retry-After` longer than the time left ends the ladder with that answer, marked `(failed after N attempts)` once the call has already retried, so a 503 still classifies as `upstream_unreachable`. A first answer whose `Retry-After` the call cannot wait out — over 30 s (`withRetry`'s single-wait cap), or past the time left — fails at once, unmarked: nothing was retried, so nothing claims it was, and like an over-budget 429 (`rate_limited`) a 5xx so answered still classifies, as `upstream_unreachable`. Every `upstream_unreachable` carries ntfy's `retryAfter` when it sent one, with a recovery hint naming that wait. 4xx other than 408/429 do not retry, and neither does a `200` to a publish or a clear/delete whose reply is not ntfy's message envelope or cannot be read in full (a reset connection, the per-attempt timeout, or the call deadline cutting the body off): ntfy writes that `200` only after it has dispatched the message or event, so the request may already have taken effect, and it fails on the first attempt as `upstream_malformed` rather than being sent again (see Workflow Analysis). A timeout or reset before any response headers is still retried: ntfy may not have taken the request. Each attempt is bounded by `NTFY_REQUEST_TIMEOUT_MS`, and that timeout covers the body as well as the headers, so an upstream that sends headers and then stalls or trickles the body is cut off like one that never answers. At defaults the backoff adds at most ~4.4 s across the ladder, so a call whose every attempt answers promptly (a malformed body is a completed response) settles in about 4 round trips plus that.

The whole ladder runs inside one call deadline, `CALL_DEADLINE_MS` = 50 s, below the 60 s default request timeout of MCP SDK clients. Four attempts that each wait out the 15 s default timeout would take ~64 s; the deadline aborts the attempt in flight (or skips a backoff that would outlast it), so the ntfy round trips settle by 50 s whatever the upstream does. Two waits sit outside it: the `NTFY_BLOCK_PRIVATE_HOSTS` DNS lookup of a `base_url` override, bounded only by the system resolver, and the consent prompt on a clear, delete, or gated publish, which a 2025-era client answers inside the same request, so the client's 60 s clock runs through the user's decision too. Running out of it fails as `Timeout` with `data.reason: 'retry_deadline_exceeded'` and a message that names the round trip — `ntfy poll`, `ntfy publish`, `ntfy clear`, or `ntfy delete` (the `operation` label `withRetry` also sets as `data.operation` on an exhausted error) — which every tool and the `ntfy://{topic}` resource map to `upstream_unreachable`. When the deadline lands right after an attempt ntfy answered — a 429, a 5xx, a damaged poll body — or while a publish or clear/delete `200` is still being read, that answer is reported instead, marked `(failed after N attempts)` as count exhaustion marks it, so it still classifies as `rate_limited` or `upstream_malformed`. The caller's signal covers the same span — request, body read, and backoff, plus the `base_url` DNS lookup — and a cancellation surfaces as `RequestCancelled`, never retried and never reported as a result.

## Config

All env vars are optional except where noted. The server runs unauthenticated against `ntfy.sh` with no defaults if nothing is set. Blank, whitespace-only, and whole-value `${…}` placeholder values read as unset.

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `NTFY_SERVERS` | No | — | JSON array of `{ baseUrl, authToken? \| authUsername?+authPassword? }` entries, one per ntfy server. The first entry is the default base. Credentials are scoped to their entry's `baseUrl`: a per-call `base_url` that matches a registered base forwards that entry's auth, anything else goes out unauthenticated. Takes precedence over the single-server `NTFY_BASE_URL` / `NTFY_AUTH_*` shorthand below, which is expressed internally as a one-entry registry. |
| `NTFY_BASE_URL` | No | `https://ntfy.sh` | Base URL of the ntfy server (no trailing slash). |
| `NTFY_DEFAULT_TOPIC` | No | — | Topic used when a tool call omits `topic`. Without this, `topic` is required on every call. |
| `NTFY_AUTH_TOKEN` | Conditional | — | Bearer access token (`tk_...`). Mutually exclusive with `NTFY_AUTH_USERNAME` / `NTFY_AUTH_PASSWORD` — startup hard-fails with a config error if both modes are set, to avoid silent ambiguity about which credential was used. |
| `NTFY_AUTH_USERNAME` | Conditional | — | Basic auth username. Required together with `NTFY_AUTH_PASSWORD`. Mutually exclusive with `NTFY_AUTH_TOKEN`. |
| `NTFY_AUTH_PASSWORD` | Conditional | — | Basic auth password. Required together with `NTFY_AUTH_USERNAME`. Mutually exclusive with `NTFY_AUTH_TOKEN`. |
| `NTFY_REQUEST_TIMEOUT_MS` | No | `15000` | Per-attempt HTTP timeout in milliseconds, covering the response body as well as the headers. Every call is also capped at 50 s across all attempts. |
| `NTFY_MAX_RETRIES` | No | `3` | Max retry attempts for transient upstream failures (5xx, network, 429). |
| `NTFY_BLOCK_PRIVATE_HOSTS` | No | `false` | When `true`, a per-call `base_url` override that is not a registered server must resolve to a public address, and its redirects are not followed. A refused redirect — a rejection of `fetch` itself — fails as a non-retryable `ValidationError` naming the hop; once ntfy has answered, its status and error text classify as on any other path, even when the text mentions a redirect. Registered servers are exempt, so a deliberate LAN target still works. |
| `NTFY_ENABLE_EMOJI_TAGS` | No | `true` | When `false`, `ntfy_search_emoji_tags` is wrapped in `disabledTool()`: it is absent from `tools/list` and `/.well-known/mcp.json`, appears only on the startup line (`(+1 disabled: ntfy_search_emoji_tags)`) and the HTTP landing page, and the `instructions` parenthetical and the two pointer sentences in `ntfy_publish_message` (`description`, `tags`) are dropped. Any value `z.stringbool()` rejects fails startup with a `ConfigurationError` naming the variable, printed raw since it is thrown at module load, before `createApp()` could format it as the banner. |

`NTFY_ENABLE_EMOJI_TAGS` is read when the definition modules load, not inside `createApp()`, so it has its own accessor, `isEmojiTagsEnabled()`, which parses only that variable; an invalid value of any other `NTFY_*` variable still surfaces through the startup banner. The framework reads `./.env` only inside `createApp()` (cyanheads/mcp-ts-core#562), so `src/index.ts` first imports `src/config/load-env-file.ts`, which loads `./.env` with `process.loadEnvFile()` (a missing file is ignored, a set variable is never overridden) before any definition module evaluates.

## Implementation Order

1. **Config & service skeleton** — `src/config/server-config.ts` (Zod schema, lazy parse), bare `NtfyService` with auth-header builder + timed `fetch` wrapper.
2. **Emoji tag data** — `scripts/build-emoji-tags.ts` parses `docs/ntfy/emojis.md` → emits `src/services/emoji-tags/data.generated.ts`. `EmojiTagService` consumes it. Search uses substring match.
3. **`ntfy_publish_message`** — main tool; calls `NtfyService.publish()` (POST `/` JSON body). Cover all publish fields. Smoke test against `ntfy.sh/<random_topic>` from the phone app.
4. **`ntfy_manage_message`** — clear/delete via `NtfyService.manage()`. Verify subscriber receives `message_clear` / `message_delete` events.
5. **`ntfy_fetch_messages`** + **`ntfy://{topic}`** resource — `NtfyService.fetch()` (GET with `poll=1`); parse NDJSON response into a typed array, surface `since` / filter args. The resource is a thin wrapper that calls `fetch()` with a fixed `since: '1h'` and keeps the latest 20 messages.
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

No multi-call workflows — every tool maps to a single upstream HTTP request. The retry boundary in `NtfyService` covers the full round trip including response parsing. A message envelope is what ntfy writes for every message, event, and `open` / `keepalive` frame: string `id`, `event`, and `topic`, numeric `time` — none of the four is `omitempty` in ntfy's message struct, and every caller reads all four. The reply to a publish (`POST /`) or a clear/delete is one envelope (a clear/delete also names the `sequence_id` it references); an empty body, a body that fails `JSON.parse`, or JSON that is not that envelope throws `ServiceUnavailable` with `data.reason: 'upstream_malformed'` and `retryable: false`, and so does a body that fails partway through being read — a reset connection, or the per-attempt timeout or the call deadline cutting it off — with a message that says reading the `200` reply failed and names the cause (`terminated (other side closed)`, `ECONNRESET: …`, the `NTFY_REQUEST_TIMEOUT_MS` value, or the deadline). The flag is what keeps `withRetry` from sending the request again: ntfy writes the `200` only after it has dispatched (or, for a delayed publish, scheduled) the message or event, so it may already be out, and a resend would deliver it twice. A caller abort mid-read still surfaces as `RequestCancelled`. A poll body is NDJSON, one envelope per non-blank line; a line that fails `JSON.parse` or is not a message envelope means the rest of the body can't be trusted either — an HTML error page, a captive portal, a cut-off or corrupted stream — so it throws a transient `ServiceUnavailable` carrying `data.reason: 'upstream_malformed'` and the poll is re-issued, rather than the survivors being reported as the whole window. A line that is ntfy's JSON error body (`{ code, http, error }`), which ntfy writes onto an already-started `200` replay when a limit trips mid-stream, surfaces as the HTTP error it names, through the same mapping a non-OK response takes. Blank lines and `\r\n` separators are ignored; `open` / `keepalive` frames parse as envelopes and the callers drop them. ntfy's `X-Messages-Truncated: 1` response header (its per-topic poll size cap kept only the newest messages) is returned alongside the messages as `upstreamTruncated`.

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

- `delay?: string` — duration (`30m`, `2h`, `1d` — unlike `since`, ntfy's delay parser accepts a `d` unit), Unix timestamp, or natural-language time (`tomorrow, 10am`, `Tuesday, 7am`). 10s minimum, which ntfy fixes; maximum 3 days by default, which each ntfy server can change (`message-delay-limit`). Server parses — pass through verbatim; a rejection fails as `invalid_delay`.
- `email?: string` — address to forward to (`"phil@example.com"`), or `"yes"` to use the authenticated user's first verified address.
- `call?: string` — phone number in `+CCNNNNNNNNNN` format, or `"yes"` to use the authenticated user's first verified number. Requires an authenticated ntfy account with a verified phone number; ntfy.sh limits this to Pro plans.
- `sequence_id?: string` — provide to update or replace a previously-published message instead of creating a new one. Same value used by `ntfy_manage_message` for clear/delete. Constrained to `^[a-zA-Z0-9_-]{1,64}$` because the value ends up in URL paths for clear/delete (`/<topic>/<sequence_id>/clear`).
- `cache?: boolean` (default `true`) — set `false` to skip server-side caching (live subscribers still receive it, but `ntfy_fetch_messages` and reconnecting clients won't see it). Sent as the `X-Cache: no` HTTP header — ntfy's JSON publish API doesn't accept `cache` in the body.
- `firebase?: boolean` (default `true`) — set `false` to skip Firebase Cloud Messaging forwarding (delays Android delivery up to 15 min unless instant delivery is enabled on the recipient's app). Sent as the `X-Firebase: no` HTTP header — ntfy's JSON publish API doesn't accept `firebase` in the body.
- `base_url?: string` — overrides the configured `NTFY_BASE_URL` for this single call. Useful for one-off publishes to a different ntfy host (e.g., default is self-hosted, but a public-topic ping goes to `ntfy.sh`). When the override matches no registered server (`NTFY_BASE_URL` or an `NTFY_SERVERS` entry), server-configured auth credentials are **not** forwarded — the request goes out unauthenticated to avoid leaking the server's identity to an arbitrary URL the agent picked. For protected topics on another host, register it in `NTFY_SERVERS` with its own credentials.

**Output:**

```ts
{
  id: string;                 // server-assigned ID of this message; when the call set no sequence_id, pass it as sequence_id to update, clear, or delete the notification later — when the call set one, that value (echoed as sequence_id) stays the one to pass, and this id would start a separate notification
  time: string;               // ISO 8601 — when ntfy accepted the message on an immediate publish; the scheduled delivery time (in the future) when `delay` was set
  topic: string;              // topic the message was published to
  url: string;                // human-readable topic URL (e.g., "https://ntfy.sh/mytopic"); SYNTHESIZED by the tool from `${baseUrl}/${topic}` — ntfy does not return this in its response
  expires?: string;           // ISO 8601 when the message ages out of server cache; ABSENT when published with cache: false
  sequence_id?: string;       // ABSENT on a fresh publish; PRESENT only when the call updated an earlier message and the input sequence_id differed from the new id
  scheduled?: boolean;        // true ONLY when `delay` was set and the message is queued for later delivery; ABSENT/false on immediate publishes
  title?: string;             // echo of input title; ABSENT when not set (recipient defaults to the topic URL)
  message?: string;           // echo of input message; "triggered" when the input body was empty
  markdown?: boolean;         // true when ntfy echoed `content_type: "text/markdown"` (the body was published as Markdown); ABSENT for plain text
  priority?: 1|2|3|4|5;       // echo of input priority; ABSENT when none was set (ntfy delivers at the default, 3); an explicit 3 is echoed as 3
  tags?: string[];            // echo of input tags; ABSENT when no tags were set
  click?: string;             // echo of input click URL; ABSENT when not set
  attachment?: { name: string; url: string; type?: string; size?: number; expires?: number };  // ABSENT when no attachment was set; matches the documented JSON message format used by subscribe responses
  actions?: Action[];         // echo of the input action buttons; ABSENT when none were set
}
```

**`format()`** renders the scheduled-vs-sent banner with id and topic, URL, accept or delivery time, cache expiry, sequence ID, title, priority badge, tags, message body, click URL, attachment, and one list item per action button. Every output field above appears in the rendered text. Every string ntfy echoes renders literally, through `literal()` / `literalBlock()` in `src/mcp-server/tools/utils/markdown-literal.ts`: an inline code span sized past the value's longest backtick run, or a `text` fence on lines of its own when the value holds a line break (a code span can't hold one — a line starting `#`, `-`, or `>` would open a block of its own). An empty string renders as a bare `(empty)` marker, since an empty code span is two backticks that read as stray characters; any non-empty value, `(empty)` included, is a code span, so the two never collide. URLs are code spans, not links; each action is its JSON in a code span; the body is a fence with info `markdown` when `markdown` is set and `text` otherwise. `structuredContent` keeps every value byte-identical to ntfy's echo. Backslash escaping was not chosen: an escaped value no longer matches the raw string an agent copies into the exact-match `title` / `message` filters of `ntfy_fetch_messages`.

**Errors (typed contract):**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `consent_declined` | `Forbidden` | The publish carried an out-of-band side effect (`email`, `call`, or a `broadcast`/`http` action button), the user was asked to confirm it, and declined, cancelled, or answered with a payload that did not parse. Logged at `notice`. | Confirm with the user which recipient or action they intended, or drop `email` / `call` / the action button and publish as a plain notification. |
| `forbidden_topic` | `Forbidden` | ntfy refused access to the topic with its own 401 or 403 error: the topic needs credentials this server did not send, or the ones it sent lack access. | Try a public topic instead; if this topic must stay protected, ask the operator to configure ntfy auth (`NTFY_AUTH_TOKEN`, or `NTFY_AUTH_USERNAME` + `NTFY_AUTH_PASSWORD`, or per-host entries in `NTFY_SERVERS`) before retrying. |
| `rate_limited` | `RateLimited` | Upstream returned 429 after retries were exhausted. Retryable. | Wait the rate-limit window before retrying, or reduce publish frequency — `retryAfter` seconds when the error carries it. A request-rate limit (`too many requests`) clears within minutes; a daily quota (`daily … reached`) resets within 24 hours. |
| `payload_too_large` | `ValidationError` | Upstream returned 413, or rejected a field as too large — the message body or attachment exceeds server limits (an attachment also fails once the client's attachment storage or daily bandwidth quota is used up), or the `title` or the combined `tags` are longer than ntfy accepts. | Shorten the field ntfy rejected: the message (≤4096 bytes plain, or host the long content as an external URL via `attach`), the `title`, or the `tags` (ntfy limits their combined length). When ntfy refused an attachment, drop `filename` or host the file and pass its URL as `attach`; a used-up bandwidth quota resets within 24 hours. |
| `invalid_delay` | `ValidationError` | ntfy rejected `delay`: it could not parse the value, or the time it names is less than 10 seconds out or past the server maximum. | Resend with `delay` as a duration (`30m`, `2h`, `1d`), a Unix timestamp, or a natural-language time (`tomorrow, 10am`), at least 10 seconds out and within the server maximum (3 days on ntfy.sh). |
| `invalid_attachment` | `ValidationError` | ntfy rejected the `attach` URL as malformed. | Pass `attach` an absolute URL (`https://host/path/file.jpg`) to an already-hosted file — the recipient device fetches it, so a local path will not work, and shortening the message will not help. |
| `unverified_contact` | `ValidationError` | `email`/`call` set but the authenticated user has no verified address/number, or auth is missing. | Drop the `email`/`call` field and resend; if forwarding is essential, ask the operator to verify the address or number in the ntfy account settings. |
| `upstream_unreachable` | `ServiceUnavailable` | A DNS, connection, or network failure or a 5xx answer that outlasted the retries, no complete answer within the call deadline, or a 5xx whose `Retry-After` is longer than the call can wait. Retryable. | When the error carries `retryAfter`, the ntfy server is answering and asked for that wait: resend the publish once it has passed. Otherwise verify the configured `NTFY_BASE_URL` (or per-call `base_url`) resolves and is reachable; check network connectivity, then retry. |
| `upstream_malformed` | `ServiceUnavailable` | The server answered the publish with a 2xx success but a reply that is not an ntfy message (an empty body, an HTML page, JSON without ntfy's message fields) or that could not be read in full (the connection reset, or a timeout or the call deadline cut it off). Not retried, since the notification may already be out. | The notification may already have been delivered — call `ntfy_fetch_messages` on the topic before resending, so a resend does not deliver it twice. Fetch with the same `base_url` this publish used, and with `scheduled: true` if it set `delay`; without them the fetch cannot see this message. If `base_url` (or the configured `NTFY_BASE_URL`) does not point at an ntfy server, correct it first. |

`consent_declined` is thrown in the handler; every other reason is raised from the upstream failure (`thrownBy: 'service'`) — `upstream_malformed` by `NtfyService.publish()` itself, which `classifyPublishError` passes through before its `upstream_unreachable` check could claim it, and the rest by `classifyPublishError`. Baseline `ServiceUnavailable` / `ValidationError` / `Timeout` bubble freely.

The 400 sub-reasons are read from phrases in ntfy's `error` text, never from the docs link ntfy appends to it (every phrase holds a space, which a URL cannot). ntfy's three `delay` rejections (40004 unparseable, 40005 under 10 s, 40006 past the maximum) share the prefix `invalid delay parameter`, which is matched before anything else because 40006 also says "too large"; ntfy's other delay-related rejections (40002 caching off, 40003 e-mail, 40015 attachment expiry, 40037 call, 40059 timezone) stay unclassified, since their text already names the conflict. `payload_too_large` has four triggers, and the hint thrown with each failure names only the one that fired: the `title` for 40057 (`invalid request: title is too large`), the `tags` for 40058 (`invalid request: tags are too large`), the attachment for the 413 41301 (`attachment too large, or bandwidth limit reached` — ntfy stores the message as a file when `filename` is set without `attach`, or when the message is over the server's message limit, and the file or the client's attachment storage or daily bandwidth quota was over its limit), and the message body for any other 413 (41303 `JSON body too large`, 41302 Matrix) or oversize rejection. The declared `recovery` above names them all. `unverified_contact` covers ntfy's refusals of an `email` or `call`: the address or number is not verified (40034, 40052), with the declared recovery, or the request carried no credentials (40035 `anonymous phone calls are not allowed`, 40053 `anonymous email sending is not allowed`), with a hint naming ntfy credentials instead. ntfy's other e-mail and phone rejections — 40032 `calling is disabled`, 40033 `phone number invalid`, 40001 `e-mail notifications are not enabled`, 40050 `invalid e-mail address` — name their own fix and stay unclassified, keeping ntfy's text and docs link in the message.

`forbidden_topic` is read from ntfy's own error envelope: the captured body must carry a `401xx` or `403xx` `code` that matches the response's own 401 or 403 status (`isAuthRejection`; ntfy always pairs a code with its status), on every surface that declares the reason. A 401 or 403 without that envelope — the HTML page a reverse proxy answers with, for a reason of its own — fails without a reason, keeping the upstream status in the message.

A thrown message names a value — the topic, a `sequence_id`, a `cursor` or `since` — in double quotes as plain text, never through `literal()`: the framework Markdown-escapes an error's message in `content[]`, so a code span there would show its backticks, while a quoted value reads back exactly through a CommonMark parse and `structuredContent.error.message` carries it byte for byte. The consent prompt is not escaped by the framework and keeps `literal()`.

### `ntfy_manage_message`

Inputs: `topic`, `sequence_id`, `operation: 'clear' | 'delete'`, `base_url?: string` (per-call override; same auth-isolation rule as `ntfy_publish_message` — configured credentials are not forwarded when the override matches no registered server). Output: `{ event_id, topic, sequence_id, operation, time }` echoing the emitted event — `event_id` is the event's own ID, distinct from the `sequence_id` it references. Message state is idempotent — a second clear or delete of the same `sequence_id` changes nothing — but the call is not: ntfy's clear and delete are append-only, so each call emits a fresh `message_clear` / `message_delete` event that is delivered to subscribers, cached, and counted against the message quota. The tool therefore advertises no `idempotentHint`, and repeated calls are never deduplicated.

**`format()`** renders the `CLEARED` / `DELETED` banner with the sequence and topic, then the event ID, operation, and time. The topic, sequence ID, and event ID ntfy echoes render through `literal()`, as in `ntfy_publish_message`, and so do the topic and `sequence_id` named in the confirmation prompt. The `consent_declined`, `forbidden_topic`, and `not_found` messages quote them in double quotes as plain text instead, as every thrown message does (see `ntfy_publish_message` above).

**Errors:**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `consent_declined` | `Forbidden` | The user was asked to confirm the clear/delete and declined, cancelled, or answered with a payload that did not parse. Logged at `notice`. | Check with the user which message they meant, then reissue the call with the corrected `topic` and `sequence_id` — do not retry the same arguments unchanged. |
| `forbidden_topic` | `Forbidden` | ntfy refused access to the topic with its own 401 or 403 error: the topic needs credentials this server did not send, or the ones it sent lack access. | Try an unprotected topic instead; if this topic must stay protected, ask the operator to configure ntfy auth (`NTFY_AUTH_TOKEN`, or `NTFY_AUTH_USERNAME` + `NTFY_AUTH_PASSWORD`, or per-host entries in `NTFY_SERVERS`) before retrying. |
| `not_found` | `NotFound` | Stricter ntfy variants returned 404 because the sequence_id was never published to this topic, or the cache window has elapsed; ntfy.sh accepts unknown sequences without error. | Confirm the topic and `sequence_id` were correct (call `ntfy_fetch_messages` to inspect what is still cached), or accept that the message has aged out (default cache window is 12h). |
| `rate_limited` | `RateLimited` | ntfy answered 429 and was still answering it when retries ran out. Retryable. | Wait for ntfy's rate-limit window to pass before reissuing the clear or delete — `retryAfter` seconds when the error carries it. A request-rate limit (`too many requests`) clears within minutes; a daily quota (`daily … reached`) resets within 24 hours. |
| `upstream_unreachable` | `ServiceUnavailable` | A DNS, connection, or network failure or a 5xx answer that outlasted the retries, no complete answer within the call deadline, or a 5xx whose `Retry-After` is longer than the call can wait. Retryable. | When the error carries `retryAfter`, the ntfy server is answering and asked for that wait: reissue the clear or delete once it has passed. Otherwise verify the configured `NTFY_BASE_URL` (or per-call `base_url`) resolves and is reachable; check network connectivity, then retry. |
| `upstream_malformed` | `ServiceUnavailable` | The server answered the clear or delete with a 2xx success but a reply that is not an ntfy event (an empty body, an HTML page, JSON without ntfy's message fields or the `sequence_id`) or that could not be read in full (the connection reset, or a timeout or the call deadline cut it off). Not retried, since the event may already be out. | The clear or delete may already have taken effect — call `ntfy_fetch_messages` on the topic, with the same `base_url` this call used, and look for a `message_clear` / `message_delete` event carrying this `sequence_id` before reissuing it. If `base_url` (or the configured `NTFY_BASE_URL`) does not point at an ntfy server, correct it first. |

`upstream_malformed` is raised by `NtfyService.manage()` (`thrownBy: 'service'`) and checked before `upstream_unreachable`, which would otherwise claim it.

### `ntfy_fetch_messages`

**Inputs:**

- `topic: string` — single topic or comma-separated list (e.g., `"alerts"` or `"alerts,backups,phil_alerts"`). Required when `NTFY_DEFAULT_TOPIC` is unset. Each topic is 1–64 characters of `[a-zA-Z0-9_-]`, ntfy's own per-topic limit (hard-coded since v1.3.0; a longer topic gets ntfy's bare `404 page not found`). The cap sits in the advertised `pattern` (`^[a-zA-Z0-9_-]{1,64}(?:,[a-zA-Z0-9_-]{1,64})*$`) rather than a `.max(64)`, because it applies per topic, so an over-long topic fails validation, naming the limit, before any request. The number of topics is not capped: ntfy v2.33.0 and later refuse more than 150 (`invalid request: too many topics`), but earlier servers answer longer lists, which a schema cap would reject.
- `since?: string` — the window's lower bound. Defaults to `"10m"` as a tool-level guardrail (ntfy's own default is `"all"`; the tighter window keeps the most common "did my recent notification land?" use case cheap). Accepts a Go duration in `s`, `m`, or `h` (`30s`, `10m`, `2h`, `24h` — ntfy rejects `1d` with HTTP 400 `invalid since parameter`), a Unix timestamp, the keywords `"all"` (every cached message — up to ~12h on ntfy.sh) or `"latest"` (only the most recent message), or a message ID, which returns only the messages after that one; an ID ntfy no longer holds returns the whole cache, not an error. The value is trimmed, and a blank or whitespace-only `since` means unset: the handler sends and echoes `10m`, since an empty `since` would reach ntfy as no bound and widen the window to `all`. Rejecting the blank was not chosen: form clients submit `""` for untouched fields, and `base_url` already reads `""` as no override. `since` bounds the window; it is not a pagination lever — `cursor` is, and a walk keeps the same `since` on every page, a duration included (see `cursor`).
- `scheduled?: boolean` — default `false`. Set `true` to include delayed/not-yet-delivered messages.
- `priority?: (1|2|3|4|5)[]` — match any priority in the list (logical **OR**). Empty/omitted matches all priorities.
- `tags?: string[]` — match all tags in the list (logical **AND**). Empty/omitted matches all messages regardless of tags. Each entry is trimmed; a whitespace-only entry is dropped.
- `id?: string` — exact-match a single message ID. Pinning one message also lifts the ~500-char body cap, so this is the retrieval path for a body the list view cut. `since` still bounds which cached messages are searched, so the retry needs a window wide enough to still include the message. `id`, `title`, and `message` are trimmed the way ntfy trims query parameters, and an empty or whitespace-only value is no filter at all: it is not sent, not echoed in `appliedFilters`, and never lifts the body cap — the response stays a list and stays capped. A blank filter gets no notice; leaving it out of `appliedFilters` already says nothing was applied.
- `title?: string` — exact-match against the title string.
- `message?: string` — exact-match against the message body.
- `limit?: number` — client-side cap on returned messages, default `20`. One call returns at most `100`: a larger value (schema ceiling `1000`, against absurd input) is served as `100`, and when the window holds more than that the notice names the cap. Without `cursor`, the newest `limit` of the window are returned (still listed oldest-first).
- `cursor?: string` — a previous response's `nextCursor`, passed back with the same `topic`, `since`, and filters. The handler fetches the window as usual, finds the message whose `id` equals the cursor, and returns up to `min(limit, 100)` messages starting at it (inclusive), oldest-first. Blank means unset. ntfy offers no offset, upper bound, or server-side limit on a poll, and `since=<id>` returns only messages after that one, so the cursor is resolved inside the window this server already fetched. Anchoring on a message ID instead of an offset keeps a walk stable: new messages append after the cursor, and messages expiring before it don't shift later pages. A duration `since` needs one more step. ntfy measures it from its own clock on every call, so the window's oldest messages, which are the first a walk asks for, are the first to fall out of it: under `66s`, the first cursor page failed six seconds later on ntfy.sh. So under a duration the cursor also carries where the walk began, as `<id>@<unix seconds>`: the oldest `time` in the window of the call that started the walk. A cursor page whose `since` is a duration polls with that Unix time as `since` instead, and passes the same start on in its `nextCursor`. ntfy reads a Unix-timestamp `since` inclusively (`time >= since`; on ntfy.sh, two messages delivered at the same second both come back for that second and neither for the next), so the pinned window holds every message of the original one plus later arrivals. The start comes from ntfy's own message times, so this server's clock never enters it. Duration detection follows ntfy's `parseSince` order: a 12-character alphanumeric value is a message ID and an integer is a timestamp before anything is read as a Go duration. Every other `since` form has a fixed bound, so its cursor stays the bare message ID and its pages send `since` as given. A bare-ID cursor on a duration call still works while its message is inside the duration, and the response's `nextCursor` carries a start from then on. The window keeps the first message of any repeated `id` and drops the rest, with a warning log. ntfy never repeats an ID; a non-ntfy upstream that did would give the cursor two positions, and the walk could be handed the same cursor forever. A cursor the window doesn't hold fails with `cursor_not_found` rather than silently restarting from the top.
- `base_url?: string` — per-call override of `NTFY_BASE_URL`. Same auth-isolation rule as `ntfy_publish_message`.

Single round trip — no streaming.

**Output:**

```ts
{
  messages: Array<{
    id: string;                   // message ID — pass back as `id` for the whole body; to update, clear, or delete its notification pass the row's `sequence_id` when present (update / clear / delete rows), else this `id`; paging uses `nextCursor`, not this ID as `since`
    time: string;                 // ISO 8601 timestamp when ntfy accepted the message
    event: 'message' | 'message_clear' | 'message_delete' | 'poll_request';
    topic: string;                // matching topic (one of the requested topics on multi-topic queries)
    expires?: string;             // ISO 8601 when the message ages out of cache; ABSENT when published with cache: false
    sequence_id?: string;         // PRESENT on update / clear / delete events pointing back to the original message; ABSENT on initial publishes
    title?: string;               // ABSENT when no title was set (recipient clients fall back to the topic URL)
    message?: string;             // ABSENT on clear/delete events; truncated to ~500 chars when the body is longer, unless the call pinned one message via `id`
    messageTruncated?: number;    // count of additional chars dropped from `message`; refetch with this message's `id` plus a `since` window covering it for the whole body; ABSENT when the full body fits
    markdown?: boolean;           // true when ntfy tagged the message `content_type: "text/markdown"`, so `message` is Markdown source; ABSENT for plain text
    priority?: 1|2|3|4|5;         // ABSENT when the publish set none (ntfy delivers at the default, 3); an explicit 3 comes back as 3
    tags?: string[];              // ABSENT when no tags were set
    click?: string;               // ABSENT when no click URL was set
    actions?: Action[];           // same shape as the publish input's `actions`; ABSENT when none
    attachment?: { name: string; url: string; type?: string; size?: number; expires?: number };  // ABSENT when no attachment
  }>;
}
```

**Enrichment** (merged into `structuredContent` and mirrored as a `content[]` trailer, never authored into `format()`): `topic` and `since` echo the resolved values (useful when `NTFY_DEFAULT_TOPIC` or the `10m` default filled in; on a cursor page under a duration, `since` is the Unix time where the walk began, the value actually sent), `appliedFilters` echoes the active filter inputs (absent when none were set), `count` is the number of messages returned, `totalCount` the number in the fetched window after `open` / `keepalive` frames and repeated IDs are dropped and before `limit` / `cursor` apply (set on every response; a plain field rather than `ctx.enrich.total()`, whose "N total" trailer would read as every match under ntfy's replay cap). On a cursor page under a duration, that window runs from where the walk began rather than from the duration, so `totalCount` counts arrivals since the first page and drops what expired. `truncated` is exactly `count < totalCount` — so a final cursor page is still `truncated`, since the earlier pages hold the rest — and `nextCursor` names the first message the caller has not been given in oldest-first order: the oldest message of the window after an uncursored call that left some out, the message after the page on a cursor call, absent on the last page, on an empty result, and when nothing was left out. It is that message's `id`, followed under a duration `since` by `@` and the walk's start in Unix seconds; callers pass it back verbatim. `upstreamTruncated` is true when ntfy itself capped the replay (`X-Messages-Truncated`) and dropped the oldest messages in the window before responding (absent otherwise; those messages are unreachable through this server, and any count reported is of what ntfy returned), and `notice` carries guidance on empty or truncated results, one sentence per condition. While `nextCursor` is set, the notice names `cursor` with its literal value, says to repeat the same `topic`, `since`, and filters, and gives `totalCount`; it suggests raising `limit` only when `limit` is below 100 and fewer than 100 matched, never on a cursor page under a duration (a fresh call under that duration no longer reaches where the walk began), and never offers a tighter `since` or a message `id` as a way to reach left-out messages. A final cursor page that is `truncated` says it is the last page. `upstreamTruncated` is its own field rather than a case of `truncated`: one is this server's cut, which the caller can undo, the other is ntfy's, which it can't.

The tool filters out `open` and `keepalive` events client-side (they're connection-level frames, not notification data), and keeps only the first message of a repeated `id` (see `cursor`). `format()` renders one `###` block per message — id, event type, and topic in the header, then time, cache expiry, referenced sequence, title, priority badge, tags, click URL, attachment, one list item per action button, and the (possibly truncated) message body — with a `(N chars more)` suffix on truncated messages. Every output field above appears in the rendered text. Every ntfy-supplied string renders literally, as in `ntfy_publish_message`: a sized code span, or a `text` fence on its own lines for a value with a line break; URLs and actions as code spans, the body as a `markdown` or `text` fence — so no message's content can open a block that swallows the next message's header. `structuredContent` keeps every value as ntfy sent it. The `**Filters:**` trailer and the notices wrap the topic, `since`, cursor, and filter values in the same spans; the `cursor_not_found` and `forbidden_topic` messages quote them in double quotes as plain text, as every thrown message does (see `ntfy_publish_message`); an `invalid_since` message is ntfy's own text. The framework-rendered enrichment scalars (`**since:** …`, `**nextCursor:** …`) render as code spans, so a copied value carries no escapes.

**Errors:**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `forbidden_topic` | `Forbidden` | ntfy refused access to the topic with its own 401 or 403 error: the topic needs credentials this server did not send, or the ones it sent lack access. | Try an unprotected topic instead; if this topic must stay protected, ask the operator to configure ntfy auth (`NTFY_AUTH_TOKEN`, or `NTFY_AUTH_USERNAME` + `NTFY_AUTH_PASSWORD`, or per-host entries in `NTFY_SERVERS`) before retrying. |
| `invalid_since` | `ValidationError` | ntfy rejected `since` as `invalid since parameter` (a malformed duration or timestamp, or a duration unit other than `s`, `m`, `h`). Any other 400 keeps ntfy's own text and carries no reason. | Use one of: `all`, `latest`, a duration like `10m` / `2h` / `24h` (units `s`, `m`, `h`), a Unix timestamp (seconds), or a message ID. |
| `cursor_not_found` | `NotFound` | `cursor` names no message in the fetched window: its message expired from ntfy's cache or fell outside ntfy's replay, or the cursor came from a call with a different `topic`, `since`, or filters. | Call again without `cursor` to restart from the newest messages and page from the new `nextCursor`, or widen `since` (for example to `all`) if the message should still be cached. |
| `rate_limited` | `RateLimited` | ntfy answered 429 — on the status line, or as an error line written into the replay — and was still answering it when retries ran out. Retryable. | Wait for ntfy's rate-limit window to pass before polling again — `retryAfter` seconds when the error carries it. A request-rate limit (`too many requests`) clears within minutes; a daily quota (`daily … reached`) resets within 24 hours. |
| `upstream_unreachable` | `ServiceUnavailable` | A DNS, connection, or network failure or a 5xx answer that outlasted the retries, no complete answer within the call deadline, or a 5xx whose `Retry-After` is longer than the call can wait. Retryable. | When the error carries `retryAfter`, the ntfy server is answering and asked for that wait: poll again once it has passed. Otherwise verify the configured `NTFY_BASE_URL` (or per-call `base_url`) resolves and is reachable; check network connectivity, then retry. |
| `upstream_malformed` | `ServiceUnavailable` | The poll response was not ntfy's JSON message stream (an HTML page, a cut-off or corrupted body) on every attempt. Retryable. | The server at the base URL answered with something other than ntfy's JSON message stream. Check that `base_url` (or the configured `NTFY_BASE_URL`) points at an ntfy server, then retry. |

`upstream_malformed` is raised by the service (`thrownBy: 'service'`) and checked before `upstream_unreachable`, which would otherwise claim it. An ntfy error line inside a `200` poll body fails with that line's HTTP status and `error` text, mapped as a non-OK response would be — a mid-stream 429 is `rate_limited`, a mid-stream 40301 `forbidden_topic`. `forbidden_topic` needs ntfy's own envelope, as on publish: a proxy's HTML 401 or 403 fails without a reason, keeping its status in the message.

### `ntfy_search_emoji_tags`

Inputs: `query?: string` (substring match against tag name), `limit?: number` (default 25; one call returns at most 200 — a larger value, up to the schema ceiling of 1000, returns 200 and the notice names the next `offset`), `offset?: number` (default 0 — pages through matches past the `limit` cap; the reference holds far more tags than one call returns).

Output: `{ matches: Array<{ tag: string; emoji: string }> }`. The bundled `docs/ntfy/emojis.md` is a flat tag→emoji list — no aliases or categories to surface.

**Enrichment:** `effectiveQuery` (the query as parsed, absent when none was given), `totalCount` (matches before `limit`/`offset`), `truncated` (matches remain past this page — advance with `offset`), and `notice` (guidance when nothing matched or matches remain unseen). The empty-result notice renders the query through `literal()`.

`format()` renders a Markdown table of `tag` → `emoji` rows — header plus rows, no footer.

**Errors:** none declared — the definition has no `errors[]`; input validation and baseline errors only.

**Gate:** with `NTFY_ENABLE_EMOJI_TAGS=false` the definition is wrapped in `disabledTool()` (reason "Emoji tag lookup is turned off in this deployment.", hint `NTFY_ENABLE_EMOJI_TAGS=true`), so the framework skips it at registration — see [Config](#config). `EmojiTagService` still initializes in `setup()` in both states: `data.generated.ts` is imported statically either way, and gating it would save only building the tag map.

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
  upstreamTruncated: boolean; // true when ntfy itself capped the replay (X-Messages-Truncated) and dropped older messages
}
```

**Errors:**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `forbidden_topic` | `Forbidden` | ntfy refused access to the topic with its own 401 or 403 error: the topic needs credentials this server did not send, or the ones it sent lack access. | Try an unprotected topic; if this topic must stay protected, ask the operator to configure ntfy auth (`NTFY_AUTH_TOKEN`, or `NTFY_AUTH_USERNAME` + `NTFY_AUTH_PASSWORD`, or per-host entries in `NTFY_SERVERS`). |
| `rate_limited` | `RateLimited` | ntfy answered 429 — on the status line, or as an error line written into the replay — and was still answering it when retries ran out. Retryable. | Wait for ntfy's rate-limit window to pass before reading the topic again — `retryAfter` seconds when the error carries it. A request-rate limit (`too many requests`) clears within minutes; a daily quota (`daily … reached`) resets within 24 hours. |
| `upstream_unreachable` | `ServiceUnavailable` | A DNS, connection, or network failure or a 5xx answer that outlasted the retries, no complete answer within the call deadline, or a 5xx whose `Retry-After` is longer than the call can wait. Retryable. | When the error carries `retryAfter`, the ntfy server is answering and asked for that wait: read the topic again once it has passed. Otherwise read the topic again shortly; if it keeps failing, ask the operator to check that the configured `NTFY_BASE_URL` resolves and is reachable from this server. |
| `upstream_malformed` | `ServiceUnavailable` | The poll response was not ntfy's JSON message stream (an HTML page, a cut-off or corrupted body) on every attempt. Retryable. | The server at the configured `NTFY_BASE_URL` answered with something other than ntfy's JSON message stream. Read the topic again; if it persists, ask the operator to point `NTFY_BASE_URL` at an ntfy server. |

Resolves to a single upstream `GET` via the same `NtfyService.fetch()` retry boundary and call deadline as `ntfy_fetch_messages`, and maps its failures the same way: a poll body that is not ntfy's JSON message stream fails the read as `upstream_malformed` — never a short or empty snapshot — checked before `upstream_unreachable`, which would otherwise claim it; a refused connection or 5xx that outlasts the retries, a 5xx whose `Retry-After` the read cannot wait out (unretried, carrying `retryAfter` and a hint naming that wait), or a read cut off by the call deadline, fails as `upstream_unreachable` (`-32000`), never as the framework's internal `Timeout` / `retry_deadline_exceeded` and never unlabelled. The recovery hints name only what a reader of the resource can do — read again, or escalate to the operator — since a resource takes no `base_url`.

## Design Decisions

- **One publish tool, not many.** ntfy's 18 publish parameters could fan out into themed tools (`alert`, `progress`, `reminder`, `phone-call`), but the API is one POST and the agent benefits from seeing all options in one place. Splitting forces the LLM to pick a tool before knowing what shape the call should take. Single tool keeps tool-selection cheap.
- **Updates ride publish, not their own tool.** `sequence_id` is a publish parameter — separating an `update` tool would duplicate the entire input schema for one extra field. Documented in publish's description.
- **Clear and delete consolidated.** Both are post-publish management actions on a sequence. A single `ntfy_manage_message` with `operation` enum is tighter than two tools that share 90% of their schema. Both are dropped from the same handler.
- **No local file upload.** Binary uploads from an LLM are awkward — the agent rarely has a file in hand, and adding a `localFilePath` parameter ties the tool to stdio mode and the agent's filesystem context. URL attachments cover the realistic LLM workflow; local files belong to a future `ntfy_upload_attachment` tool if demand surfaces.
- **No subscribe/streaming tool.** ntfy's subscribe endpoint is a long-lived connection. MCP tool calls are request/response. `ntfy_fetch_messages` covers the use case (poll on demand) without inventing an awkward tool that returns streaming data.
- **Topic exposed as a resource AND as fetch-tool input.** `ntfy://{topic}` returns a default-friendly snapshot — discoverable as a URI, no parameters, "what's happening here." `ntfy_fetch_messages` covers parameterized queries (filters, custom windows, multi-topic, larger pulls). Same data path, different ergonomics: resources answer "what is X," tools answer "do X with these params."
- **Topic is treated as a secret.** Topic names function as access tokens for unprotected ntfy servers. The server logs topics at `debug` only; the server instructions and `ntfy_publish_message`'s description tell agents to treat the topic name as a secret, since anyone who knows it can publish or subscribe.
- **Auth credentials are server-config, not tool-input.** A token in a tool argument would log on every call and bloat schemas. One identity per registered base URL; multi-tenant scenarios run multiple servers.
- **`base_url` is overridable per-call; auth is not.** Configured credentials are scoped to the base URL they were registered with (`NTFY_BASE_URL`, or each `NTFY_SERVERS` entry). When `base_url` matches no registered server, the request goes out unauthenticated — preventing the agent from leaking server-configured tokens to an arbitrary URL it picked. The override exists for ad-hoc publishes/fetches against public ntfy servers; protected topics on another host need that host registered in `NTFY_SERVERS` with its own credentials.
- **Side effects past the drawer need the user's consent, proven by a server record.** A clear/delete, or a publish carrying `email`, `call`, or a `broadcast`/`http` button, runs through `confirmAction` (`src/mcp-server/tools/utils/confirm-action.ts`). Asking stores `{ operation, clientId, subject, target, contentHash }` in `ctx.state` under a random UUID with a 600 s TTL and sends only that id as `requestState` with the `elicitation/create` request. Every call redeems first — reads and deletes the record its `requestState` names — and proceeds only when the record is deep-equal to what this call would confirm and the answer is an accepted `confirm: true`; a decline, cancel, `confirm: false`, or unreadable answer against that record fails with `consent_declined`, and every other round asks again under a fresh record. Why: a client that declared `elicitation` can send `inputResponses` on a call nothing prompted, and any `requestState`, sealed or not, can be replayed within its lifetime, so an answer on `ctx.inputs` proves nothing on its own; only a single-use record the server wrote when it asked does. The prompt names each caller-supplied target — topic, `sequence_id`, email address, phone number, HTTP method and URL, broadcast intent — through `literal()`, so a value such as `[safe](https://evil)` reads as that string in the prompt the user approves, never as a link; the prompt text is not part of the record, whose `contentHash` binds the outbound request itself.

  | Record field | `ntfy_manage_message` | `ntfy_publish_message` |
  |:--|:--|:--|
  | `operation` | `ntfy_manage_message:clear` or `:delete` | `ntfy_publish_message` |
  | `clientId` / `subject` | `ctx.auth.clientId` / `ctx.auth.sub`, empty strings without auth | same |
  | `target` | `<base>/<topic>/<sequence_id>` | `<base>/<topic>` |
  | `contentHash` | SHA-256 of canonical JSON `{ base, topic, sequence_id, operation }` | SHA-256 of canonical JSON `{ url, body }` — the exact `POST` body ntfy receives |

  `<base>` is the resolved base URL: the normalized `base_url` override, else the configured default. The id must be a UUID before it is used as a storage key, so a forged or path-shaped id names nothing. The default `in-memory` store serves one process; a multi-instance HTTP deployment needs `STORAGE_PROVIDER_TYPE` set to `filesystem`, `supabase`, or `cloudflare-d1` (never `cloudflare-kv`, which is eventually consistent), and should set `MCP_REQUEST_STATE_KEY` so the framework rejects a tampered `requestState` before the handler runs.
- **Fetch pages with a message-ID cursor resolved in the fetched window.** ntfy's poll has no offset, upper bound, or limit, and `since=<id>` returns only messages after that one, so neither an offset (which shifts as messages arrive and expire) nor ntfy's `since` (which raises the lower bound and drops the head) can reach the messages one call leaves out. The handler re-fetches the same window and slices from the message whose `id` is the cursor, inclusive; a cursor the window no longer holds fails as `cursor_not_found` instead of silently restarting from the top.
- **Under a duration `since`, the cursor carries where the walk began.** A duration is measured from ntfy's "now" on every call, so the first message a walk asks for is the first to leave the window. The cursor carries the starting window's oldest message time, and its pages poll from that Unix time, which ntfy reads inclusively. That keeps the walk to one rule (repeat `topic`, `since`, filters) with no new input or output field, and no clock but ntfy's. Rejected: switching cursor pages to `since=all` (fetches the whole cache, can trip ntfy's replay cap and lose the cursor, and makes `totalCount` jump between pages); an extra `nextSince` field the agent must send as `since` (two coupled values to copy, against the "same `since`" rule); pinning every `since` form (a `latest` window across topics would admit messages it never held).
- **Blank inputs mean unset, resolved before the query.** ntfy trims every query parameter, so a whitespace-only `since` or filter is no value upstream while still looking active to this server. The handler trims first: a blank `since` becomes the `10m` default, and a blank filter is neither sent nor echoed, so the echo is always what ntfy received.
- **The emoji-tags gate has its own accessor and its own `.env` pre-load.** `NTFY_ENABLE_EMOJI_TAGS` decides which definition object `src/index.ts` hands `createApp()`, so it resolves at module load — before `createApp()` can render a `ConfigurationError` as the startup banner and before the framework reads `./.env`. Reading `getServerConfig()` there would turn any invalid `NTFY_*` value into a raw stack trace, so `isEmojiTagsEnabled()` parses only its own variable; and a side-effect import placed first in `src/index.ts` loads `./.env`, or a flag set only there would never reach the gate. Biome never reorders a bare side-effect import, and `tests/index.test.ts` pins it as the first import. A resource was rejected (a static resource cannot search or page), and so was folding the lookup into `ntfy_publish_message` (it overloads a side-effecting tool).
- **One fixed call deadline, not a setting.** `CALL_DEADLINE_MS` (50 s) exists to settle every call's ntfy round trips before the 60 s default request timeout of MCP SDK clients, so that a caller receives this server's classified error rather than its own transport timeout. It does not cover a guarded `base_url` DNS lookup or a consent prompt's wait for the user. Operators who want shorter calls lower `NTFY_REQUEST_TIMEOUT_MS` or `NTFY_MAX_RETRIES`; a longer budget would only hand back errors no client is still waiting for.

## Known Limitations

- Consent records stop sequential replays, not concurrent ones. `ctx.state` has no atomic read-and-delete (cyanheads/mcp-ts-core#593), so retries carrying one `requestState` at the same moment can each read the record before either delete lands. ntfy offers no idempotency key to pin the action to the record id — `sequence_id` groups a notification's updates, it does not deduplicate publishes. A duplicate clear/delete re-emits its `message_clear`/`message_delete` event and leaves message state unchanged; a duplicate gated publish delivers again, email and call included.

- Phone calls and e-mail forwarding require an authenticated ntfy user with a verified number or address, on a server that has them enabled. The MCP server can't check any of this ahead of the publish: an unverified contact or a sender without credentials surfaces as `unverified_contact`, while calling or e-mail disabled on the server and a malformed number or address fail in ntfy's own words, with no reason.
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
