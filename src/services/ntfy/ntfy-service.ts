/**
 * @fileoverview HTTP client for the ntfy publish/subscribe API. Wraps a
 * timed raw `fetch` (`timedFetch`) in `withRetry` so the publish, manage, and
 * fetch calls share one transient-failure boundary, bounded end to end — body
 * reads included — by the per-attempt timeout, the caller's signal, and one
 * call deadline (`CALL_DEADLINE_MS`). Auth headers are scoped to specific
 * registered base URLs — per-call `baseUrl` overrides that match a registered
 * base forward that base's credentials, anything else goes out unauthenticated
 * to avoid leaking credentials to arbitrary hosts the agent picks.
 *
 * Overrides are also validated before they are dereferenced: absolute
 * `http(s)` form always, plus a public-address requirement and a redirect block
 * when `NTFY_BLOCK_PRIVATE_HOSTS` is on — see `base-url-guard.ts`.
 * @module services/ntfy/ntfy-service
 */

import {
  McpError,
  requestCancelled,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';

import type { NtfyServerEntry, ServerConfig } from '@/config/server-config.js';
import { assertAbsoluteHttpUrl, assertPublicHost, REJECTION_MARKER } from './base-url-guard.js';
import { getDataBody, upstreamErrorDetail } from './error-classifier.js';
import type {
  ManageOperation,
  NtfyCallOptions,
  NtfyFetchParams,
  NtfyFetchResult,
  NtfyManageResponse,
  NtfyMessage,
  NtfyPublishRequest,
  NtfyPublishResponse,
} from './types.js';

/**
 * Wall-clock budget for one service call: every attempt, every backoff, and
 * every body read. Below the 60 s default request timeout of MCP SDK clients,
 * so a call that runs out of time reaches the caller as this server's
 * classified error rather than a client-side transport timeout.
 */
export const CALL_DEADLINE_MS = 50_000;

/**
 * One timed round trip: `fetch` plus `read`, the step that consumes the
 * response. Both run under one signal — the per-attempt timer composed with
 * the `withRetry` attempt signal (the call deadline and the caller's signal) —
 * so a body that stalls after the headers is cut off by the same clocks as
 * headers that never arrive. Aborting the request signal errors a body still
 * being read, in Bun and Node alike.
 *
 * Bypasses the framework's `fetchWithTimeout` because that helper throws
 * `ServiceUnavailable` on every non-ok response, which would erase the
 * upstream's actual status code from `httpErrorFromResponse` — and we need
 * that for the error contract mapping (`forbidden_topic` ← 403, `not_found`
 * ← 404, `invalid_since` ← 400, etc.).
 *
 * The per-attempt timer aborts with a plain `Timeout` error, which the retry
 * boundary treats as transient. Which abort fired is sorted out above: a
 * deadline expiry by `withRetry`, a caller abort by `NtfyService.run`.
 */
async function timedFetch<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  attemptSignal: AbortSignal,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Timeout')), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.any([controller.signal, attemptSignal]),
      });
    } catch (err) {
      throw init.redirect === 'error' && isBlockedRedirect(err) ? refusedRedirect(url, err) : err;
    }
    // Outside the redirect check: once ntfy has answered, an error `read`
    // raises is ntfy's answer, whatever its text says.
    return await read(response);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A refused redirect is a deliberate block, not a transient network fault:
 * name it, and give it a non-retryable code so the retry boundary doesn't burn
 * its attempts re-refusing the same hop.
 */
