<div align="center">
  <h1>ntfy-mcp-server</h1>
  <p><b>Send, manage, and replay ntfy push notifications via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/ntfy-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/ntfy-mcp-server) [![Version](https://img.shields.io/badge/Version-2.3.4-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/)

[![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/ntfy-mcp-server/releases/latest/download/ntfy-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=ntfy-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm50ZnktbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22ntfy-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22ntfy-mcp-server%22%5D%7D)

</div>

---

## Overview

Push notifications over the ntfy pub/sub HTTP API. Publish, update, and manage notifications, poll cached topic history, and look up emoji short codes for tags from any MCP client. Runs as a stdio process or a local Streamable HTTP server.

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

## Capability reference

### `ntfy_publish_message` <sub>tool</sub>

- Topics are created on first publish — treat the topic name as a secret; anyone who knows it can publish or subscribe
- Full publish-parameter coverage — `title`, `priority` (1–5), `tags`, `click`, `attach`, `icon`, `filename`, `markdown`, `delay`, `email`, `call`, `cache`, `firebase`; message body capped at 4096 bytes (non-ASCII characters cost more), empty body defaults server-side to `triggered`
- Up to three discriminated action buttons (`view`, `broadcast`, `http`, `copy`) per message
- Update or replace a previously-sent message by passing the original `sequence_id`
- Per-call `base_url` override forwards credentials only when it matches a registered server (`NTFY_BASE_URL` or an `NTFY_SERVERS` entry); otherwise the request goes out unauthenticated
- Publishes carrying `email`, `call`, or a `broadcast`/`http` action button ask the user to confirm the specific target first — the call returns a confirmation request, and sends only once reissued with the answer

---

### `ntfy_manage_message` <sub>tool</sub>

- `operation`: `clear` marks the notification read & dismisses it (subscribers see `message_clear`); `delete` removes it from the drawer (subscribers see `message_delete`)
- Append-only — the original message stays in cache; re-issuing the same operation is safe, though a fresh event fires each call
- Every call asks the user to confirm the topic, `sequence_id`, and operation before the event fires — the first call returns that confirmation request, and declining fails with `consent_declined`
- ntfy.sh accepts an unknown `sequence_id` without error; stricter ntfy deployments return a `not_found` failure instead

---

### `ntfy_fetch_messages` <sub>tool</sub>

- Returns a snapshot, not a live stream — use it to confirm delivery, replay missed alerts, or audit topic activity
- Comma-separated multi-topic queries (e.g. `alerts,backups,phil_alerts`)
- Filter by `since` (duration / timestamp / message ID / `all` / `latest`), `priority`, `tags`, `id`, `title`, `message`, scheduled-only
- Default window `10m`, default limit 20 messages per response, hard cap 100 — over-limit windows keep the newest `limit` messages, listed oldest-first
- Long bodies truncated to ~500 chars with `messageTruncated` reporting the dropped count; refetch with a message `id` to read that one in full

---

### `ntfy_search_emoji_tags` <sub>tool</sub>

- Substring match against tag names, case-insensitive; omit `query` to list the reference from the start in its documented order
- `limit` default 25, max 200; `offset` pages past the cap using the returned `totalCount`
- Returned `tag` strings plug directly into `ntfy_publish_message`'s `tags` field

---

### `ntfy://{topic}` <sub>resource</sub>

- Fixed snapshot — latest 20 messages from the past 1 hour, plus the topic's browser URL; same normalized message shape as `ntfy_fetch_messages` (ISO 8601 timestamps, ~500-char body truncation)
- For custom windows, filters, or replay, use `ntfy_fetch_messages` instead

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

ntfy-specific:

- Wraps ntfy's HTTP API with a retry-aware client (`withRetry` + per-request timeout)
- Per-server scoped auth — credentials bind to each registered base URL (`NTFY_BASE_URL` or an `NTFY_SERVERS` entry); mutually-exclusive bearer-token / basic-auth modes validated at config load; a per-call `base_url` override forwards auth only when it matches a registered server
- User confirmation before side effects that leave the notification drawer — a clear/delete, or a publish carrying `email`, `call`, or a `broadcast`/`http` action button — enforced on both stdio and Streamable HTTP
- Optional SSRF guard on `base_url` overrides (`NTFY_BLOCK_PRIVATE_HOSTS`) — blocks loopback, RFC 1918, RFC 6598 mesh, link-local, and IPv6 equivalents, then refuses redirects; registered servers are exempt
- Bundled emoji-tag reference, regenerated from upstream `docs/ntfy/emojis.md` via `scripts/build-emoji-tags.ts`

Agent-friendly output:

- Provenance — `ntfy_publish_message` and `ntfy_manage_message` echo back the resolved topic, ID, and timestamp; `ntfy_fetch_messages` also echoes the resolved `since` and applied filters
- Discriminated outputs — typed `reason` codes (`consent_declined`, `forbidden_topic`, `rate_limited`, `not_found`, `payload_too_large`, and more) on every tool's error contract let callers branch on failure mode instead of parsing error text
- Truncation and paging guidance — `ntfy_fetch_messages` and `ntfy_search_emoji_tags` report a `truncated` flag plus a `notice` naming the exact next step (widen `since`, raise `limit`, advance `offset`) instead of silently dropping results

## Getting started

Add the following to your MCP client configuration file. Public ntfy.sh works out of the box without an account; for protected topics, generate an access token at <https://ntfy.sh/account>.

```json
{
  "mcpServers": {
    "ntfy-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["ntfy-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "NTFY_DEFAULT_TOPIC": "your-topic-name"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "ntfy-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "ntfy-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "NTFY_DEFAULT_TOPIC": "your-topic-name"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "ntfy-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "NTFY_DEFAULT_TOPIC=your-topic-name",
        "ghcr.io/cyanheads/ntfy-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 NTFY_DEFAULT_TOPIC=your-topic bun run start:http
# Server listens at http://127.0.0.1:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- A topic name on an ntfy server. Public `ntfy.sh` requires no account; self-hosted instances and protected topics may need a bearer token or basic-auth credentials.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/ntfy-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd ntfy-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set NTFY_DEFAULT_TOPIC (and auth, if needed)
```

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `NTFY_SERVERS` | JSON array of `{ baseUrl, authToken? \| authUsername?+authPassword? }` entries — one per ntfy server. First entry is the default base. Auth is scoped to the entry's `baseUrl`; per-call `base_url` overrides that match a registered base forward that server's auth. Use this when you need more than one authenticated server in a single process; it takes precedence over the single-server vars below. | — |
| `NTFY_BASE_URL` | Single-server shorthand — base URL of the ntfy server (no trailing slash). Used when `NTFY_SERVERS` is unset. | `https://ntfy.sh` |
| `NTFY_DEFAULT_TOPIC` | Topic used when a tool call omits `topic`. | — |
| `NTFY_AUTH_TOKEN` | Bearer access token (`tk_…`) for the single-server shorthand. Mutually exclusive with `NTFY_AUTH_USERNAME` / `NTFY_AUTH_PASSWORD`. | — |
| `NTFY_AUTH_USERNAME` | Basic-auth username for the single-server shorthand — required together with `NTFY_AUTH_PASSWORD`. | — |
| `NTFY_AUTH_PASSWORD` | Basic-auth password for the single-server shorthand — required together with `NTFY_AUTH_USERNAME`. | — |
| `NTFY_REQUEST_TIMEOUT_MS` | Per-request HTTP timeout in milliseconds. | `15000` |
| `NTFY_MAX_RETRIES` | Max retry attempts for transient upstream failures (5xx, network, 429). | `3` |
| `NTFY_BLOCK_PRIVATE_HOSTS` | When `true`, a per-call `base_url` override must resolve to a public address, and its redirects are not followed. Servers registered under `NTFY_SERVERS` / `NTFY_BASE_URL` are exempt, so a deliberate LAN target still works. Turn it on where callers you don't control can reach the server. | `false` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_SESSION_MODE` | HTTP session model: `auto`, `stateful`, or `stateless`. This server requires `stateful` over HTTP — the consent prompt on destructive and outbound calls is a multi-round-trip request that a 2025-era HTTP client can only complete over a live session — so an HTTP start with `stateless` is refused. `auto` resolves to `stateful`; stdio ignores the setting. | `stateful` |
| `MCP_HTTP_HOST` | HTTP host. | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP port. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path. | `/mcp` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for file-based logs (Node only; ignored on Workers). | `./logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck     # Lint, format, typecheck, security, changelog sync
  bun run test         # Vitest test suite
  bun run lint:mcp     # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t ntfy-mcp-server .
docker run --rm -e NTFY_DEFAULT_TOPIC=your-topic -p 3010:3010 ntfy-mcp-server
```

The Dockerfile defaults to HTTP transport, stateful session mode, and logs to `/var/log/ntfy-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and resources, initializes services. |
| `src/config` | Server-specific environment variable parsing (`NTFY_*`) with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/services/ntfy` | ntfy HTTP client, types, and error classifier. |
| `src/services/emoji-tags` | Bundled emoji short-code reference and lookup service. |
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
