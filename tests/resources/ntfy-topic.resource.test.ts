/**
 * @fileoverview Tests for the `ntfy://{topic}` resource — fixed snapshot
 * window, open/keepalive filtering, forbidden-topic mapping (only on ntfy's own
 * 401/403 envelope; a proxy's HTML 403 stays unlabelled), the topic quoted as
 * plain text in the fallback message, generic-error rethrow, the newest-20
 * truncation cap, message normalization (ISO 8601
 * timestamps, body truncation, sparse payloads), the snapshot envelope
 * shape (baseUrl, since, count, truncated, upstreamTruncated), and — through
 * the real service — a damaged poll body failing the read as
 * `upstream_malformed`, a 429 (status line or mid-replay error line) failing it
 * as `rate_limited`, a refused connection, an exhausted 5xx, or a call deadline
 * failing it as `upstream_unreachable` (so does a 503 whose `Retry-After`
 * outlasts the call, carrying the wait), a cancelled read left unlabelled, and
 * each declared reason's recovery hint as a client reads
 * it through the server factory. Retry ladders and the deadline run on a fake clock.
 * @module tests/resources/ntfy-topic.resource
 */

import { forbidden, JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetServerConfig } from '@/config/server-config.js';
import { ntfyTopicResource } from '@/mcp-server/resources/definitions/ntfy-topic.resource.js';
import {
  CALL_DEADLINE_MS,
  initNtfyService,
  type NtfyService,
  resetNtfyService,
} from '@/services/ntfy/ntfy-service.js';
import type { NtfyMessage } from '@/services/ntfy/types.js';

const ENV_KEYS = [
  'NTFY_BASE_URL',
  'NTFY_DEFAULT_TOPIC',
  'NTFY_AUTH_TOKEN',
  'NTFY_AUTH_USERNAME',
  'NTFY_AUTH_PASSWORD',
  'NTFY_REQUEST_TIMEOUT_MS',
  'NTFY_MAX_RETRIES',
] as const;

function freshService() {
  return initNtfyService({
    servers: [{ baseUrl: 'https://ntfy.test' }],
    requestTimeoutMs: 1000,
    maxRetries: 0,
  } as never);
}

/** Stub one `NtfyService.fetch` result: the polled envelopes, and ntfy's replay-cap flag. */
function stubFetch(svc: NtfyService, messages: NtfyMessage[], upstreamTruncated = false) {
  return vi.spyOn(svc, 'fetch').mockResolvedValue({ messages, upstreamTruncated });
}

/** The MCP protocol revision a `resources/read` through the server factory is sent under. */
const PROTOCOL_REVISION = '2026-07-28';

/**
 * Settle `run()` on a fake clock advanced by `ms` — by default past one retry
 * backoff (500 ms base, ±25% jitter) — so a retried read never waits on the
 * real clock. `run()` must resolve, not reject: it is awaited after the advance.
 */
