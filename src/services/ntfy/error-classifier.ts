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
 * when neither case matches.
 */
export function classifyInvalidParams(
  err: unknown,
): 'payload_too_large' | 'unverified_contact' | undefined {
  const haystack = `${getMessage(err)} ${getDataBody(err)}`.toLowerCase();
  if (
    haystack.includes('too large') ||
    haystack.includes('attachment') ||
    haystack.includes('413')
  ) {
    return 'payload_too_large';
  }
  if (haystack.includes('email') || haystack.includes('phone') || haystack.includes('verified')) {
    return 'unverified_contact';
  }
  return;
}
