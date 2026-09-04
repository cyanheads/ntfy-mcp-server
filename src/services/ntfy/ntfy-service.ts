/**
 * @fileoverview HTTP client for the ntfy publish/subscribe API. Wraps
 * `fetchWithTimeout` + `withRetry` so the publish, manage, and fetch calls
 * share one transient-failure boundary. Auth headers are scoped to specific
 * registered base URLs — per-call `baseUrl` overrides that match a registered
 * base forward that base's credentials, anything else goes out unauthenticated
 * to avoid leaking credentials to arbitrary hosts the agent picks.
 *
 * Overrides are also validated before they are dereferenced: absolute
 * `http(s)` form always, plus a public-address requirement and a redirect block
 * when `NTFY_BLOCK_PRIVATE_HOSTS` is on — see `base-url-guard.ts`.
 * @module services/ntfy/ntfy-service
 */

import { McpError, requestCancelled, validationError } from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';

import type { NtfyServerEntry, ServerConfig } from '@/config/server-config.js';
import { assertAbsoluteHttpUrl, assertPublicHost, REJECTION_MARKER } from './base-url-guard.js';
import { getDataBody, upstreamErrorDetail } from './error-classifier.js';
import type {
  ManageOperation,
  NtfyCallOptions,
  NtfyFetchParams,
  NtfyManageResponse,
  NtfyMessage,
  NtfyPublishRequest,
  NtfyPublishResponse,
} from './types.js';

/**
 * Raw `fetch` with a timeout AbortController. Bypasses the framework's
 * `fetchWithTimeout` because that helper throws `ServiceUnavailable` on every
 * non-ok response, which would erase the upstream's actual status code from
 * `httpErrorFromResponse` — and we need that for the error contract mapping
 * (`forbidden_topic` ← 403, `not_found` ← 404, `invalid_since` ← 400, etc.).
 *
 * One controller serves two unrelated aborts, so the cause is tracked rather
 * than read back off the rejection: the request deadline expiring is a
 * `Timeout` the retry boundary should keep trying, while the caller's signal
 * firing means the MCP client is gone and nothing can be delivered to it. The
 * latter surfaces as `RequestCancelled`, which sits outside the transient set
 * and logs without a stack — matching what `fetchWithTimeout` does on its own
 * external-abort path.
 */
