/**
 * @fileoverview HTTP client for the ntfy publish/subscribe API. Wraps
 * `fetchWithTimeout` + `withRetry` so the publish, manage, and fetch calls
 * share one transient-failure boundary. Auth headers are scoped to specific
 * registered base URLs — per-call `baseUrl` overrides that match a registered
 * base forward that base's credentials, anything else goes out unauthenticated
 * to avoid leaking credentials to arbitrary hosts the agent picks.
 * @module services/ntfy/ntfy-service
 */

import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';

import type { NtfyServerEntry, ServerConfig } from '@/config/server-config.js';
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
 */
async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Timeout')), timeoutMs);
  const onAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
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

export class NtfyService {
  private readonly authByBase: Map<string, string>;
  private readonly defaultBase: string;

  constructor(private readonly cfg: ServerConfig) {
    this.authByBase = new Map();
    for (const entry of cfg.servers) {
      const base = trimTrailingSlash(entry.baseUrl);
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

  private resolveBase(override?: string): {
    base: string;
    authHeader: string | undefined;
  } {
    const base = trimTrailingSlash(override ?? this.defaultBase);
    return { base, authHeader: this.authByBase.get(base) };
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
    const { base, authHeader } = this.resolveBase(opts.baseUrl);
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
          },
          this.cfg.requestTimeoutMs,
          signal,
        );
        if (!response.ok) {
          throw await httpErrorFromResponse(response, {
            service: 'ntfy',
            data: { operation: 'publish', topic: body.topic },
          });
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
    const { base, authHeader } = this.resolveBase(opts.baseUrl);
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
          },
          this.cfg.requestTimeoutMs,
          signal,
        );
        if (!response.ok) {
          throw await httpErrorFromResponse(response, {
            service: 'ntfy',
            data: { operation, topic, sequenceId },
          });
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
    const { base, authHeader } = this.resolveBase(opts.baseUrl);
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
          },
          this.cfg.requestTimeoutMs,
          signal,
        );
        if (!response.ok) {
          throw await httpErrorFromResponse(response, {
            service: 'ntfy',
            data: { operation: 'fetch', topic: params.topic },
          });
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
