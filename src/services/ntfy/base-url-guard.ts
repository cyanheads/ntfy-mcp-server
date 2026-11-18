/**
 * @fileoverview Validation for the per-call `base_url` override. Two layers,
 * deliberately split:
 *
 *  - **Always on** — `assertAbsoluteHttpUrl` parses the override and rejects
 *    anything that is not an absolute `http:`/`https:` URL, and any URL that
 *    carries credentials (`user:password@`): credentials reach ntfy only from
 *    a registered server's auth fields. The advertised contract is "absolute
 *    URL", so a malformed value fails at the boundary with an actionable
 *    message instead of surfacing as an opaque `fetch` error several layers
 *    down. Every tool runs it through `normalizeBaseOverride`, above its consent
 *    gate. No rejection quotes the raw value, which can hold a password.
 *  - **Opt-in (`NTFY_BLOCK_PRIVATE_HOSTS`)** — `assertPublicHost` resolves the
 *    host and rejects loopback, private, link-local, and unspecified
 *    addresses. Off by default so stdio and homelab deployments that point at
 *    a LAN ntfy keep working; on for operators exposing the server as a public
 *    HTTP utility, where a model-supplied `base_url` is an SSRF vector.
 *
 * @module services/ntfy/base-url-guard
 */

import { lookup } from 'node:dns/promises';
import { BlockList, isIPv4 } from 'node:net';

import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';

/**
 * Pattern advertised as `pattern` on every tool's `base_url` field, so the
 * absolute-URL requirement is machine-readable rather than prose-only. One
 * regex node (not a union) keeps a bad value on a single error message instead
 * of an `invalid_union` dump. The empty-string branch is for form-based
 * clients that submit `""` for an untouched optional field; handlers read that
 * as "no override".
 */
export const BASE_URL_PATTERN = /^$|^https?:\/\/\S+$/i;

/** Recovery hint for a `base_url` that is not an absolute `http(s)` URL — at the schema and in the guard. */
export const BASE_URL_HINT =
  'Pass an absolute `http://` or `https://` URL (e.g. `https://ntfy.example.com`), or omit `base_url` to use the configured server.';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** The char code of `/`. */
const SLASH = 0x2f;

/**
 * `url` with any run of trailing `/` removed, in time linear in the length of
 * the URL. The config loader, `normalizeBaseOverride`, and `NtfyService` all
 * trim with this.
 */
export function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === SLASH) end--;
  return end === url.length ? url : url.slice(0, end);
}

/**
 * Turn a tool's raw `base_url` argument into the override `NtfyService`
 * expects: the empty string a form-based client submits for an untouched
 * optional field means "no override", not a base URL of `""`. Trailing slashes
 * come off here as well as in the service, because a handler renders the
 * override into the canonical topic URL it returns.
 *
 * Also runs the synchronous guard, `assertAbsoluteHttpUrl`. Every tool calls
 * this above `confirmAction`, so a value it refuses — credentials in it, a
 * non-HTTP scheme, no parse at all — fails before a consent prompt, a consent
 * record, or a request can carry it. The DNS-based `assertPublicHost` stays in
 * `NtfyService`, past the gate: the stretch above it runs twice and does no I/O.
 */
export function normalizeBaseOverride(raw: string | undefined): string | undefined {
  if (!raw) return;
  const base = withoutTrailingSlashes(raw);
  assertAbsoluteHttpUrl(base);
  return withoutEmptyUserinfo(base);
}

/** The `@` or `:@` an empty userinfo puts before the host, after any run of slashes. */
const EMPTY_USERINFO = /^(https?:)[/\\]*:?@/i;

/**
 * `base` with an empty userinfo dropped: `https://@host` and `https://:@host`
 * parse to no credential at all, so they are accepted, and this writes them as
 * `https://host` — the base a tool sends, renders into the topic URL it
 * returns, and names in a consent record then holds no `@`. Run it on a base
 * `assertAbsoluteHttpUrl` accepted, whose userinfo is empty if present; the
 * config loader runs it on every registered base too, so a registered base and
 * an override naming the same host compare equal.
 */
export function withoutEmptyUserinfo(base: string): string {
  return base.replace(EMPTY_USERINFO, '$1//');
}

/**
 * Marks a `base_url` rejection as locally raised rather than reported by ntfy,
 * as `data.baseUrlRejected` on the error a caller receives. `NtfyService` stamps
 * its redirect refusal with it too.
 */
export const REJECTION_MARKER = { baseUrlRejected: true } as const;

/**
 * Address ranges no publicly-reachable ntfy server lives on: RFC 1918 private
 * space, RFC 6598 shared address space (`100.64/10` — what overlay meshes like
 * Tailscale hand out, so it reaches a whole private network), loopback,
 * link-local (cloud metadata answers on 169.254.169.254), the unspecified
 * address, and the IPv6 counterparts. `BlockList` does the prefix math
 * natively, so there is no CIDR parsing here.
 */