async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): Promise<Response> {
  let callerGone = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Timeout')), timeoutMs);
  const onAbort = () => {
    callerGone = true;
    controller.abort(externalSignal?.reason);
  };
  if (externalSignal) {
    if (externalSignal.aborted) onAbort();
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    // The caller abandoned the request. Say so with the code that means it, so
    // the failure is not counted as an ntfy outage and no attempt is spent
    // re-issuing a request nobody is waiting for.
    if (callerGone) {
      throw requestCancelled('The ntfy request was cancelled by the caller.', undefined, {
        cause: err,
      });
    }
    // A refused redirect is a deliberate block, not a transient network fault:
    // name it, and give it a non-retryable code so the retry boundary above
    // doesn't burn three attempts re-refusing the same hop.
    if (init.redirect === 'error' && isBlockedRedirect(err)) {
      throw validationError(
        `base_url redirected away from ${new URL(url).host}; redirects are not followed for unregistered base URLs while NTFY_BLOCK_PRIVATE_HOSTS is on.`,
        {
          ...REJECTION_MARKER,
          recovery: {
            hint: 'Pass the final ntfy server URL directly, or ask the operator to register it in `NTFY_SERVERS` / `NTFY_BASE_URL`.',
          },
        },
        { cause: err },
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
  }
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
 * the clearer message — the redirect is refused either way.
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
  private async resolveBase(override?: string): Promise<ResolvedBase> {
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
    await assertPublicHost(url);
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
   * the published values plus the server-assigned `id`/`time`/`expires`.
   */
  async publish(
    body: NtfyPublishRequest,
    opts: NtfyCallOptions = {},
  ): Promise<NtfyPublishResponse> {
    const { base, authHeader, redirect } = await this.resolveBase(opts.baseUrl);
    const url = `${base}/`;

    // `cache` / `firebase` are wire-level headers, not JSON body fields.
    const { cache, firebase, ...jsonBody } = body;
    const extraHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (cache === false) extraHeaders['X-Cache'] = 'no';
    if (firebase === false) extraHeaders['X-Firebase'] = 'no';

    return await this.run(
      async (signal) => {
        const response = await timedFetch(
          url,
          {
            method: 'POST',
            headers: this.buildHeaders(authHeader, extraHeaders),
            body: JSON.stringify(jsonBody),
            ...(redirect ? { redirect } : {}),
          },
          this.cfg.requestTimeoutMs,
          signal,
        );
        if (!response.ok) {
          throw await ntfyHttpError(response, { operation: 'publish', topic: body.topic });
        }
        return (await response.json()) as NtfyPublishResponse;
      },
      'NtfyService.publish',
      opts.signal,
    );
  }

  /**
   * `PUT /<topic>/<id>/clear` or `DELETE /<topic>/<id>`. Returns the event
   * envelope subscribers see.
   */
  async manage(
    topic: string,
    sequenceId: string,
    operation: ManageOperation,
    opts: NtfyCallOptions = {},
  ): Promise<NtfyManageResponse> {
    const { base, authHeader, redirect } = await this.resolveBase(opts.baseUrl);
    const path =
      operation === 'clear'
        ? `${base}/${encodeURIComponent(topic)}/${encodeURIComponent(sequenceId)}/clear`
        : `${base}/${encodeURIComponent(topic)}/${encodeURIComponent(sequenceId)}`;

    return await this.run(
      async (signal) => {
        const response = await timedFetch(
          path,
          {
            method: operation === 'clear' ? 'PUT' : 'DELETE',
            headers: this.buildHeaders(authHeader),
            ...(redirect ? { redirect } : {}),
          },
          this.cfg.requestTimeoutMs,
          signal,
        );
        if (!response.ok) {
          throw await ntfyHttpError(response, { operation, topic, sequenceId });
        }
        return (await response.json()) as NtfyManageResponse;
      },
      `NtfyService.${operation}`,
      opts.signal,
    );
  }

  /**
   * `GET /<topic>/json?poll=1&...`. Parses the NDJSON line-delimited stream
   * into an array; `open` and `keepalive` frames are filtered out by the
   * caller (they're connection-level, not notification data).
   */
  async fetch(params: NtfyFetchParams, opts: NtfyCallOptions = {}): Promise<NtfyMessage[]> {
    const { base, authHeader, redirect } = await this.resolveBase(opts.baseUrl);
    const search = new URLSearchParams({ poll: '1' });
    if (params.since) search.set('since', params.since);
    if (params.scheduled) search.set('scheduled', '1');
    if (params.priority?.length) search.set('priority', params.priority.join(','));
    if (params.tags?.length) search.set('tags', params.tags.join(','));
    if (params.id) search.set('id', params.id);
    if (params.title) search.set('title', params.title);
    if (params.message) search.set('message', params.message);

    const url = `${base}/${encodeURIComponent(params.topic)}/json?${search.toString()}`;

    return await this.run(
      async (signal) => {
        const response = await timedFetch(
          url,
          {
            method: 'GET',
            headers: this.buildHeaders(authHeader),
            ...(redirect ? { redirect } : {}),
          },
          this.cfg.requestTimeoutMs,
          signal,
        );
        if (!response.ok) {
          throw await ntfyHttpError(response, { operation: 'fetch', topic: params.topic });
        }
        const text = await response.text();
        return parseNdjson(text);
      },
      'NtfyService.fetch',
      opts.signal,
    );
  }

  private async run<T>(
    fn: (signal: AbortSignal | undefined) => Promise<T>,
    operation: string,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    return await withRetry(() => fn(externalSignal), {
      maxRetries: this.cfg.maxRetries,
      baseDelayMs: 500,
      operation,
      ...(externalSignal ? { signal: externalSignal } : {}),
    });
  }
}

function parseNdjson(text: string): NtfyMessage[] {
  const out: NtfyMessage[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as NtfyMessage);
    } catch {
      // Skip malformed line — ntfy will not normally emit one, but a partial
      // response shouldn't sink the whole call. The retry boundary handles
      // genuine network corruption upstream.
    }
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
