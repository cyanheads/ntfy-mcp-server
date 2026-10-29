<div align="center">
  <h1>ntfy-mcp-server</h1>
  <p><b>Send, manage, and replay ntfy push notifications via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools • 1 Resource • 1 Skill</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-2.4.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/ntfy-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/ntfy-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/ntfy-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/ntfy-mcp-server/releases/latest/download/ntfy-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=ntfy-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm50ZnktbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22ntfy-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22ntfy-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Push notifications to your phone or desktop through ntfy. Publish, update, and manage notifications, poll a topic's recent history, and look up emoji short codes for tags.

### Tools

| Tool | Description |
|:---|:---|
| `ntfy_publish_message` | Send or update a push notification on an ntfy topic. |
| `ntfy_manage_message` | Clear or delete a previously-sent notification by `sequence_id`. |
| `ntfy_fetch_messages` | Poll cached messages from one or more topics with optional filters. |
| `ntfy_search_emoji_tags` | Look up ntfy emoji tag short codes for use in `tags`. |

### Resources

| Resource | Description |
|:---|:---|
| `ntfy://{topic}` | Snapshot of a topic — latest 20 messages from the past hour, plus the topic's browser URL. |

`ntfy_fetch_messages` covers the same topic data with custom windows and filters when the resource's fixed defaults aren't enough.

### Skills

| Skill | Description |
|:---|:---|
| [`ntfy-guide`](./skills/ntfy-guide/SKILL.md) | Using the `ntfy_*` tools: choosing the topic, carrying one sequence id through a notification's updates, clear, and delete, scheduling and cancelling reminders, and reading fetched history without miscounting |

Plugin, npm, Docker, and MCPB installs ship it from `skills/`; MCP clients that support the Skills extension read it as `skill://ntfy-guide/SKILL.md`.

## Capability reference

### `ntfy_publish_message` <sub>tool</sub>

