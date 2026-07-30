/**
 * @fileoverview Pure-data classifiers for ntfy upstream errors. Lifted out of
 * tool/resource handlers so the error-contract conformance lint doesn't see
 * bare `JsonRpcErrorCode` references next to `throw` statements; handlers
 * route through `ctx.fail(reason, …)` exclusively.
 * @module services/ntfy/error-classifier
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

export function getCode(err: unknown): unknown {
  return (err as { code?: unknown })?.code;
}

export function getMessage(err: unknown): string {
  const m = (err as { message?: unknown })?.message;
  return typeof m === 'string' ? m : '';
}

/** Read `data.body` (set by `httpErrorFromResponse`) when present. */
export function getDataBody(err: unknown): string {
  const data = (err as { data?: { body?: unknown } })?.data;
  const body = data?.body;
  return typeof body === 'string' ? body : '';
}

/**
 * Read the canonical numeric `data.status` (set by `httpErrorFromResponse`) when
 * present. The upstream HTTP status is more precise than the JSON-RPC code it
 * maps to — several distinct statuses collapse onto `InvalidRequest`, so status
 * is the only way to recognize them individually.
 */
export function getDataStatus(err: unknown): number | undefined {
  const status = (err as { data?: { status?: unknown } })?.data?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * ntfy answers a rejected request with a JSON body — `{ code, http, error, link }`
 * — where `error` names the offending parameter and `link` points at the relevant
 * docs section. Extract them so the caller can fold them into the error message;
 * returns `undefined` for a non-JSON body (plain-text 403s, truncated bodies) or
 * one without an `error` string.
 */
export function upstreamErrorDetail(body: string): string | undefined {
  if (!body) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return;
  }
  const { error, link } = (parsed ?? {}) as { error?: unknown; link?: unknown };
  if (typeof error !== 'string' || !error) return;
  return typeof link === 'string' && link ? `${error} (see ${link})` : error;
}

/**
 * True for a `base_url` rejection raised locally — a bad scheme, a non-public
 * host, a refused redirect, an unresolvable host. These carry codes the upstream
 * classifiers below also claim, so handlers must let them through untouched
 * rather than relabel them as a complaint about some other argument.
 */
export function isBaseUrlRejection(err: unknown): boolean {
  return (err as { data?: { baseUrlRejected?: unknown } })?.data?.baseUrlRejected === true;
}

export function isAuthCode(code: unknown): boolean {
  return code === JsonRpcErrorCode.Forbidden || code === JsonRpcErrorCode.Unauthorized;
}

export function isRateLimitedCode(code: unknown): boolean {
  return code === JsonRpcErrorCode.RateLimited;
}

export function isInvalidParamsCode(code: unknown): boolean {
  return code === JsonRpcErrorCode.InvalidParams || code === JsonRpcErrorCode.ValidationError;
}

export function isNotFoundCode(code: unknown): boolean {
  return code === JsonRpcErrorCode.NotFound;
}

/**
 * Retry-exhausted network failures surface as plain `Error` with the framework
 * retry suffix `(failed after N attempts)` and no JSON-RPC code (or the
 * `InternalError` fallback). The retry helper only retries transient/5xx
 * conditions, so the suffix alone is a reliable network-failure signal.
 */
export function isUpstreamUnreachable(err: unknown): boolean {
  if (!/\(failed after \d+ attempts?\)/.test(getMessage(err))) return false;
  const code = getCode(err);
  return typeof code !== 'number' || code === JsonRpcErrorCode.InternalError;
}

/**
 * Heuristic split of a 4xx-classed error into one of the publish contract
 * sub-reasons. Inspects both the `McpError` message ("ntfy returned HTTP …")
 * and the captured upstream body (`err.data.body`), since the distinguishing
 * keywords live in the body, not the status-line message. Returns `undefined`
 * when no case matches.
 *
 * Size rejections are recognized by the phrase "too large" — a bare mention of
 * an attachment is not one, since ntfy's "attachment URL is invalid" rejection
 * needs the opposite advice from "shorten the payload". Oversize *bodies* come
 * back as HTTP 413, which callers classify from `getDataStatus` instead.
 */
export function classifyInvalidParams(
  err: unknown,
): 'invalid_attachment' | 'payload_too_large' | 'unverified_contact' | undefined {
  const haystack = `${getMessage(err)} ${getDataBody(err)}`.toLowerCase();
  if (haystack.includes('attachment url')) {
    return 'invalid_attachment';
  }
  if (haystack.includes('too large')) {
    return 'payload_too_large';
  }
  if (haystack.includes('email') || haystack.includes('phone') || haystack.includes('verified')) {
    return 'unverified_contact';
  }
  return;
}
