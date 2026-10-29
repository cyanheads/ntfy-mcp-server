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
 * — where `code` is ntfy's own five-digit error code, `error` names the offending
 * parameter, and `link` points at the relevant docs section. Returns the parsed
 * object with its fields unchecked, or `undefined` for a body that is not a JSON
 * object (a proxy's HTML page, a plain-text 403, a body cut off by the capture
 * limit).
 */
function parseErrorEnvelope(
  body: string,
): { code?: unknown; error?: unknown; link?: unknown } | undefined {
  if (!body) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return;
  }
  return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
}

/**
 * ntfy's `error (see link)` from its error envelope, for the caller to fold into
 * the error message; `undefined` when the body is no envelope or carries no
 * `error` string.
 */
export function upstreamErrorDetail(body: string): string | undefined {
  const { error, link } = parseErrorEnvelope(body) ?? {};
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
 * clear/delete reply that is not its message envelope or that failed partway
 * through being read (a reset connection, the per-attempt timeout, or the call
 * deadline cutting it off). It is a `ServiceUnavailable` that can carry the
 * `(failed after N attempts)` suffix, so `isUpstreamUnreachable` would claim it
 * too — handlers check this first.
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

/**
 * True when ntfy itself refused access: the captured body (`data.body`) is its
 * error envelope with a `401xx` or `403xx` code. A 401 or 403 without that
 * envelope — the HTML page a reverse proxy or CDN answers with, for a reason of
 * its own — says nothing about the topic's auth, so it stays unclassified and
 * keeps its upstream status in the message. ntfy always answers with the status
 * its code names (`40301` with 403), so the code must also match the status the
 * response carried (`data.status`): an auth code on a 429, 5xx, or 400 is no
 * auth refusal ntfy sent. Every surface that maps an auth failure to
 * `forbidden_topic` asks this, never the status-derived JSON-RPC code.
 */
export function isAuthRejection(err: unknown): boolean {
  const { code } = parseErrorEnvelope(getDataBody(err)) ?? {};
  if (typeof code !== 'number' || !Number.isInteger(code)) return false;
  const family = Math.floor(code / 100);
  return (family === 401 || family === 403) && family === getDataStatus(err);
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

/**
 * `ctx.fail` data for an `upstream_unreachable` failure that carries a
 * `Retry-After`: the wait itself plus a hint that overrides the declared
 * recovery, since the ntfy server answered and the caller only has to wait
 * before `action` (e.g. `poll again`). `undefined` when there was no wait.
 */
export function unreachableWaitData(err: unknown, action: string) {
  const wait = retryAfterData(err);
  return (
    wait && {
      ...wait,
      recovery: {
        hint: `The ntfy server answered but asked to wait (Retry-After: ${wait.retryAfter}); ${action} once that wait has passed.`,
      },
    }
  );
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
 * upstream 5xx arrives classified — `Timeout` for a 504 (and for a 408 or 425,
 * which the framework also treats as transient), `ServiceUnavailable` for
 * every other 5xx — since the framework maps no status onto
 * `InternalError`, that code meaning *this* server failed. `InternalError`
 * stays accepted for the classifier's own fallback on an unrecognized throw.
 *
 * `RateLimited` is excluded even though it is transient and exhausts with the
 * same suffix: a quota is a live server answering, and every ntfy surface
 * declares a `rate_limited` reason for it. `RequestCancelled` is excluded
 * because the caller is the one who left. The retry boundary giving up is also
 * required, never a matching code on its own.
 *
 * Running out of the call deadline counts as giving up. `withRetry` reports it
 * as a `Timeout` carrying `data.reason: 'retry_deadline_exceeded'` and no
 * suffix; the service passes that shape through only when the last attempt got
 * no answer from ntfy, so it always belongs here.
 *
 * So does a transient answer (a 5xx, or a 408/425) whose `Retry-After` the
 * call cannot wait out — over
 * `withRetry`'s 30 s single-wait cap, or past what is left of the deadline.
 * `withRetry` rethrows that answer untouched, and the service adds a suffix
 * only when an earlier attempt was really retried, so a first answer arrives
 * with `data.retryAfter` and no suffix: as an over-budget 429 classifies as
 * `rate_limited` without claiming a retry, this one classifies here. A 5xx
 * marked `retryable: false` (a 501) was never going to be retried, and stays
 * out.
 */
export function isUpstreamUnreachable(err: unknown): boolean {
  if (isDeadlineExceeded(err)) return true;
  const code = getCode(err);
  const transient =
    code === JsonRpcErrorCode.ServiceUnavailable || code === JsonRpcErrorCode.Timeout;
  if (!/\(failed after \d+ attempts?\)/.test(getMessage(err))) {
    const data = (err as { data?: { retryable?: unknown } })?.data;
    return transient && retryAfterData(err) !== undefined && data?.retryable !== false;
  }
  if (typeof code !== 'number') return true;
  return transient || code === JsonRpcErrorCode.InternalError;
}

/**
 * The `McpError` message ("ntfy returned HTTP …") and the captured upstream body
 * (`err.data.body`), lowercased — the distinguishing keywords live in the body,
 * not the status-line message.
 */
function rejectionText(err: unknown): string {
  return `${getMessage(err)} ${getDataBody(err)}`.toLowerCase();
}

/** ntfy's 40034 and 40052: the `call` number or `email` address is not verified on the account. */
const UNVERIFIED_CONTACT = ['phone number not verified', 'email address not verified'];

/** ntfy's 40035 and 40053: the request that set `call` or `email` carried no credentials. */
const ANONYMOUS_SENDER = [
  'anonymous phone calls are not allowed',
  'anonymous email sending is not allowed',
];

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
 * field an oversize rejection names is `oversizedPublishField`'s call.
 *
 * `unverified_contact` is ntfy refusing an `email` or `call`: the address or
 * number is not verified on the sending account (40034, 40052), or the sender
 * has no account at all (40035, 40053 — `isAnonymousSenderRejection`). Only
 * those phrases match. Every other e-mail or phone rejection — calling disabled
 * on the server (40032), a malformed number (40033), e-mail disabled (40001), a
 * malformed address (40050) — names its own fix and stays unclassified, and
 * the docs link ntfy appends never decides a label: every phrase holds a space,
 * which a URL cannot.
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
  if ([...UNVERIFIED_CONTACT, ...ANONYMOUS_SENDER].some((phrase) => haystack.includes(phrase))) {
    return 'unverified_contact';
  }
  return;
}

/**
 * True for the `unverified_contact` refusals whose cause is a missing
 * credential rather than an unverified address or number, which need the
 * credentials hint instead of the verification one.
 */
export function isAnonymousSenderRejection(err: unknown): boolean {
  const haystack = rejectionText(err);
  return ANONYMOUS_SENDER.some((phrase) => haystack.includes(phrase));
}

/**
 * The publish field an oversize rejection names: `title` for ntfy's 40057
 * (`invalid request: title is too large`), `tags` for 40058
 * (`invalid request: tags are too large`), `attachment` for the 413 41301
 * (`attachment too large, or bandwidth limit reached` — ntfy stored the message
 * as a file and the file, or the client's attachment quota, was over its
 * limit), `undefined` for anything else. The full phrase is matched, so 40041
 * ("message or title is too large after replacing template") is not read as a
 * title overflow.
 */
export function oversizedPublishField(err: unknown): 'title' | 'tags' | 'attachment' | undefined {
  const haystack = rejectionText(err);
  if (haystack.includes('invalid request: title is too large')) return 'title';
  if (haystack.includes('invalid request: tags are too large')) return 'tags';
  if (haystack.includes('attachment too large, or bandwidth limit reached')) return 'attachment';
  return;
}
