# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [2.3.3](changelog/2.3.x/2.3.3.md) — 2026-09-04

Recognizes retry-exhausted upstream 5xx failures again under mcp-ts-core 0.12.4's reclassified error codes, and reports a cancelled ntfy request as cancelled instead of a retryable upstream fault

## [2.3.2](changelog/2.3.x/2.3.2.md) — 2026-08-22

The Docker build stage runs on the build host's platform, so the multi-arch image publishes again — 2.3.1 shipped to npm and the registry but no container image

## [2.3.1](changelog/2.3.x/2.3.1.md) — 2026-08-22 · ⚠️ Breaking

Adopts mcp-ts-core 0.12.3 and MCP SDK v2: the consent gate becomes a multi-round-trip request that now reaches Streamable HTTP clients, tool inputs turn strict, and the advertised outputSchema declares the error envelope

## [2.3.0](changelog/2.3.x/2.3.0.md) — 2026-07-29 · ⚠️ Breaking · 🛡️ Security

SSRF guard for base_url overrides and a consent gate on destructive/side-effect ntfy_manage_message and ntfy_publish_message calls

## [2.2.1](changelog/2.2.x/2.2.1.md) — 2026-07-29

ntfy_fetch_messages returns the newest window, single-message id fetches skip truncation, priority validation collapses to one error, and emoji-tag search pages past its cap

## [2.2.0](changelog/2.2.x/2.2.0.md) — 2026-07-29 · ⚠️ Breaking

ntfy://{topic} resource timestamps become ISO 8601 and body-truncated to match ntfy_fetch_messages; ntfy_publish_message's message limit is enforced by byte length; five error-classification and message-ordering fixes; framework ^0.11.0.

## [2.1.1](changelog/2.1.x/2.1.1.md) — 2026-06-11

Adopt @cyanheads/mcp-ts-core ^0.10.6 — server identity pair, MCPB bundle cleaner, root-anchored .mcpbignore, plus dep bumps and identity-consistency fixes.

## [2.1.0](changelog/2.1.x/2.1.0.md) — 2026-05-30

Enrichment channel on read tools, error-code refinement, MCPB bundling, plugin manifests, framework ^0.9.16, and dev-dep bumps.

## [2.0.1](changelog/2.0.x/2.0.1.md) — 2026-05-16

Adopts @cyanheads/mcp-ts-core ^0.9.1: URL string fields drop `format: uri` for OpenAI/Gemini portability, server `instructions` field added, devcheck `bun outdated` parser fixed.

## [2.0.0](changelog/2.0.x/2.0.0.md) — 2026-05-09 · ⚠️ Breaking

Major rewrite on @cyanheads/mcp-ts-core. New 4-tool surface (publish, manage, fetch, emoji search), topic snapshot resource, multi-server NTFY_SERVERS registry. Breaking changes from 1.x; NTFY_API_KEY accepted as a deprecated alias.

## [1.0.6](changelog/1.0.x/1.0.6.md) — 2025-05-05

Added Smithery deploy config; refreshed Dockerfile, env config, docs, and dependencies. (Note: 1.0.5 was skipped.)

## [1.0.4](changelog/1.0.x/1.0.4.md) — 2025-04-23

Version metadata fix and tree.ts script housekeeping.

## [1.0.3](changelog/1.0.x/1.0.3.md) — 2025-04-23

Consolidated configuration, refactored logger, expanded ntfy resource, dropped echo example.

## [1.0.2](changelog/1.0.x/1.0.2.md) — 2025-03-27

send_ntfy description surfaces default topic; remaining console output routed through the structured logger.

## [1.0.1](changelog/1.0.x/1.0.1.md) — 2025-03-27

README polish.

## [1.0.0](changelog/1.0.x/1.0.0.md) — 2025-03-27

Initial release — send_ntfy tool and ntfy topic resource backed by a publish service.