function buildReservedRanges(): BlockList {
  const list = new BlockList();
  list.addSubnet('0.0.0.0', 8);
  list.addSubnet('10.0.0.0', 8);
  list.addSubnet('100.64.0.0', 10);
  list.addSubnet('127.0.0.0', 8);
  list.addSubnet('169.254.0.0', 16);
  list.addSubnet('172.16.0.0', 12);
  list.addSubnet('192.168.0.0', 16);
  list.addSubnet('::', 128, 'ipv6');
  list.addSubnet('::1', 128, 'ipv6');
  list.addSubnet('fc00::', 7, 'ipv6');
  list.addSubnet('fe80::', 10, 'ipv6');
  return list;
}

const RESERVED_RANGES = buildReservedRanges();

/**
 * True when the literal address falls in a reserved range.
 *
 * IPv4-mapped IPv6 is handled by `BlockList` itself: it matches a mapped
 * address against the IPv4 rules in either textual form (`::ffff:127.0.0.1`
 * and `::ffff:7f00:1` are the same address, and WHATWG URL parsing emits only
 * the second), while leaving mapped *public* addresses alone — so there is no
 * need to block all of `::ffff:0:0/96`. The mapped cases in
 * `base-url-guard.test.ts` pin that behavior.
 */
export function isReservedAddress(address: string): boolean {
  return RESERVED_RANGES.check(address, isIPv4(address) ? 'ipv4' : 'ipv6');
}

/** Recovery hint for a `base_url` that carries credentials. */
const USERINFO_HINT =
  'Remove the `user:password@` part of `base_url`: credentials never travel in the URL. To reach a server that needs them, ask the operator to register it in `NTFY_SERVERS` with `authToken`, or `authUsername` + `authPassword`, and pass its registered URL as `base_url`.';

/**
 * Parse a `base_url` override, enforce the `http:`/`https:` scheme, and refuse
 * credentials in it. Unconditional — a relative or non-HTTP value can never
 * reach a working ntfy server, so it is a caller mistake worth naming
 * precisely.
 *
 * Credentials (a non-empty username or password, however spelled or encoded)
 * are refused: they reach ntfy only from this server's own configuration, which
 * scopes them to the registered base they belong to, never from a URL. An empty
 * userinfo (`https://@host`) carries none and passes. The messages quote no raw
 * value: a value that does not parse
 * cannot be split into credential and host, so none of it is quoted, and the
 * other two name only the scheme or the host.
 */
export function assertAbsoluteHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw validationError('base_url is not an absolute URL.', {
      ...REJECTION_MARKER,
      recovery: { hint: BASE_URL_HINT },
    });
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw validationError(`base_url uses an unsupported scheme (${url.protocol}).`, {
      ...REJECTION_MARKER,
      recovery: { hint: BASE_URL_HINT },
    });
  }
  if (url.username || url.password) {
    throw validationError(
      `base_url carries credentials (user:password@) for host "${url.host}"; a base URL may not carry them.`,
      { ...REJECTION_MARKER, recovery: { hint: USERINFO_HINT } },
    );
  }
  return url;
}

/**
 * Reject a host that resolves to a non-public address. Every resolved address
 * is checked, not just the first, so a hostname with one private A record
 * among several cannot slip through.
 *
 * **Residual time-of-check/time-of-use window.** The resolution here is not
 * the one `fetch` performs: a hostname whose DNS answer changes between the
 * two calls (DNS rebinding) can still be dereferenced. Closing it needs the
 * connection pinned to the address validated here — a custom dispatcher this
 * server has no dependency for, and Bun's `fetch` accepts none. Redirects are
 * blocked separately on this path (`redirect: 'error'` in `NtfyService`), which
 * covers the far easier variant of the same escape.
 */
export async function assertPublicHost(url: URL): Promise<void> {
  // WHATWG `hostname` keeps the brackets on IPv6 literals; `lookup` rejects them.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch (err) {
    throw serviceUnavailable(
      `Could not resolve base_url host "${hostname}".`,
      { ...REJECTION_MARKER, hostname },
      { cause: err },
    );
  }

  const blocked = addresses.find(({ address }) => isReservedAddress(address));
  if (blocked) {
    throw validationError(
      `base_url host "${hostname}" resolves to a non-public address (${blocked.address}); private, loopback, and link-local destinations are blocked.`,
      {
        ...REJECTION_MARKER,
        recovery: {
          hint: 'Target a publicly reachable ntfy server, or ask the operator to register this host in `NTFY_SERVERS` / `NTFY_BASE_URL` — registered servers are exempt from the check.',
        },
      },
    );
  }
}