- Topics are created on first publish — treat the topic name as a secret; anyone who knows it can publish or subscribe
- Takes `title`, `priority` (1–5), `tags`, `click`, `attach`, `icon`, `filename`, `markdown`, `delay`, `email`, `call`, `cache`, `firebase`, and up to three action buttons (`view`, `broadcast`, `http`, `copy`); body capped at 4096 bytes, empty body defaults to `triggered`; pass the original `sequence_id` to update a sent message
- Publishes with `email`, `call`, or a `broadcast`/`http` button ask the user to confirm the target before sending; declining fails with `consent_declined`
- A per-call `base_url` gets credentials only if it matches a registered server (`NTFY_BASE_URL` or an `NTFY_SERVERS` entry); otherwise the request is unauthenticated
- Failures carry typed reasons: `payload_too_large` (body, attachment, `title`, or combined `tags` over ntfy's limits), `invalid_delay`, `invalid_attachment` (malformed `attach` URL), and `unverified_contact` (`email`/`call` without a verified address or number, or without auth), alongside the shared reasons under Features

---

### `ntfy_manage_message` <sub>tool</sub>

- `operation`: `clear` marks the notification read and dismisses it (subscribers see `message_clear`); `delete` removes it from the drawer (subscribers see `message_delete`)
- Every call asks the user to confirm the topic, `sequence_id`, and operation first; declining fails with `consent_declined`
- The original message stays in cache, and repeating an operation is safe; ntfy.sh accepts an unknown `sequence_id`, stricter deployments return `not_found`

---

### `ntfy_fetch_messages` <sub>tool</sub>

- Returns a snapshot, not a live stream; accepts comma-separated topics (e.g. `alerts,backups`, each 1–64 characters) and filters `since` (duration / timestamp / message ID / `all` / `latest`), `priority`, `tags`, `id`, `title`, `message`, plus `scheduled` to include delayed messages
- Default window `10m`, default limit 20, at most 100 per call; a larger window returns the newest `limit` messages with `totalCount` and a `nextCursor` to pass back as `cursor`. Bodies truncate at ~500 chars (`messageTruncated` gives the dropped count); refetch with `id` for the full text. `upstreamTruncated` flags a replay ntfy capped
- Failures carry typed reasons: `invalid_since` (malformed `since` value), `cursor_not_found` (the cursor's message expired, or came from a call with different topics, `since`, or filters), and `upstream_malformed` (the response wasn't an ntfy message stream), alongside the shared reasons under Features

---

### `ntfy_search_emoji_tags` <sub>tool</sub>

- Case-insensitive substring match on tag names; omit `query` to list the reference in order
- `limit` default 25, at most 200 per call; page with `offset` using `totalCount`
- Returned `tag` strings go straight into `ntfy_publish_message`'s `tags`
- On by default; set `NTFY_ENABLE_EMOJI_TAGS=false` to remove it from `tools/list`

---

### `ntfy://{topic}` <sub>resource</sub>

- Fixed snapshot: latest 20 messages from the past hour plus the topic's browser URL, in the same shape as `ntfy_fetch_messages` (including `upstreamTruncated`)
- For custom windows or filters, use `ntfy_fetch_messages`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

ntfy-specific:

- Retrying ntfy client with a per-attempt timeout, and each call capped at 50 s so it settles before an MCP client's 60 s default
- Per-server auth: credentials bind to each registered base URL (`NTFY_BASE_URL` or an `NTFY_SERVERS` entry), with bearer-token and basic-auth modes mutually exclusive
- User confirmation before a clear/delete, or a publish with `email`, `call`, or a `broadcast`/`http` button, on both stdio and Streamable HTTP
- Optional SSRF guard on `base_url` overrides (`NTFY_BLOCK_PRIVATE_HOSTS`); registered servers are exempt
- Bundled emoji-tag reference, regenerated from upstream `docs/ntfy/emojis.md` via `scripts/build-emoji-tags.ts`

Agent-friendly output:

- Publish and manage echo the resolved topic, ID, and timestamp; fetch also echoes the resolved `since` and applied filters
- Typed `reason` codes let callers branch on failure mode. Shared across the tools and the resource: `forbidden_topic` (ntfy refused the topic with 401/403: missing or insufficient credentials), `rate_limited` (429 after retries), `upstream_unreachable` (network failure, a 5xx that outlasted retries or whose `Retry-After` the call can't wait out, or no complete answer within the 50 s call deadline; carries `retryAfter` when ntfy sent one), `upstream_malformed` (a reply that isn't ntfy's message format or couldn't be read in full; publish and manage don't retry it, since the event may already be out). `consent_declined`, `not_found`, and the rest are listed per entry
- Fetch and emoji search report `truncated`, `totalCount`, and a `notice` naming the next step (pass `nextCursor` as `cursor`, advance `offset`)

## Getting started

Add it to Claude Code:

```sh
claude mcp add ntfy-mcp-server -- npx -y ntfy-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "ntfy-mcp-server": {
      "command": "npx",
      "args": ["-y", "ntfy-mcp-server"]
    }
  }
}
```

Public ntfy.sh works without an account. Set `NTFY_DEFAULT_TOPIC` so calls can omit `topic`; for protected topics, add `NTFY_AUTH_TOKEN` (generate one at <https://ntfy.sh/account>). With `claude mcp add`, pass each as `-e NAME=value` after the server name; in JSON, put them under `env`. For Docker, a source build, or Streamable HTTP, see [Running the server](#running-the-server).

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `NTFY_SERVERS` | JSON array of `{ baseUrl, authToken? \| authUsername?+authPassword? }` entries, one per ntfy server; the first is the default. Takes precedence over the single-server vars below. | — |
| `NTFY_BASE_URL` | Single-server shorthand — base URL of the ntfy server (no trailing slash). Used when `NTFY_SERVERS` is unset. | `https://ntfy.sh` |
| `NTFY_DEFAULT_TOPIC` | Topic used when a tool call omits `topic`. | — |
| `NTFY_AUTH_TOKEN` | Bearer access token (`tk_…`) for the single-server shorthand. Mutually exclusive with `NTFY_AUTH_USERNAME` / `NTFY_AUTH_PASSWORD`. | — |
| `NTFY_AUTH_USERNAME` | Basic-auth username for the single-server shorthand — required together with `NTFY_AUTH_PASSWORD`. | — |
| `NTFY_AUTH_PASSWORD` | Basic-auth password for the single-server shorthand — required together with `NTFY_AUTH_USERNAME`. | — |
| `NTFY_REQUEST_TIMEOUT_MS` | Per-attempt HTTP timeout in milliseconds. Each call is also capped at 50 s across all attempts. | `15000` |
| `NTFY_MAX_RETRIES` | Max retry attempts for transient upstream failures (5xx, network, 429). | `3` |
| `NTFY_BLOCK_PRIVATE_HOSTS` | When `true`, a per-call `base_url` override must resolve to a public address and redirects are not followed. Registered servers are exempt. Turn it on where callers you don't control can reach the server. | `false` |
| `NTFY_ENABLE_EMOJI_TAGS` | Set to `false` to disable `ntfy_search_emoji_tags`. An unrecognized value fails startup. | `true` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_SESSION_MODE` | HTTP session model: `auto`, `stateful`, or `stateless`. Over HTTP this server requires `stateful` (`auto` resolves to it); `stateless` is refused at start. Ignored on stdio. | `stateful` |
| `MCP_HTTP_HOST` | HTTP host. | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP port. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path. | `/mcp` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_REQUEST_STATE_KEY` | Recommended for HTTP. Key (≥ 32 bytes, e.g. `openssl rand -base64 32`, the same on every instance) that seals the consent `requestState` for 900 s; an invalid or expired state is rejected with `-32602` `invalid_request_state`. | — |
| `STORAGE_PROVIDER_TYPE` | Where consent records live (600 s TTL). Multi-instance HTTP needs shared storage: `filesystem` (shared volume), `supabase`, or `cloudflare-d1`, not `cloudflare-kv`. | `in-memory` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for file-based logs (Node only; ignored on Workers). | `./logs` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). A secret inside a free-form value is not redacted. | `false` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

Requires [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+) and a topic on an ntfy server. Public `ntfy.sh` needs no account; self-hosted instances and protected topics may need a bearer token or basic-auth credentials.

- **Clone and install:**

  ```sh
  git clone https://github.com/cyanheads/ntfy-mcp-server.git
  cd ntfy-mcp-server && bun install
  cp .env.example .env   # set NTFY_DEFAULT_TOPIC (and auth, if needed)
  ```

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

  For Streamable HTTP:

  ```sh
  MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 NTFY_DEFAULT_TOPIC=your-topic bun run start:http
  # Server listens at http://127.0.0.1:3010/mcp
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck     # Lint, format, typecheck, security, changelog sync
  bun run test         # Vitest test suite
  bun run lint:mcp     # Validate MCP definitions against spec
  ```

### Docker

```sh
docker run --rm -e NTFY_DEFAULT_TOPIC=your-topic -p 3010:3010 ghcr.io/cyanheads/ntfy-mcp-server:latest
```

The image defaults to HTTP transport, stateful session mode, and logs to `/var/log/ntfy-mcp-server`. To run it over stdio from an MCP client, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "-e", "NTFY_DEFAULT_TOPIC=your-topic", "ghcr.io/cyanheads/ntfy-mcp-server:latest"]`. To build locally, `docker build -t ntfy-mcp-server .`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and resources, initializes services. |
| `src/config` | Server-specific environment variable parsing (`NTFY_*`) with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/services/ntfy` | ntfy HTTP client, types, and error classifier. |
| `src/services/emoji-tags` | Bundled emoji short-code reference and lookup service. |
| `skills/` | Agent Skills the server publishes (`ntfy-guide`), served over MCP via `createApp({ skills: 'skills' })`. |
| `docs/ntfy` | Mirrored upstream ntfy API docs (pinned commit in `SOURCES.md`). |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields
- Per-tool `errors[]` contracts stay inline — repetition is intended for locality

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