function refusedRedirect(url: string, cause: unknown): McpError {
  return validationError(
    `base_url redirected away from ${new URL(url).host}; redirects are not followed for unregistered base URLs while NTFY_BLOCK_PRIVATE_HOSTS is on.`,
    {
      ...REJECTION_MARKER,
      recovery: {
        hint: 'Pass the final ntfy server URL directly, or ask the operator to register it in `NTFY_SERVERS` / `NTFY_BASE_URL`.',
      },
    },
    { cause },
  );
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function buildAuthHeader(entry: NtfyServerEntry): string | undefined {
  if (entry.authToken) return `Bearer ${entry.authToken}`;
  if (entry.authUsername && entry.authPassword) {
    const encoded = Buffer.from(`${entry.authUsername}:${entry.authPassword}`, 'utf-8').toString(
      'base64',
    );
    return `Basic ${encoded}`;
  }
  return;
}

/**
 * Build the error for a non-OK ntfy response, with the upstream explanation
 * folded into the message. `httpErrorFromResponse` renders only the status line
 * ("ntfy returned HTTP 400 Bad Request.") and captures the body under
 * `data.body` — but `content[]` error text is built from the message plus the
 * recovery hint, so the captured body never reaches it, and it is dropped
 * outright once a tool re-throws through `ctx.fail(reason, message, …)`.
 * Folding it in here — the one place every tool and the resource shares — puts
 * ntfy's "invalid delay parameter: unable to parse delay" on both surfaces for
 * classified and unclassified failures alike.
 */
async function ntfyHttpError(response: Response, data: Record<string, unknown>): Promise<McpError> {
  const err = await httpErrorFromResponse(response, { service: 'ntfy', data });
  const detail = upstreamErrorDetail(getDataBody(err));
  if (!detail) return err;
  return new McpError(err.code, `${err.message.replace(/\.$/, '')}: ${detail}`, err.data);
}

/**
 * Recognize the rejection `fetch` raises when `redirect: 'error'` is set and
 * the upstream answers with a 3xx. The wording differs by runtime (undici
 * nests `unexpected redirect` under `cause`; Bun words it differently), so the
 * whole cause chain is scanned for the one word both share. A miss only costs
 * the clearer message — the redirect is refused either way. Applied only to a
 * rejection of `fetch` itself, never to an error raised reading ntfy's answer.
 */
function isBlockedRedirect(err: unknown): boolean {
  for (let cursor: unknown = err; cursor; cursor = (cursor as { cause?: unknown }).cause) {
    const message = (cursor as { message?: unknown }).message;
    if (typeof message === 'string' && /redirect/i.test(message)) return true;
  }
  return false;
}

/** Per-call transport decisions derived from the resolved base URL. */
interface ResolvedBase {
  authHeader: string | undefined;
  base: string;
  /** `'error'` on a guarded override, so a public host cannot 302 to a private one. */
  redirect: 'error' | undefined;
}

export class NtfyService {
  private readonly authByBase: Map<string, string>;
  private readonly defaultBase: string;
  /**
   * Every configured base, credentialed or not — the SSRF-guard bypass set.
   * `authByBase` holds only entries that produced an auth header, so a
   * registered no-auth LAN server would otherwise fail the address check.
   */
  private readonly registeredBases: Set<string>;

  constructor(private readonly cfg: ServerConfig) {
    this.authByBase = new Map();
    this.registeredBases = new Set();
    for (const entry of cfg.servers) {
      const base = trimTrailingSlash(entry.baseUrl);
      this.registeredBases.add(base);
      const header = buildAuthHeader(entry);
      if (header) this.authByBase.set(base, header);
    }
    const first = cfg.servers[0];
    if (!first) throw new Error('ServerConfig.servers must contain at least one entry.');
    this.defaultBase = trimTrailingSlash(first.baseUrl);
  }

  /** Visible for tests / resources that need to render canonical topic URLs. */
  get baseUrl(): string {
    return this.defaultBase;
  }

  /**
   * Resolve the base URL for one call and decide what the transport may do
   * with it. A caller-supplied override is validated here — the choke point
   * every tool and the topic resource shares. Configured bases are the
   * operator's own choice, URL-validated at config load, so they skip it.
   */
  private async resolveBase(override?: string, signal?: AbortSignal): Promise<ResolvedBase> {
    if (override === undefined) {
      return {
        base: this.defaultBase,
        authHeader: this.authByBase.get(this.defaultBase),
        redirect: undefined,
      };
    }

    const base = trimTrailingSlash(override);
    const url = assertAbsoluteHttpUrl(base);
    const authHeader = this.authByBase.get(base);

    if (!this.cfg.blockPrivateHosts || this.registeredBases.has(base)) {
      return { base, authHeader, redirect: undefined };
    }
    await untilCancelled(assertPublicHost(url), signal);
    return { base, authHeader, redirect: 'error' };
  }

  private buildHeaders(
    authHeader: string | undefined,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (authHeader) headers.Authorization = authHeader;
    return headers;
  }

  /**
   * `POST /` with a JSON body. Returns the upstream message envelope echoing
   * the published values plus the server-assigned `id`/`time`/`expires`. A
   * `200` whose body is not that envelope fails without a resend — see
   * `parseReply`.
   */
  async publish(
    body: NtfyPublishRequest,
    opts: NtfyCallOptions = {},
  ): Promise<NtfyPublishResponse> {
    const { base, authHeader, redirect } = await this.resolveBase(opts.baseUrl, opts.signal);
    const url = `${base}/`;

    // `cache` / `firebase` are wire-level headers, not JSON body fields.
    const { cache, firebase, ...jsonBody } = body;
    const extraHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (cache === false) extraHeaders['X-Cache'] = 'no';
    if (firebase === false) extraHeaders['X-Firebase'] = 'no';

    return await this.run(
      (signal) =>
        timedFetch(
          url,
          {
            method: 'POST',
            headers: this.buildHeaders(authHeader, extraHeaders),
            body: JSON.stringify(jsonBody),
            ...(redirect ? { redirect } : {}),
          },
          this.cfg.requestTimeoutMs,
          signal,
          async (response) => {
            if (!response.ok) {
              throw await ntfyHttpError(response, { operation: 'publish', topic: body.topic });
            }
            return parseReply<NtfyPublishResponse>(response, await response.text(), 'publish');
          },
        ),
      'ntfy publish',
      opts.signal,
    );
  }

  /**
   * `PUT /<topic>/<id>/clear` or `DELETE /<topic>/<id>`. Returns the event
   * envelope subscribers see; a `200` whose body is not that envelope, with the
   * `sequence_id` it references, fails without a resend — see `parseReply`.
   */
  async manage(
    topic: string,
    sequenceId: string,
    operation: ManageOperation,
    opts: NtfyCallOptions = {},
  ): Promise<NtfyManageResponse> {
    const { base, authHeader, redirect } = await this.resolveBase(opts.baseUrl, opts.signal);
    const path =
      operation === 'clear'
        ? `${base}/${encodeURIComponent(topic)}/${encodeURIComponent(sequenceId)}/clear`
        : `${base}/${encodeURIComponent(topic)}/${encodeURIComponent(sequenceId)}`;

    return await this.run(
      (signal) =>
        timedFetch(
          path,
          {
            method: operation === 'clear' ? 'PUT' : 'DELETE',
            headers: this.buildHeaders(authHeader),
            ...(redirect ? { redirect } : {}),
          },
          this.cfg.requestTimeoutMs,
          signal,
          async (response) => {
            if (!response.ok) {
              throw await ntfyHttpError(response, { operation, topic, sequenceId });
            }
            return parseReply<NtfyManageResponse>(response, await response.text(), operation, [
              'sequence_id',
            ]);
          },
        ),
      `ntfy ${operation}`,
      opts.signal,
    );
  }

  /**
   * `GET /<topic>/json?poll=1&...`. Parses the NDJSON line-delimited stream
   * into an array, alongside ntfy's `X-Messages-Truncated` replay-cap flag;
   * `open` and `keepalive` frames are filtered out by the caller (they're
   * connection-level, not notification data). A body that is not that stream
   * fails inside the retried round trip — see `parsePollBody`.
   */
  async fetch(params: NtfyFetchParams, opts: NtfyCallOptions = {}): Promise<NtfyFetchResult> {
    const { base, authHeader, redirect } = await this.resolveBase(opts.baseUrl, opts.signal);
    const search = new URLSearchParams({ poll: '1' });
    if (params.since) search.set('since', params.since);
    if (params.scheduled) search.set('scheduled', '1');
    if (params.priority?.length) search.set('priority', params.priority.join(','));
    if (params.tags?.length) search.set('tags', params.tags.join(','));
    if (params.id) search.set('id', params.id);
    if (params.title) search.set('title', params.title);
    if (params.message) search.set('message', params.message);

    const url = `${base}/${encodeURIComponent(params.topic)}/json?${search.toString()}`;
    const errorData = { operation: 'fetch', topic: params.topic };

    return await this.run(
      (signal) =>
        timedFetch(
          url,
          {
            method: 'GET',
            headers: this.buildHeaders(authHeader),
            ...(redirect ? { redirect } : {}),
          },
          this.cfg.requestTimeoutMs,
          signal,
          async (response) => {
            if (!response.ok) throw await ntfyHttpError(response, errorData);
            const messages = await parsePollBody(
              await response.text(),
              response.headers.get('content-type'),
              errorData,
            );
            return {
              messages,
              upstreamTruncated: response.headers.get('x-messages-truncated') === '1',
            };
          },
        ),
      'ntfy poll',
      opts.signal,
    );
  }

  /**
   * The shared retry boundary: up to `NTFY_MAX_RETRIES` retries, all inside
   * {@link CALL_DEADLINE_MS}. `fn` receives the attempt signal and must thread
   * it through the whole round trip, body read included.
   *
   * A caller abort surfaces as `RequestCancelled` wherever it lands — mid-request
   * or mid-backoff — so it is never counted as an ntfy outage or retried.
   *
   * `operation` reaches callers: `withRetry` opens its deadline message with it
   * and sets it as `data.operation` on an exhausted error, so it names the
   * round trip (`ntfy poll`), not this class.
   */
  private async run<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    operation: string,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    let attempts = 0;
    try {
      return await withRetry(
        ({ signal }) => {
          attempts += 1;
          return fn(signal);
        },
        {
          maxRetries: this.cfg.maxRetries,
          baseDelayMs: 500,
          deadlineMs: CALL_DEADLINE_MS,
          operation,
          ...(callerSignal ? { signal: callerSignal } : {}),
        },
      );
    } catch (err) {
      if (callerSignal?.aborted) {
        throw requestCancelled('The ntfy request was cancelled by the caller.', undefined, {
          cause: err,
        });
      }
      throw retryAfterCutShort(lastAnswerOnDeadline(err), attempts);
    }
  }
}

