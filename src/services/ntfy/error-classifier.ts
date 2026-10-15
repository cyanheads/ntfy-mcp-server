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

/**
 * True for the failure `NtfyService` raises when a `200` body is not what ntfy
 * sends: a poll body that is not its JSON message stream, or a publish or
 * clear/delete reply that is not its message envelope. It is a
 * `ServiceUnavailable` that can carry the `(failed after N attempts)` suffix, so
 * `isUpstreamUnreachable` would claim it too — handlers check this first.
 */
export function isUpstreamMalformed(err: unknown): boolean {
  return (err as { data?: { reason?: unknown } })?.data?.reason === 'upstream_malformed';
}

function isDeadlineExceeded(err: unknown): boolean {
  return (
    getCode(err) === JsonRpcErrorCode.Timeout &&
    (err as { data?: { reason?: unknown } })?.data?.reason === 'retry_deadline_exceeded'
  );
}

export function isAuthCode(code: unknown): boolean {
  return code === JsonRpcErrorCode.Forbidden || code === JsonRpcErrorCode.Unauthorized;
}

export function isRateLimitedCode(code: unknown): boolean {
  return code === JsonRpcErrorCode.RateLimited;
}

/**
 * The upstream `Retry-After` (captured by `httpErrorFromResponse`) as
 * `ctx.fail` data, or `undefined` when there was none. `ctx.fail` builds a new
 * error, so without this the one concrete wait the upstream named never
 * reaches the caller.
 */
export function retryAfterData(err: unknown): { retryAfter: string | number } | undefined {
  const value = (err as { data?: { retryAfter?: unknown } })?.data?.retryAfter;
  return typeof value === 'string' || typeof value === 'number' ? { retryAfter: value } : undefined;
}

export function isInvalidParamsCode(code: unknown): boolean {
  return code === JsonRpcErrorCode.InvalidParams || code === JsonRpcErrorCode.ValidationError;
}

export function isNotFoundCode(code: unknown): boolean {
  return code === JsonRpcErrorCode.NotFound;
}

/**
 * The retry suffix `(failed after N attempts)` marks an error the framework's
 * retry boundary already gave up on, which is the signal that ntfy itself is
 * not answering rather than answering with a complaint. A raw network throw
 * (DNS failure, refused connection) arrives with no JSON-RPC code at all; an
 * upstream 5xx arrives classified — `Timeout` for a 504, `ServiceUnavailable`
 * for every other 5xx — since the framework maps no status onto
 * `InternalError`, that code meaning *this* server failed. `InternalError`
 * stays accepted for the classifier's own fallback on an unrecognized throw.
 *
 * `RateLimited` is excluded even though it is transient and exhausts with the
 * same suffix: a quota is a live server answering, and every ntfy surface
 * declares a `rate_limited` reason for it. `RequestCancelled` is excluded
 * because the caller is the one who left. Retry exhaustion is also required,
 * never a matching code on its own: a 503 whose `Retry-After` exceeds the retry
 * budget fails fast without ever looping.
 *
 * Running out of the call deadline counts as exhaustion too. `withRetry`
 * reports it as a `Timeout` carrying `data.reason: 'retry_deadline_exceeded'`
 * and no suffix; the service passes that shape through only when the last
 * attempt got no answer from ntfy, so it always belongs here.
 */
export function isUpstreamUnreachable(err: unknown): boolean {
  if (isDeadlineExceeded(err)) return true;
  if (!/\(failed after \d+ attempts?\)/.test(getMessage(err))) return false;
  const code = getCode(err);
  if (typeof code !== 'number') return true;
  return (
    code === JsonRpcErrorCode.ServiceUnavailable ||
    code === JsonRpcErrorCode.Timeout ||
    code === JsonRpcErrorCode.InternalError
  );
}

/**
 * The `McpError` message ("ntfy returned HTTP …") and the captured upstream body
 * (`err.data.body`), lowercased — the distinguishing keywords live in the body,
 * not the status-line message.
 */
function rejectionText(err: unknown): string {
  return `${getMessage(err)} ${getDataBody(err)}`.toLowerCase();
}

/**
 * Heuristic split of a 4xx-classed error into one of the publish contract
 * sub-reasons, read from both the status-line message and the captured body.
 * Returns `undefined` when no case matches.
 *
 * ntfy's three `delay` rejections (40004 unparseable, 40005 too soon, 40006 too
 * far out) share the prefix `invalid delay parameter`, matched first because
 * 40006 also says "too large". Nothing looser is matched: ntfy's other
 * delay-related rejections (a delayed message with caching off, e-mail, or a
 * call; an attachment that expires first; a bad timezone) mention a delay or
 * link the scheduled-delivery docs, but their text already names the conflict.
 *
 * Size rejections are recognized by the phrase "too large" — a bare mention of
 * an attachment is not one, since ntfy's "attachment URL is invalid" rejection
 * needs the opposite advice from "shorten the payload". Oversize *bodies* come
 * back as HTTP 413, which callers classify from `getDataStatus` instead; which
 * field an oversize 400 names is `oversizedPublishField`'s call.
 */
export function classifyInvalidParams(
  err: unknown,
): 'invalid_delay' | 'invalid_attachment' | 'payload_too_large' | 'unverified_contact' | undefined {
  const haystack = rejectionText(err);
  if (haystack.includes('invalid delay parameter')) {
    return 'invalid_delay';
  }
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

/**
 * The publish field an oversize 400 names: `title` for ntfy's 40057
 * (`invalid request: title is too large`), `tags` for 40058
 * (`invalid request: tags are too large`), `undefined` for anything else. The
 * full phrase is matched, so 40041 ("message or title is too large after
 * replacing template") is not read as a title overflow.
 */
export function oversizedPublishField(err: unknown): 'title' | 'tags' | undefined {
  const haystack = rejectionText(err);
  if (haystack.includes('invalid request: title is too large')) return 'title';
  if (haystack.includes('invalid request: tags are too large')) return 'tags';
  return;
}
