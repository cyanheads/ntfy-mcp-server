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
import {
  assertAbsoluteHttpUrl,
  assertPublicHost,
  REJECTION_MARKER,
  withoutTrailingSlashes,
} from './base-url-guard.js';
import {
  getDataBody,
  hasNtfyEnvelope,
  isNotNtfyEndpoint,
  isNtfyInternalError,
  upstreamErrorDetail,
} from './error-classifier.js';
import { parseQuota } from './quota.js';
import type {
  ManageOperation,
  NtfyCallOptions,
  NtfyFetchParams,
  NtfyFetchResult,
  NtfyManageResponse,
  NtfyMessage,
  NtfyPublishRequest,
  NtfyPublishResponse,
  NtfyReply,
  NtfyWaitOptions,
  NtfyWaitResult,
  WindowStart,
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
 * being read with the abort reason itself, in Bun and Node alike.
 *
 * Bypasses the framework's `fetchWithTimeout` because that helper throws
 * `ServiceUnavailable` on every non-ok response, which would erase the
 * upstream's actual status code from `httpErrorFromResponse` — and we need
 * that for the error contract mapping (`forbidden_topic` ← 403, `not_found`
 * ← 404, `invalid_since` ← a 400 whose text is ntfy's `invalid since
 * parameter`, etc.).
 *
 * The per-attempt timer aborts with an {@link AttemptTimeout}, which the retry
 * boundary treats as transient. Which abort fired is sorted out above: a
 * deadline expiry by `withRetry`, a caller abort by `NtfyService.run`, and a
 * failed read of a publish or clear/delete reply by `parseReply`.
 *
 * A rejection of `fetch` itself passes through {@link withoutRequestUrl}
 * before anything reads it — the redirect check, the retry boundary and its
 * log records, the caller — so the error that leaves carries no request URL.
 */
async function timedFetch<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  attemptSignal: AbortSignal,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new AttemptTimeout(timeoutMs)), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.any([controller.signal, attemptSignal]),
      });
    } catch (err) {
      const failure = withoutRequestUrl(err);
      throw init.redirect === 'error' && isBlockedRedirect(failure)
        ? refusedRedirect(url, failure)
        : failure;
    }
    // Outside the redirect check: once ntfy has answered, an error `read`
    // raises is ntfy's answer, whatever its text says.
    return await read(response);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The per-attempt timer's abort reason, which `fetch` and a body still being
 * read both reject with. Its message stays the bare `Timeout` a retried-out
 * round trip has always reported; the class lets a failed reply read name the
 * clock that cut it off.
 */
class AttemptTimeout extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super('Timeout');
    this.timeoutMs = timeoutMs;
  }
}

/**
 * A refused redirect is a deliberate block, not a transient network fault:
 * name it, and give it a non-retryable code so the retry boundary doesn't burn
 * its attempts re-refusing the same hop. The message names the request host
 * only, and `cause` carries no request URL.
 */
function refusedRedirect(url: string, cause: unknown): McpError {
  return validationError(
    `base_url redirected away from "${new URL(url).host}"; redirects are not followed for unregistered base URLs while NTFY_BLOCK_PRIVATE_HOSTS is on.`,
    {
      ...REJECTION_MARKER,
      recovery: {
        hint: 'Pass the final ntfy server URL directly, or ask the operator to register it in `NTFY_SERVERS` / `NTFY_BASE_URL`.',
      },
    },
    { cause },
  );
}

/** Where a `fetch` rejection's message starts quoting the request URL; a serialized URL holds no `"`. */
const REQUEST_URL_CLAUSE = ' fetching "';

/**
 * `err`, carrying no request URL. A `fetch` rejection worded
 * `<Code> fetching "<url>". For more information, pass `verbose: true` …`
 * becomes a fresh error holding only `<Code>` — what precedes the clause, which
 * runs to the end of the message — with the original `name` and `code`, so the
 * retry boundary and the classifiers read it as before, and with no `cause`,
 * stack, or other property of the original. Any other value is returned as it
 * is: an abort reason must reach `withRetry` and `NtfyService.run` unchanged.
 */
function withoutRequestUrl(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const clauseAt = err.message.indexOf(REQUEST_URL_CLAUSE);
  if (clauseAt === -1) return err;
  const stripped = new TypeError(err.message.slice(0, clauseAt));
  stripped.name = err.name;
  const { code } = err as { code?: unknown };
  return code === undefined ? stripped : Object.assign(stripped, { code });
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

/** The status line's subject when ntfy's own envelope proves ntfy answered. */
const NTFY_SUBJECT = 'ntfy';

/**
 * What a topic name reads as in a captured body: no character a topic name
 * holds (`[a-zA-Z0-9_-]`), so no name survives the mask or re-forms around it.
 */
const TOPIC_MASK = '***';

/** The request an upstream error's `data` names for the caller, who supplied it. */
type UpstreamErrorData = {
  operation: string;
  /** One topic, or the comma-separated list a poll sends. */
  topic: string;
  sequenceId?: string;
};

/**
 * Build the error for a non-OK ntfy response, with the upstream explanation
 * folded into the message. `httpErrorFromResponse` renders only the status line
 * ("ntfy returned HTTP 400 Bad Request.") and captures the body under
 * `data.body` (and its alias `data.responseBody`), which stays on the server:
 * the classifiers read it and the failure log records it, but no client
 * envelope carries it (no `exposeBody`), and it is dropped outright once a tool
 * re-throws through `ctx.fail(reason, message, …)`. Folding ntfy's
 * `error (see link)` into the message here — the one place every tool and the
 * resource shares — puts "invalid delay parameter: unable to parse delay" on
 * both surfaces for classified and unclassified failures alike, and leaves a
 * proxy's HTML page off both.
 *
 * An answer without ntfy's envelope came from something else. Its status line
 * names `host` — the request URL's host, never its userinfo or its path, which
 * holds the topic — rather than ntfy; no `error` string its body carries is
 * folded in, since that text is not ntfy's explanation; and every topic name in
 * its captured body is masked before the failure log can write it, since such a
 * page can repeat the request path or body. ntfy's own envelope carries its
 * fixed error text, not the topic, and those words are what the classifiers
 * match, so it stays as captured. An answer whose request never reached an ntfy
 * topic route (`isNotNtfyEndpoint`) is labelled `not_ntfy_endpoint` and marked
 * `retryable: false`, since the same request gets the same answer; its
 * status-derived code stays as it is.
 */
async function ntfyHttpError(
  response: Response,
  host: string,
  data: UpstreamErrorData,
): Promise<McpError> {
  const err = await httpErrorFromResponse(response, { service: NTFY_SUBJECT, data });
  const fromNtfy = hasNtfyEnvelope(err);
  const statusLine = fromNtfy ? err.message : `${host}${err.message.slice(NTFY_SUBJECT.length)}`;
  const detail = fromNtfy ? upstreamErrorDetail(getDataBody(err)) : undefined;
  const message = detail ? `${statusLine.replace(/\.$/, '')}: ${detail}` : statusLine;
  const label = isNotNtfyEndpoint(err)
    ? { reason: 'not_ntfy_endpoint', retryable: false }
    : undefined;
  const masked = fromNtfy ? undefined : maskTopics(getDataBody(err), data.topic);
  if (message === err.message && !label && !masked) return err;
  // The spread keeps the marker that holds `body` and `responseBody` off the wire.
  return new McpError(err.code, message, { ...err.data, ...label, ...masked });
}

/**
 * `body`, under both keys `httpErrorFromResponse` captures it as, with each
 * name in `topic` replaced by {@link TOPIC_MASK} — one name at a time, so a
 * poll's list is masked in the percent-encoded form its path carries
 * (`a%2Cb`) as well as the plain one. `undefined` when the body names none.
 */
function maskTopics(
  body: string,
  topic: string,
): { body: string; responseBody: string } | undefined {
  const masked = topic.split(',').reduce((text, name) => text.replaceAll(name, TOPIC_MASK), body);
  return masked === body ? undefined : { body: masked, responseBody: masked };
}

/**
 * A publish ntfy stores as a file: `filename` names it and no `attach` points
 * at one hosted elsewhere, so ntfy writes the message body to its attachment
 * store under that name. The publish tool sends neither field blank.
 */
function storesBodyAsFile(body: NtfyPublishRequest): boolean {
  return body.filename !== undefined && body.attach === undefined;
}

/**
 * ntfy's own 500 `50001` to a publish it stores as a file. ntfy v2.20.0 and
 * later fail that write for every JSON publish — the attachment store is handed
 * the `message` text but told the whole JSON request's length — so every
 * attempt gets the same answer and none stores anything. Marked
 * `retryable: false`, which `withRetry` fails on the first attempt instead of
 * re-sending a publish that cannot succeed, and labelled with the publish
 * contract's `invalid_attachment`.
 */
function fileStoreFailure(err: McpError): McpError {
  return new McpError(err.code, err.message, {
    ...err.data,
    reason: 'invalid_attachment',
    retryable: false,
  });
}

/**
 * Recognize the rejection `fetch` raises when `redirect: 'error'` is set and
 * the upstream answers with a 3xx. The wording differs by runtime (undici
 * nests `unexpected redirect` under `cause`; Bun's message is its code,
 * `UnexpectedRedirect`), so the whole cause chain is scanned for the one word
 * both share. A miss only costs the clearer message — the redirect is refused
 * either way. Applied only to a rejection of `fetch` itself, never to an error
 * raised reading ntfy's answer, and only once {@link withoutRequestUrl} has
 * taken the request URL out of it, so only the runtime's own wording is read.
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
      const base = withoutTrailingSlashes(entry.baseUrl);
      this.registeredBases.add(base);
      const header = buildAuthHeader(entry);
      if (header) this.authByBase.set(base, header);
    }
    const first = cfg.servers[0];
    if (!first) throw new Error('ServerConfig.servers must contain at least one entry.');
    this.defaultBase = withoutTrailingSlashes(first.baseUrl);
  }

  /** Visible for tests / resources that need to render canonical topic URLs. */
  get baseUrl(): string {
    return this.defaultBase;
  }

  /**
   * Resolve the base URL for one call and decide what the transport may do
   * with it. A caller-supplied override is validated here — the choke point
   * every service call shares — by the full guard: parse, scheme, and
   * credentials (`assertAbsoluteHttpUrl`), then the opt-in public-address check.
   * The tools run the synchronous part earlier too, in `normalizeBaseOverride`
   * above their consent gate, so a refused value never reaches a prompt.
   * Configured bases are the operator's own choice, validated at config load
   * (credentials included), so they skip it.
   */
  private async resolveBase(override?: string, signal?: AbortSignal): Promise<ResolvedBase> {
    if (override === undefined) {
      return {
        base: this.defaultBase,
        authHeader: this.authByBase.get(this.defaultBase),
        redirect: undefined,
      };
    }

    const base = withoutTrailingSlashes(override);
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
   * the published values plus the server-assigned `id`/`time`/`expires`,
   * beside the quota the same response reported. A `200` whose body is not
   * that envelope, or cannot be read in full, fails without a resend — see
   * `parseReply` — and so does ntfy's 500 to a publish it stores as a file —
   * see `fileStoreFailure`.
   */
  async publish(
    body: NtfyPublishRequest,
    opts: NtfyCallOptions = {},
  ): Promise<NtfyReply<NtfyPublishResponse>> {
    const { base, authHeader, redirect } = await this.resolveBase(opts.baseUrl, opts.signal);
    const url = `${base}/`;
    const { host } = new URL(url);

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
              const err = await ntfyHttpError(response, host, {
                operation: 'publish',
                topic: body.topic,
              });
              throw storesBodyAsFile(body) && isNtfyInternalError(err)
                ? fileStoreFailure(err)
                : err;
            }
            return await parseReply<NtfyPublishResponse>(response, 'publish');
          },
        ),
      'ntfy publish',
      opts.signal,
    );
  }

  /**
   * `PUT /<topic>/<id>/clear` or `DELETE /<topic>/<id>`. Returns the event
   * envelope subscribers see, beside the quota the same response reported; a
   * `200` whose body is not that envelope, with the `sequence_id` it
   * references, or cannot be read in full, fails without a resend — see
   * `parseReply`.
   */
  async manage(
    topic: string,
    sequenceId: string,
    operation: ManageOperation,
    opts: NtfyCallOptions = {},
  ): Promise<NtfyReply<NtfyManageResponse>> {
    const { base, authHeader, redirect } = await this.resolveBase(opts.baseUrl, opts.signal);
    const path =
      operation === 'clear'
        ? `${base}/${encodeURIComponent(topic)}/${encodeURIComponent(sequenceId)}/clear`
        : `${base}/${encodeURIComponent(topic)}/${encodeURIComponent(sequenceId)}`;
    const { host } = new URL(path);

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
              throw await ntfyHttpError(response, host, { operation, topic, sequenceId });
            }
            return await parseReply<NtfyManageResponse>(response, operation, ['sequence_id']);
          },
        ),
      `ntfy ${operation}`,
      opts.signal,
    );
  }

  /**
   * `GET /<topic>/json?poll=1&...`. Parses the NDJSON line-delimited stream
   * into an array, alongside ntfy's `X-Messages-Truncated` replay-cap flag and
   * its clock from the `Date` header;
   * `open` and `keepalive` frames are filtered out by the caller (they're
   * connection-level, not notification data). A body that is not that stream
   * fails inside the retried round trip — see `parsePollBody`.
   */
  async fetch(params: NtfyFetchParams, opts: NtfyCallOptions = {}): Promise<NtfyFetchResult> {
    const { base, authHeader, redirect } = await this.resolveBase(opts.baseUrl, opts.signal);
    const url = subscribeUrl(base, params, true);
    const { host } = new URL(url);
    const errorData: UpstreamErrorData = { operation: 'fetch', topic: params.topic };

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
            if (!response.ok) throw await ntfyHttpError(response, host, errorData);
            const messages = await parsePollBody(
              await response.text(),
              response.headers.get('content-type'),
              host,
              errorData,
            );
            return {
              messages,
              upstreamTruncated: response.headers.get('x-messages-truncated') === '1',
              ntfyClockSeconds: httpDateSeconds(response.headers.get('date')),
            };
          },
        ),
      'ntfy poll',
      opts.signal,
    );
  }

  /**
   * Hold ntfy's JSON stream — `GET /<topic>/json` with the query a poll sends,
   * minus `poll` — open for up to `holdMs` from the call, and return the first
   * row it delivers: one its `since` replays, or one published while it is
   * open, clear and delete events included. ntfy filters the stream as it
   * filters a poll, so a row the filters reject never arrives. A row from
   * before `windowStart`, which ntfy re-sends to a stream that subscribed just
   * after the row went out, is skipped, and the wait goes on.
   *
   * One attempt, never retried: a refused stream does not clear within a wait,
   * and a retry would spend it. Headers and ntfy's `open` line must arrive
   * within `NTFY_REQUEST_TIMEOUT_MS` of the call (or `holdMs`, when shorter),
   * the `base_url` lookup included. Whatever refuses or breaks the stream comes
   * back as `failed`, with a cause that never holds the request URL — its path
   * is the topic list. Only the caller's cancellation throws, as
   * `RequestCancelled`.
   *
   * Every path aborts the stream's request before it settles, which frees the
   * ntfy subscription slot it held, and gives back one of this process's
   * {@link MAX_OPEN_WAITS} wait slots; a call that finds none free returns
   * `busy` without a request.
   */
  async waitForMessage(params: NtfyFetchParams, opts: NtfyWaitOptions): Promise<NtfyWaitResult> {
    if (openWaits >= MAX_OPEN_WAITS) return { outcome: 'busy' };
    openWaits += 1;
    const startedAt = Date.now();
    const elapsed = () => Date.now() - startedAt;
    // Aborted when ntfy is too slow to confirm the stream, and at the end of every path.
    const stop = new AbortController();
    const signal = opts.signal ? AbortSignal.any([opts.signal, stop.signal]) : stop.signal;
    let unconfirmed = false;
    const openTimer = setTimeout(
      () => {
        unconfirmed = true;
        stop.abort();
      },
      Math.min(this.cfg.requestTimeoutMs, opts.holdMs),
    );
    /** When ntfy's `open` line arrived, on this server's clock, and the second it names. */
    const opened: { at?: number; ntfyTime?: number } = {};
    try {
      const { base, authHeader, redirect } = await untilCancelled(
        this.resolveBase(opts.baseUrl, opts.signal),
        stop.signal,
      );
      const url = subscribeUrl(base, params, false);
      const { host } = new URL(url);
      const errorData: UpstreamErrorData = { operation: 'wait', topic: params.topic };
      // `timedFetch`'s own timer is the hold: it ends the wait at `holdMs` from the call.
      return await timedFetch(
        url,
        {
          method: 'GET',
          headers: this.buildHeaders(authHeader),
          ...(redirect ? { redirect } : {}),
        },
        Math.max(0, opts.holdMs - elapsed()),
        signal,
        async (response): Promise<NtfyWaitResult> => {
          if (!response.ok) {
            const refused = await ntfyHttpError(response, host, errorData);
            return { outcome: 'failed', cause: refused.message.replace(/\.$/, ''), waitedMs: 0 };
          }
          const read = await firstStreamRow(
            response,
            host,
            errorData,
            opts.windowStart,
            (ntfyTime) => {
              clearTimeout(openTimer);
              opened.at = Date.now();
              opened.ntfyTime = ntfyTime;
            },
          );
          if ('problem' in read) {
            return {
              outcome: 'failed',
              cause: read.problem,
              waitedMs: opened.at === undefined ? 0 : elapsed(),
            };
          }
          const now = Date.now();
          return {
            outcome: 'arrived',
            message: read.row,
            ntfyClockSeconds:
              opened.at === undefined || opened.ntfyTime === undefined
                ? now / 1000
                : opened.ntfyTime + 1 + (now - opened.at) / 1000,
            waitedMs: now - startedAt,
          };
        },
      );
    } catch (err) {
      if (opts.signal?.aborted) {
        throw requestCancelled('The ntfy request was cancelled by the caller.', undefined, {
          cause: err,
        });
      }
      // The open timer runs to the shorter clock: past the request timeout it is ntfy's
      // silence; past the hold, the wait simply ended.
      if (unconfirmed && opts.holdMs > this.cfg.requestTimeoutMs) {
        return {
          outcome: 'failed',
          cause: `ntfy did not confirm the stream within the ${this.cfg.requestTimeoutMs} ms request timeout (NTFY_REQUEST_TIMEOUT_MS)`,
          waitedMs: 0,
        };
      }
      if (unconfirmed || err instanceof AttemptTimeout || elapsed() >= opts.holdMs) {
        return { outcome: 'timedOut', waitedMs: elapsed() };
      }
      return {
        outcome: 'failed',
        cause: readFailureCause(err),
        waitedMs: opened.at === undefined ? 0 : elapsed(),
      };
    } finally {
      clearTimeout(openTimer);
      stop.abort();
      openWaits -= 1;
    }
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
 * fast on a long `Retry-After` stays as it was — nothing was retried, so
 * nothing claims it was; `isUpstreamUnreachable` reads its `retryAfter`.
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
 * poll body or reply. The same holds when the deadline fires while a publish
 * or clear/delete `200` is still being read: `parseReply` has already turned
 * that read into the `upstream_malformed` answer. Report the answer, marked
 * exhausted the way running out of attempts marks it, so it classifies as what
 * ntfy said (`rate_limited`, `upstream_malformed`) rather than as an
 * unreachable server. A deadline that fired before any answer has none to
 * report and stays the framework's `Timeout`
 * (`data.reason: 'retry_deadline_exceeded'`).
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
 * Read and parse the `200` reply to a publish or a clear/delete: one message
 * envelope, plus each of `fields` as a string, returned beside the quota
 * ntfy's rate-limit headers on that same response report — so after a retried
 * 429 the quota is the successful response's. Anything else — an empty body,
 * an HTML page, JSON without the envelope fields, or a body that fails partway
 * through being read (a reset connection, the per-attempt timeout, the call
 * deadline) — fails as `ServiceUnavailable` with the reason a damaged poll
 * body takes, `upstream_malformed`, but marked `retryable: false`: ntfy writes
 * the `200` only after it has dispatched the message or event, so it may
 * already be out, and a resend would deliver it twice. `withRetry` fails that
 * flag on the first attempt instead of re-sending the request; a deadline that
 * cut the read off is reported as this answer by `lastAnswerOnDeadline`, and a
 * caller abort still surfaces as `RequestCancelled` through `NtfyService.run`.
 */
async function parseReply<T>(
  response: Response,
  operation: string,
  fields: readonly string[] = [],
): Promise<NtfyReply<T>> {
  const failed = (problem: string, cause?: unknown) =>
    serviceUnavailable(
      `The ${operation} was answered with HTTP ${response.status}, but ${problem}.`,
      { reason: 'upstream_malformed', retryable: false },
      cause === undefined ? undefined : { cause },
    );
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw failed(`reading the reply failed: ${readFailureCause(err)}`, err);
  }
  const contentType = response.headers.get('content-type');
  const malformed = (problem: string) =>
    failed(`the reply${contentType ? ` (content-type ${contentType})` : ''} ${problem}`);
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
  return { envelope: parsed as T, quota: parseQuota(response.headers) };
}