async function onFakeClock<T>(run: () => Promise<T>, ms = 1_000): Promise<T> {
  vi.useFakeTimers();
  try {
    const pending = run();
    await vi.advanceTimersByTimeAsync(ms);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

describe('ntfyTopicResource handler', () => {
  beforeEach(() => {
    resetServerConfig();
    resetNtfyService();
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.NTFY_BASE_URL = 'https://ntfy.test';
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    resetServerConfig();
    resetNtfyService();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('returns a snapshot envelope with the synthesized URL', async () => {
    const svc = freshService();
    stubFetch(svc, [
      { id: 'a', time: 1, event: 'open', topic: 'alerts' },
      { id: 'b', time: 2, event: 'message', topic: 'alerts', message: 'hi' },
    ]);
    const ctx = createMockContext({
      errors: ntfyTopicResource.errors,
      uri: new URL('ntfy://alerts'),
    });
    const result = (await ntfyTopicResource.handler({ topic: 'alerts' }, ctx)) as {
      topic: string;
      url: string;
      messages: unknown[];
      count: number;
    };
    expect(result.topic).toBe('alerts');
    expect(result.url).toBe('https://ntfy.test/alerts');
    expect(result.messages).toHaveLength(1);
    expect(result.count).toBe(1);
  });

  it('maps Forbidden upstream to a Forbidden McpError, carrying the upstream text', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'fetch').mockRejectedValue(
      forbidden('ntfy returned HTTP 403 Forbidden: reserved topic access denied', {
        status: 403,
        body: '{"code":40301,"http":403,"error":"reserved topic access denied"}',
      }),
    );
    const ctx = createMockContext({
      errors: ntfyTopicResource.errors,
      uri: new URL('ntfy://protected'),
    });
    await expect(ntfyTopicResource.handler({ topic: 'protected' }, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      message: expect.stringContaining('reserved topic access denied'),
      data: { reason: 'forbidden_topic' },
    });
  });

  it('names the topic in double quotes, as plain text, when ntfy gave no explanation', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'fetch').mockRejectedValue(
      forbidden('', { status: 403, body: '{"code":40301,"http":403,"error":"forbidden"}' }),
    );
    const ctx = createMockContext({
      errors: ntfyTopicResource.errors,
      uri: new URL('ntfy://_secret_'),
    });
    await expect(ntfyTopicResource.handler({ topic: '_secret_' }, ctx)).rejects.toMatchObject({
      message: 'Forbidden for topic "_secret_"',
      data: { reason: 'forbidden_topic' },
    });
  });

  it('rethrows non-auth upstream errors so the framework auto-classifier handles them', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'fetch').mockRejectedValue(notFound('topic vanished'));
    const ctx = createMockContext({
      errors: ntfyTopicResource.errors,
      uri: new URL('ntfy://gone'),
    });
    await expect(ntfyTopicResource.handler({ topic: 'gone' }, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('echoes baseUrl and the fixed `since` window in the snapshot envelope', async () => {
    const svc = freshService();
    stubFetch(svc, []);
    const ctx = createMockContext({
      errors: ntfyTopicResource.errors,
      uri: new URL('ntfy://alerts'),
    });
    const result = (await ntfyTopicResource.handler({ topic: 'alerts' }, ctx)) as {
      baseUrl: string;
      since: string;
      count: number;
      truncated: boolean;
    };
    expect(result.baseUrl).toBe('https://ntfy.test');
    expect(result.since).toBe('1h');
    expect(result.count).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('keeps the newest 20 messages, oldest-first, and flags `truncated: true`', async () => {
    const svc = freshService();
    // ntfy returns the cache oldest-first, so m_24 is the most recent.
    const upstream: NtfyMessage[] = Array.from({ length: 25 }, (_, i) => ({
      id: `m_${i}`,
      time: 1700000000 + i,
      event: 'message' as const,
      topic: 'alerts',
      message: `body ${i}`,
    }));
    stubFetch(svc, upstream);
    const ctx = createMockContext({
      errors: ntfyTopicResource.errors,
      uri: new URL('ntfy://alerts'),
    });
    const result = (await ntfyTopicResource.handler({ topic: 'alerts' }, ctx)) as {
      messages: Array<{ id: string }>;
      count: number;
      truncated: boolean;
    };
    expect(result.messages).toHaveLength(20);
    expect(result.count).toBe(20);
    expect(result.truncated).toBe(true);
    // The resource advertises the *latest* 20 — the oldest five are dropped and
    // the kept window stays in chronological order.
    expect(result.messages.map((m) => m.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `m_${i + 5}`),
    );
  });

  it('normalizes `time` and `expires` to ISO 8601 strings', async () => {
    const svc = freshService();
    stubFetch(svc, [
      {
        id: '3sZEC2WVcTLg',
        time: 1779777011,
        expires: 1779820211,
        event: 'message',
        topic: 'alerts',
        message: 'hi',
      },
    ]);
    const ctx = createMockContext({
      errors: ntfyTopicResource.errors,
      uri: new URL('ntfy://alerts'),
    });
    const result = (await ntfyTopicResource.handler({ topic: 'alerts' }, ctx)) as {
      messages: Array<{ expires?: string; time: string }>;
    };
    expect(result.messages[0]?.time).toBe('2026-05-26T06:30:11.000Z');
    expect(result.messages[0]?.expires).toBe('2026-05-26T18:30:11.000Z');
  });

  it('truncates long message bodies and reports the dropped count', async () => {
    const svc = freshService();
    stubFetch(svc, [
      { id: 'm', time: 1, event: 'message', topic: 'alerts', message: 'a'.repeat(700) },
    ]);
    const ctx = createMockContext({
      errors: ntfyTopicResource.errors,
      uri: new URL('ntfy://alerts'),
    });
    const result = (await ntfyTopicResource.handler({ topic: 'alerts' }, ctx)) as {
      messages: Array<{ message?: string; messageTruncated?: number }>;
    };
    expect(result.messages[0]?.message).toHaveLength(500);
    expect(result.messages[0]?.messageTruncated).toBe(200);
  });

  it('leaves omitted upstream fields undefined (sparse payload)', async () => {
    const svc = freshService();
    stubFetch(svc, [
      { id: 'sparse', time: 1700000000, event: 'message', topic: 'alerts', message: 'minimal' },
    ]);
    const ctx = createMockContext({
      errors: ntfyTopicResource.errors,
      uri: new URL('ntfy://alerts'),
    });
    const result = (await ntfyTopicResource.handler({ topic: 'alerts' }, ctx)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(result.messages[0]).toMatchObject({
      id: 'sparse',
      message: 'minimal',
      expires: undefined,
      title: undefined,
      tags: undefined,
      priority: undefined,
      messageTruncated: undefined,
    });
  });

  describe('against a stubbed ntfy upstream', () => {
    const line = (id: string, time: number) =>
      JSON.stringify({ id, time, event: 'message', topic: 'alerts', message: `body ${id}` });

    /** Answers `ntfy.test` with `respond()`; any other host is an unmocked call and rejects. */
    function stubUpstream(respond: () => Response) {
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (new URL(url).hostname === 'ntfy.test') return respond();
        throw new Error(`Unmocked fetch: ${url}`);
      });
    }

    function poll(body: string, headers: Record<string, string> = {}): () => Response {
      return () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson; charset=utf-8', ...headers },
        });
    }

    it('fails the read on a damaged poll body instead of serving a short snapshot', async () => {
      freshService();
      stubUpstream(poll([line('a', 1), '{ this is not json', line('b', 2)].join('\n')));
      const ctx = createMockContext({
        errors: ntfyTopicResource.errors,
        uri: new URL('ntfy://alerts'),
      });
      await expect(ntfyTopicResource.handler({ topic: 'alerts' }, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_malformed' },
      });
    });

    it('fails the read on a 200 HTML page instead of serving `count: 0`', async () => {
      freshService();
      stubUpstream(
        () =>
          new Response('<html><body>Captive portal</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      );
      const ctx = createMockContext({
        errors: ntfyTopicResource.errors,
        uri: new URL('ntfy://alerts'),
      });
      await expect(ntfyTopicResource.handler({ topic: 'alerts' }, ctx)).rejects.toMatchObject({
        data: { reason: 'upstream_malformed' },
      });
    });

    it('fails a 429 that outlasts the retries with `rate_limited`', async () => {
      initNtfyService({
        servers: [{ baseUrl: 'https://ntfy.test' }],
        requestTimeoutMs: 1000,
        maxRetries: 1,
      } as never);
      const upstream = stubUpstream(
        () =>
          new Response('{"code":42901,"http":429,"error":"limit reached: too many requests"}', {
            status: 429,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const err = await onFakeClock(() => failedRead());
      expect(upstream).toHaveBeenCalledTimes(2);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { reason: 'rate_limited', retryable: true },
      });
      expect(err.message).toContain('limit reached: too many requests');
      expect(err.message).toContain('(failed after 2 attempts)');
    });

    it('fails a 429 error line written into a started replay with `rate_limited`', async () => {
      freshService();
      stubUpstream(
        poll(
          [
            line('a', 1),
            '{"code":42905,"http":429,"error":"limit reached: daily bandwidth reached"}',
          ].join('\n'),
        ),
      );
      const ctx = createMockContext({
        uri: new URL('ntfy://alerts'),
        errors: ntfyTopicResource.errors,
      });
      await expect(ntfyTopicResource.handler({ topic: 'alerts' }, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        message: expect.stringContaining('limit reached: daily bandwidth'),
        data: { reason: 'rate_limited' },
      });
    });

    /** Run one read and hand back what it threw. */
    async function failedRead(topic = 'alerts') {
      const ctx = createMockContext({
        uri: new URL(`ntfy://${topic}`),
        errors: ntfyTopicResource.errors,
      });
      return (await Promise.resolve(ntfyTopicResource.handler({ topic }, ctx)).catch(
        (e: unknown) => e,
      )) as { code?: unknown; message: string; data?: Record<string, unknown> };
    }

    it('fails a refused connection that outlasts the retries with `upstream_unreachable`', async () => {
      initNtfyService({
        servers: [{ baseUrl: 'https://ntfy.test' }],
        requestTimeoutMs: 1000,
        maxRetries: 1,
      } as never);
      const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (new URL(url).hostname !== 'ntfy.test') throw new Error(`Unmocked fetch: ${url}`);
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
            code: 'ECONNREFUSED',
          }),
        });
      });
      const err = await onFakeClock(() => failedRead());
      expect(upstream).toHaveBeenCalledTimes(2);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unreachable' },
      });
      expect(err.message).toContain('(failed after 2 attempts)');
    });

    it('fails a 5xx that outlasts the retries with `upstream_unreachable`', async () => {
      initNtfyService({
        servers: [{ baseUrl: 'https://ntfy.test' }],
        requestTimeoutMs: 1000,
        maxRetries: 1,
      } as never);
      const upstream = stubUpstream(
        () =>
          new Response('{"code":50001,"http":500,"error":"internal server error"}', {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const err = await onFakeClock(() => failedRead());
      expect(upstream).toHaveBeenCalledTimes(2);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unreachable' },
      });
      expect(err.message).toContain('(failed after 2 attempts)');
    });

    it('keeps a damaged poll body on `upstream_malformed` once retries run out', async () => {
      initNtfyService({
        servers: [{ baseUrl: 'https://ntfy.test' }],
        requestTimeoutMs: 1000,
        maxRetries: 1,
      } as never);
      const upstream = stubUpstream(poll('<html><body>Captive portal</body></html>'));
      const err = await onFakeClock(() => failedRead());
      // A retry-exhausted ServiceUnavailable, so the unreachable branch must not claim it.
      expect(upstream).toHaveBeenCalledTimes(2);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_malformed' },
      });
    });

    it('maps a read that ran out of its call deadline to `upstream_unreachable`', async () => {
      // A per-attempt timeout past the 50 s call deadline, so the deadline is the clock that fires.
      initNtfyService({
        servers: [{ baseUrl: 'https://ntfy.test' }],
        requestTimeoutMs: 120_000,
        maxRetries: 3,
      } as never);
      const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal as AbortSignal;
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      );
      const err = await onFakeClock(() => failedRead(), CALL_DEADLINE_MS);
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: 'ntfy poll exceeded its 50000ms retry deadline after 1 attempt.',
        data: { reason: 'upstream_unreachable' },
      });
    });

    it('leaves a read the caller cancelled mid-poll to the framework', async () => {
      freshService();
      const caller = new AbortController();
      const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
        const signal = init?.signal as AbortSignal;
        const pending = new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        caller.abort();
        return pending;
      });
      const ctx = createMockContext({
        uri: new URL('ntfy://alerts'),
        errors: ntfyTopicResource.errors,
        signal: caller.signal,
      });
      const err = (await Promise.resolve(ntfyTopicResource.handler({ topic: 'alerts' }, ctx)).catch(
        (e: unknown) => e,
      )) as { code?: unknown; data?: Record<string, unknown> };
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(err.data?.reason).toBeUndefined();
    });

    it('fails a 503 whose Retry-After outlasts the call with `upstream_unreachable`, unretried, naming the wait', async () => {
      // Retries allowed, so only the over-budget Retry-After keeps this to one attempt.
      initNtfyService({
        servers: [{ baseUrl: 'https://ntfy.test' }],
        requestTimeoutMs: 1000,
        maxRetries: 3,
      } as never);
      const upstream = stubUpstream(
        () =>
          new Response('{"code":50301,"http":503,"error":"service unavailable"}', {
            status: 503,
            headers: { 'content-type': 'application/json', 'retry-after': '3600' },
          }),
      );
      const err = await failedRead();
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.message).not.toMatch(/failed after/);
      expect(err.data).toMatchObject({
        reason: 'upstream_unreachable',
        retryAfter: '3600',
        recovery: {
          hint: 'The ntfy server answered but asked to wait (Retry-After: 3600); read the topic again once that wait has passed.',
        },
      });
      expect(err.data).not.toHaveProperty('retryAttempts');
    });

    it('carries the Retry-After of a 503 retried to exhaustion onto `upstream_unreachable`', async () => {
      initNtfyService({
        servers: [{ baseUrl: 'https://ntfy.test' }],
        requestTimeoutMs: 1000,
        maxRetries: 1,
      } as never);
      const upstream = stubUpstream(
        () =>
          new Response('{"code":50301,"http":503,"error":"service unavailable"}', {
            status: 503,
            headers: { 'content-type': 'application/json', 'retry-after': '1' },
          }),
      );
      const err = await onFakeClock(() => failedRead(), 2_000);
      expect(upstream).toHaveBeenCalledTimes(2);
      expect(err.message).toContain('(failed after 2 attempts)');
      expect(err.data).toMatchObject({ reason: 'upstream_unreachable', retryAfter: '1' });
      expect((err.data?.recovery as { hint?: string })?.hint).toContain('Retry-After: 1)');
    });

    /**
     * Read `ntfy://alerts` through the framework's resource factory — the path
     * that fills a declared reason's `recovery` in as `data.recovery.hint` — and
     * return the JSON-RPC error a client receives.
     */
    async function readThroughServer() {
      const meta = {
        'io.modelcontextprotocol/protocolVersion': PROTOCOL_REVISION,
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'ntfy-topic-test', version: '0.0.0' },
      };
      const server = createWorkerHandler({
        name: 'ntfy-mcp-server',
        title: 'ntfy-mcp-server',
        resources: [ntfyTopicResource],
      });
      const response = await server.fetch?.(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': PROTOCOL_REVISION,
            'mcp-method': 'resources/read',
            'mcp-name': 'ntfy://alerts',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'resources/read',
            params: { uri: 'ntfy://alerts', _meta: meta },
          }),
        }) as never,
        // Copied into `process.env.MCP_LOG_LEVEL`, which the caller stubs so it is restored.
        { LOG_LEVEL: 'error' } as never,
        { waitUntil() {}, passThroughOnException() {} } as never,
      );
      const body = (await response?.json()) as {
        error?: { code: number; data?: { reason?: string; recovery?: { hint?: string } } };
      };
      return body.error;
    }

    const refused = () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
          code: 'ECONNREFUSED',
        }),
      });
    };
    const ntfyError = (status: number, error: string) => () =>
      new Response(JSON.stringify({ code: status * 100 + 1, http: status, error }), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    it.each([
      [
        'forbidden_topic',
        JsonRpcErrorCode.Forbidden,
        ntfyError(403, 'forbidden'),
        'NTFY_AUTH_TOKEN',
      ],
      [
        'rate_limited',
        JsonRpcErrorCode.RateLimited,
        ntfyError(429, 'limit reached: too many requests'),
        'rate-limit window',
      ],
      ['upstream_unreachable', JsonRpcErrorCode.ServiceUnavailable, refused, 'NTFY_BASE_URL'],
      [
        'upstream_malformed',
        JsonRpcErrorCode.ServiceUnavailable,
        poll('<html><body>Captive portal</body></html>'),
        'NTFY_BASE_URL',
      ],
    ])(
      'hands a reader the declared `%s` recovery hint, never one naming `base_url`',
      async (reason, code, respond, hint) => {
        freshService();
        vi.stubEnv('MCP_LOG_LEVEL', 'error');
        stubUpstream(respond);
        const error = await readThroughServer();
        expect(error).toMatchObject({ code, data: { reason } });
        expect(error?.data?.recovery?.hint).toContain(hint);
        // A resource read takes no `base_url`, so no hint may offer one.
        expect(error?.data?.recovery?.hint).not.toContain('base_url');
      },
    );

    it.each([
      ["ntfy's 401 envelope", ntfyError(401, 'unauthorized'), 'forbidden_topic'],
      [
        "a proxy's HTML 403",
        () =>
          new Response('<html><head><title>403 Forbidden</title></head></html>', {
            status: 403,
            headers: { 'content-type': 'text/html' },
          }),
        undefined,
      ],
    ])(
      'labels %s as a client reads it through the server (#45)',
      async (_label, respond, reason) => {
        freshService();
        vi.stubEnv('MCP_LOG_LEVEL', 'error');
        stubUpstream(respond);
        const error = await readThroughServer();
        // `forbidden_topic` carries its declared `Forbidden`; the HTML 403 keeps the status-mapped one.
        expect(error?.code).toBe(JsonRpcErrorCode.Forbidden);
        expect(error?.data?.reason).toBe(reason);
        if (reason === undefined) expect(error?.data?.recovery).toBeUndefined();
      },
    );

    it("flags ntfy's replay cap in the payload", async () => {
      freshService();
      stubUpstream(poll([line('a', 1), line('b', 2)].join('\n'), { 'x-messages-truncated': '1' }));
      const ctx = createMockContext({
        errors: ntfyTopicResource.errors,
        uri: new URL('ntfy://alerts'),
      });
      const result = (await ntfyTopicResource.handler({ topic: 'alerts' }, ctx)) as {
        count: number;
        truncated: boolean;
        upstreamTruncated: boolean;
      };
      expect(result).toMatchObject({ count: 2, truncated: false, upstreamTruncated: true });
    });

    it('reports no replay cap when ntfy sends no header', async () => {
      freshService();
      stubUpstream(poll(line('a', 1)));
      const ctx = createMockContext({
        errors: ntfyTopicResource.errors,
        uri: new URL('ntfy://alerts'),
      });
      const result = (await ntfyTopicResource.handler({ topic: 'alerts' }, ctx)) as {
        upstreamTruncated: boolean;
      };
      expect(result.upstreamTruncated).toBe(false);
    });

    it('sets `markdown: true` only on messages ntfy tagged `text/markdown` (#28)', async () => {
      freshService();
      stubUpstream(
        poll(
          [
            JSON.stringify({
              id: 'a',
              time: 1,
              event: 'message',
              topic: 'alerts',
              message: '**bold**',
              content_type: 'text/markdown',
            }),
            line('b', 2),
          ].join('\n'),
        ),
      );
      const ctx = createMockContext({
        errors: ntfyTopicResource.errors,
        uri: new URL('ntfy://alerts'),
      });
      const result = await ntfyTopicResource.handler({ topic: 'alerts' }, ctx);
      const { messages } = JSON.parse(JSON.stringify(result)) as {
        messages: Array<Record<string, unknown>>;
      };
      expect(messages[0]).toMatchObject({ message: '**bold**', markdown: true });
      expect(messages[0]).not.toHaveProperty('content_type');
      expect(messages[1]).not.toHaveProperty('markdown');
    });
  });

  it('drops keepalive frames alongside open frames', async () => {
    const svc = freshService();
    stubFetch(svc, [
      { id: 'a', time: 1, event: 'open', topic: 'alerts' },
      { id: 'b', time: 2, event: 'keepalive', topic: 'alerts' },
      { id: 'c', time: 3, event: 'message', topic: 'alerts', message: 'real' },
    ]);
    const ctx = createMockContext({
      errors: ntfyTopicResource.errors,
      uri: new URL('ntfy://alerts'),
    });
    const result = (await ntfyTopicResource.handler({ topic: 'alerts' }, ctx)) as {
      messages: Array<{ id: string }>;
    };
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.id).toBe('c');
  });
});
