/**
 * @fileoverview Validation for the per-call `base_url` override. Two layers,
 * deliberately split:
 *
 *  - **Always on** — `assertAbsoluteHttpUrl` parses the override and rejects
 *    anything that is not an absolute `http:`/`https:` URL. The advertised
 *    contract is "absolute URL", so a malformed value fails at the boundary
 *    with an actionable message instead of surfacing as an opaque `fetch`
 *    error several layers down.
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

/** Recovery hint shared by every `base_url` rejection. */
export const BASE_URL_HINT =
  'Pass an absolute `http://` or `https://` URL (e.g. `https://ntfy.example.com`), or omit `base_url` to use the configured server.';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Turn a tool's raw `base_url` argument into the override `NtfyService`
 * expects: the empty string a form-based client submits for an untouched
 * optional field means "no override", not a base URL of `""`. Trailing slashes
 * come off here as well as in the service, because a handler renders the
 * override into the canonical topic URL it returns.
 */
export function normalizeBaseOverride(raw: string | undefined): string | undefined {
  return raw ? raw.replace(/\/+$/, '') : undefined;
}

/**
 * Marks a `base_url` rejection as locally raised rather than reported by ntfy.
 * Tool handlers classify upstream failures by code, and a local
 * `ValidationError` would otherwise be read as an upstream complaint about some
 * other argument — `isBaseUrlRejection` in `error-classifier.ts` is how they
 * tell the two apart. `NtfyService` stamps its redirect refusal with it too.
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

/**
 * Parse a `base_url` override and enforce the `http:`/`https:` scheme.
 * Unconditional — a relative or non-HTTP value can never reach a working ntfy
 * server, so it is a caller mistake worth naming precisely.
 */
export function assertAbsoluteHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw validationError(`base_url is not an absolute URL: ${raw}`, {
      ...REJECTION_MARKER,
      recovery: { hint: BASE_URL_HINT },
    });
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw validationError(`base_url uses an unsupported scheme (${url.protocol}): ${raw}`, {
      ...REJECTION_MARKER,
      recovery: { hint: BASE_URL_HINT },
    });
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
      `Could not resolve base_url host ${hostname}.`,
      { ...REJECTION_MARKER, hostname },
      { cause: err },
    );
  }

  const blocked = addresses.find(({ address }) => isReservedAddress(address));
  if (blocked) {
    throw validationError(
      `base_url host ${hostname} resolves to a non-public address (${blocked.address}); private, loopback, and link-local destinations are blocked.`,
      {
        ...REJECTION_MARKER,
        recovery: {
          hint: 'Target a publicly reachable ntfy server, or ask the operator to register this host in `NTFY_SERVERS` / `NTFY_BASE_URL` — registered servers are exempt from the check.',
        },
      },
    );
  }
}