/**
 * Settle `work`, or reject with `RequestCancelled` as soon as the caller's
 * signal aborts. The `base_url` lookup runs before the retry boundary and takes
 * no signal, so without this a cancel waits out the resolver and then surfaces
 * as whatever the lookup ended in.
 */
function untilCancelled<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(requestCancelled('The ntfy request was cancelled by the caller.'));
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener('abort', cancel, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

/**
 * `withRetry` ends a ladder whose next honored `Retry-After` outlasts the call
 * deadline (or `maxDelayMs`) by rethrowing the last attempt's error untouched,
 * with no `(failed after N attempts)` suffix — so a 503 that was retried and
 * still answering would escape the handlers' exhaustion check. Mark it
 * exhausted the way running out of attempts does. A first attempt that failed
 * fast on a long `Retry-After` stays as it was: nothing was retried.
 */
function retryAfterCutShort(err: unknown, attempts: number): unknown {
  if (!(err instanceof McpError) || attempts < 2) return err;
  if (err.data?.retryAfter === undefined || err.data.retryAttempts !== undefined) return err;
  return new McpError(
    err.code,
    `${err.message} (failed after ${attempts} attempts)`,
    { ...err.data, retryAttempts: attempts },
    { cause: err },
  );
}

/**
 * When the deadline ends the ladder because the next backoff would outlast
 * it, the last attempt already got ntfy's answer — a 429, a 5xx, a damaged
 * poll body or reply. Report that answer, marked exhausted the way running out
 * of attempts marks it, so it classifies as what ntfy said (`rate_limited`,
 * `upstream_malformed`) rather than as an unreachable server. A deadline that
 * fired mid-attempt has no answer to report and stays the framework's
 * `Timeout` (`data.reason: 'retry_deadline_exceeded'`).
 */
function lastAnswerOnDeadline(err: unknown): unknown {
  if (!(err instanceof McpError) || err.data?.reason !== 'retry_deadline_exceeded') return err;
  const answer = err.cause;
  if (!(answer instanceof McpError)) return err;
  const answered =
    typeof answer.data?.status === 'number' || answer.data?.reason === 'upstream_malformed';
  if (!answered) return err;
  const attempts = err.data.retryAttempts as number;
  return new McpError(
    answer.code,
    `${answer.message} (failed after ${attempts} attempt${attempts > 1 ? 's' : ''})`,
    { ...answer.data, retryAttempts: attempts, deadlineMs: CALL_DEADLINE_MS },
    { cause: err },
  );
}

/** ntfy's JSON error body — `{ code, http, error, link? }` — as one poll-body line. */
function isErrorEnvelope(value: unknown): value is { error: string; http: number } {
  const { http, error } = (value ?? {}) as { error?: unknown; http?: unknown };
  return (
    typeof error === 'string' &&
    typeof http === 'number' &&
    Number.isInteger(http) &&
    http >= 400 &&
    http <= 599
  );
}

/** The fields ntfy writes on every message, `open` / `keepalive` frames included — none is `omitempty`. */
const ENVELOPE_FIELDS = 'string `id`, `event`, and `topic`, numeric `time`';

/**
 * A message envelope: string `id`, `event`, and `topic`, numeric `time`. One
 * check for a poll line and for the reply to a publish or a clear/delete, since
 * ntfy writes the same message object in all three.
 */
function isMessageEnvelope(value: unknown): value is NtfyMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { id, event, topic, time } = value as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    typeof event === 'string' &&
    typeof topic === 'string' &&
    typeof time === 'number'
  );
}

