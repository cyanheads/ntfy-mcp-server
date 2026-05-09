<div align="center">
  <h1>ntfy-mcp-server</h1>
  <p><b>MCP server for ntfy — send push notifications to devices via the ntfy.sh service. STDIO or Streamable HTTP.</b>
  <div>4 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/ntfy-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/ntfy-mcp-server) [![Version](https://img.shields.io/badge/Version-2.0.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/)

[![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

---

## Tools

Four tools covering the ntfy publish/subscribe surface — message lifecycle (publish, manage, fetch) plus an emoji-tag lookup that feeds the publish tool's `tags` field:

| Tool Name | Description |
|:----------|:------------|
| `ntfy_publish_message` | Send or update a push notification on an ntfy topic. |
| `ntfy_manage_message` | Clear or delete a previously-sent notification by `sequence_id`. |
| `ntfy_fetch_messages` | Poll cached messages from one or more topics with optional filters. |
| `ntfy_search_emoji_tags` | Look up ntfy emoji tag short codes for use in `tags`. |

---

### `ntfy_publish_message`

Send or update a push notification on an ntfy topic. Topics are created on first publish — treat the topic name as a secret because anyone who knows it can publish or subscribe.

- All 18 ntfy publish parameters: `title`, `priority` (1–5), `tags`, `click`, `attach`, `icon`, `markdown`, `delay`, `email`, `call`, `cache`, `firebase`
- Up to three discriminated action buttons (`view`, `broadcast`, `http`, `copy`) per message
- Update or replace previously-sent messages by passing the original `sequence_id`
- Per-call `base_url` override that intentionally drops configured auth, so credentials never leak to alternate hosts

---

### `ntfy_manage_message`

Clear (mark read & dismiss) or delete a previously-sent ntfy notification by `sequence_id`. Append-only — the original message stays in cache, and a `message_clear` / `message_delete` event is emitted to subscribers. Idempotent.

---

### `ntfy_fetch_messages`

Poll cached messages from one or more topics with optional filters. Returns a snapshot, not a live stream — use it to confirm delivery, replay missed alerts, or audit topic activity.

- Comma-separated multi-topic queries (e.g. `alerts,backups,phil_alerts`)
- Filter by `since` (duration / timestamp / message ID / `all` / `latest`), `priority`, `tags`, `id`, `title`, `message`, scheduled-only
- Default window `10m`, capped at 100 messages per response
- Long bodies truncated to ~500 chars with `messageTruncated` reporting the dropped count

---

### `ntfy_search_emoji_tags`

Substring search over the bundled ntfy emoji-tag reference. Returns the `tag` strings ready to plug into `ntfy_publish_message`'s `tags` field. Without a query, returns the first slice of the full reference.

## Resources and prompts

| Type | Name | Description |
|:---|:---|:---|
| Resource | `ntfy://{topic}` | Snapshot of a topic — last 20 messages from the past 1 hour, plus the topic's browser URL. |

`ntfy_fetch_messages` covers the same topic data with custom windows and filters when the resource's fixed defaults aren't enough.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Typed error contracts via `ctx.fail(reason, …)` plus framework error factories (`forbidden`, `notFound`, `validationError`, …)
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

ntfy-specific:

- Wraps ntfy's HTTP API with retry-aware client (`withRetry` + per-request timeout)
- Auth header is scoped to the configured `NTFY_BASE_URL` — per-call `base_url` overrides go out unauthenticated to avoid leaking credentials to arbitrary hosts
- Bundled emoji-tag reference, regenerated from upstream `docs/ntfy/emojis.md` via `scripts/build-emoji-tags.ts`
- Mutually-exclusive auth modes (bearer token *or* basic auth) validated at config-load time

## Getting started

Add the following to your MCP client configuration file. Public ntfy.sh works out of the box without an account; for protected topics, generate an access token at <https://ntfy.sh/account>.

```json
{
  "mcpServers": {
    "ntfy": {
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
    "ntfy": {
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
    "ntfy": {
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

- [Bun v1.3.11](https://bun.sh/) or higher (or Node.js v24+).
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
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_SESSION_MODE` | HTTP session model: `stateless`, `stateful`, or `auto`. | `auto` |
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

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/ntfy-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