/**
 * What cut a reply read short, for the error message: the per-attempt timer by
 * its setting, the call deadline by `withRetry`'s own wording, and a transport
 * failure by the runtime's error plus the cause it nests — Node's undici says
 * only `terminated` and keeps the reason (`other side closed`) on `cause`. Bun's
 * advice to pass `verbose: true` to `fetch()` is dropped: the caller reading this
 * cannot act on it.
 */
function readFailureCause(err: unknown): string {
  if (err instanceof AttemptTimeout) {
    return `it did not finish within the ${err.timeoutMs} ms request timeout (NTFY_REQUEST_TIMEOUT_MS)`;
  }
  if (!(err instanceof Error)) return String(err);
  const nested = err.cause instanceof Error ? ` (${err.cause.message})` : '';
  const message = err.message.replace(/\s*For more information, pass `verbose: true`.*$/s, '');
  return `${message.replace(/\.$/, '')}${nested}`;
}

/** An HTTP `Date` header value as Unix seconds; `undefined` when absent or unparseable. */
function httpDateSeconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms / 1000;
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
 * error it describes, through the same mapping a non-OK response from `host`
 * takes.
 */
async function parsePollBody(
  text: string,
  contentType: string | null,
  host: string,
  errorData: UpstreamErrorData,
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
      throw await ntfyHttpError(new Response(line, { status: parsed.http }), host, errorData);
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

/**
 * The `<topic>/json` subscribe URL for `params`: with `poll=1` for a poll, and
 * without it for the stream a wait holds open, so the stream reads the same
 * window, through the same filters, as the poll before it.
 */
function subscribeUrl(base: string, params: NtfyFetchParams, poll: boolean): string {
  const search = new URLSearchParams(poll ? { poll: '1' } : undefined);
  if (params.since) search.set('since', params.since);
  if (params.scheduled) search.set('scheduled', '1');
  if (params.priority?.length) search.set('priority', params.priority.join(','));
  if (params.tags?.length) search.set('tags', params.tags.join(','));
  if (params.id) search.set('id', params.id);
  if (params.title) search.set('title', params.title);
  if (params.message) search.set('message', params.message);
  return `${base}/${encodeURIComponent(params.topic)}/json?${search.toString()}`;
}

/**
 * Most waits this server process holds open at once. ntfy gives each visitor —
 * an IP address, or an account on a plan tier — 30 open subscriptions by
 * default, shared by every client behind that address, and each stream a wait
 * holds takes one, as does each poll while it runs. Past this cap a wait is
 * refused here, which leaves the rest for polls.
 */
export const MAX_OPEN_WAITS = 10;

/** Waits holding an ntfy stream open in this process, from before the request until it is aborted. */
let openWaits = 0;

/** How many waits hold an ntfy stream open in this process right now. */
export function openWaitCount(): number {
  return openWaits;
}

/** What a wait's stream delivered first: a row, or what refused or broke the stream. */
type StreamRead = { row: NtfyMessage } | { problem: string };

/**
 * Longest line a wait's stream reader holds while it waits for the line's
 * break. ntfy's own lines run to a few kilobytes; past this the stream is not
 * ntfy's, and a per-call `base_url` can name any host.
 */
const MAX_STREAM_LINE_CHARS = 1_048_576;

/**
 * Whether `row` lies before the window `start` opens: the marker message
 * itself, which ntfy's window for an ID leaves out, or a row timed before the
 * start second, which a Unix-seconds window (`time >= since`) leaves out.
 * ntfy's ID window also leaves out a message written before the marker and
 * timed in an earlier second, but nothing on the stream orders a row against a
 * marker it has not delivered.
 */
function beforeWindow(row: NtfyMessage, start: WindowStart | undefined): boolean {
  if (start === undefined) return false;
  return start.kind === 'id' ? row.id === start.id : row.time < start.seconds;
}

/**
 * Read ntfy's JSON stream until it delivers a row — any envelope but `open`,
 * `keepalive`, and a row before `windowStart` — handing each `open` line's
 * `time` to `onOpen`. A line that is not JSON or not an ntfy message, a line
 * longer than {@link MAX_STREAM_LINE_CHARS}, ntfy's error envelope written as a
 * line, and the stream closing each end the read with a `problem`; a read the
 * request signal aborts rejects.
 *
 * Each read is scanned once for line breaks and the pieces of an unfinished
 * line are kept apart until its break arrives, so a long line assembled from
 * many reads costs time linear in its length. Their length is counted as they
 * arrive, so the bound ends the read as soon as the line in progress passes it.
 */
async function firstStreamRow(
  response: Response,
  host: string,
  errorData: UpstreamErrorData,
  windowStart: WindowStart | undefined,
  onOpen: (ntfyTime: number) => void,
): Promise<StreamRead> {
  const contentType = response.headers.get('content-type');
  const notStream = (line: number, problem: string): StreamRead => ({
    problem: `the stream is not ntfy's JSON message stream${contentType ? ` (content-type ${contentType})` : ''}: line ${line} ${problem}`,
  });
  const closed: StreamRead = { problem: 'the stream closed before any message arrived' };
  if (!response.body) return closed;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const tooLong = (line: number) =>
    notStream(line, `is longer than ${MAX_STREAM_LINE_CHARS} characters`);
  /** The line in progress, in the pieces it arrived in; none holds a line break. */
  const partial: string[] = [];
  /** Characters across `partial`. */
  let partialChars = 0;
  let lineNumber = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return closed;
      const text = decoder.decode(value, { stream: true });
      let start = 0;
      for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
        lineNumber += 1;
        if (partialChars + end - start > MAX_STREAM_LINE_CHARS) return tooLong(lineNumber);
        partial.push(text.slice(start, end));
        const line = partial.join('').trim();
        partial.length = 0;
        partialChars = 0;
        start = end + 1;
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return notStream(lineNumber, 'is not valid JSON');
        }
        if (isErrorEnvelope(parsed)) {
          const err = await ntfyHttpError(
            new Response(line, { status: parsed.http }),
            host,
            errorData,
          );
          return { problem: err.message.replace(/\.$/, '') };
        }
        if (!isMessageEnvelope(parsed)) {
          return notStream(lineNumber, `is not an ntfy message (${ENVELOPE_FIELDS})`);
        }
        if (parsed.event === 'open') onOpen(parsed.time);
        else if (parsed.event !== 'keepalive' && !beforeWindow(parsed, windowStart)) {
          return { row: parsed };
        }
      }
      if (start < text.length) {
        partial.push(text.slice(start));
        partialChars += text.length - start;
        if (partialChars > MAX_STREAM_LINE_CHARS) return tooLong(lineNumber + 1);
      }
    }
  } finally {
    reader.releaseLock();
  }
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