/**
 * Parse the `200` reply to a publish or a clear/delete: one message envelope,
 * plus each of `fields` as a string. Anything else — an empty body, an HTML
 * page, JSON without the envelope fields — fails as `ServiceUnavailable` with
 * the reason a damaged poll body takes, `upstream_malformed`, but marked
 * `retryable: false`: ntfy answered `200`, so the notification or event may
 * already be out, and a resend would deliver it twice. `withRetry` fails that
 * flag on the first attempt instead of re-sending the request.
 */
function parseReply<T>(
  response: Response,
  text: string,
  operation: string,
  fields: readonly string[] = [],
): T {
  const contentType = response.headers.get('content-type');
  const malformed = (problem: string) =>
    serviceUnavailable(
      `The ${operation} was answered with HTTP 200, but the reply${contentType ? ` (content-type ${contentType})` : ''} ${problem}.`,
      { reason: 'upstream_malformed', retryable: false },
    );
  if (!text.trim()) throw malformed('is empty');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw malformed('is not valid JSON');
  }
  if (!isMessageEnvelope(parsed)) throw malformed(`is not an ntfy message (${ENVELOPE_FIELDS})`);
  for (const field of fields) {
    if (typeof (parsed as unknown as Record<string, unknown>)[field] !== 'string') {
      throw malformed(`names no \`${field}\``);
    }
  }
  return parsed as T;
}

function malformedPollBody(line: number, problem: string, contentType: string | null): McpError {
  const type = contentType ? ` (content-type ${contentType})` : '';
  return serviceUnavailable(
    `The poll response is not ntfy's JSON message stream${type}: line ${line} ${problem}.`,
    { reason: 'upstream_malformed', retryable: true },
  );
}

/**
 * Parse a poll body: NDJSON, one envelope per non-blank line. One bad line
 * means the rest of the body can't be trusted either — a cut-off stream, an
 * HTML error page, a captive portal — so it throws a transient
 * `ServiceUnavailable` (`data.reason: 'upstream_malformed'`) and the retry
 * boundary re-issues the poll, rather than reporting the survivors as the
 * whole window.
 *
 * ntfy writes its JSON error body onto a replay that has already started with
 * `200` when a limit trips mid-stream; that line surfaces as the upstream HTTP
 * error it describes, through the same mapping a non-OK response takes.
 */
async function parsePollBody(
  text: string,
  contentType: string | null,
  errorData: Record<string, unknown>,
): Promise<NtfyMessage[]> {
  const out: NtfyMessage[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw malformedPollBody(index + 1, 'is not valid JSON', contentType);
    }
    if (isErrorEnvelope(parsed)) {
      throw await ntfyHttpError(new Response(line, { status: parsed.http }), errorData);
    }
    if (!isMessageEnvelope(parsed)) {
      throw malformedPollBody(
        index + 1,
        `is not an ntfy message (${ENVELOPE_FIELDS})`,
        contentType,
      );
    }
    out.push(parsed);
  }
  return out;
}

let _service: NtfyService | undefined;

export function initNtfyService(cfg: ServerConfig): NtfyService {
  _service = new NtfyService(cfg);
  return _service;
}

export function getNtfyService(): NtfyService {
  if (!_service) {
    throw new Error('NtfyService not initialized — call initNtfyService() in setup().');
  }
  return _service;
}

export function resetNtfyService(): void {
  _service = undefined;
}
