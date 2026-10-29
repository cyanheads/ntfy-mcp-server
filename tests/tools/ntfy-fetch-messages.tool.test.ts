/**
 * @fileoverview Tests for `ntfy_fetch_messages` — open/keepalive filtering,
 * newest-first limit truncation, message-body truncation and the untruncated
 * single-message (`id`) path plus its empty-`id` fallback, the priority
 * schema's single-node validation,
 * sparse upstream payloads (per checklist), error mapping (forbidden /
 * invalid_since / rate_limited / upstream_unreachable / generic rethrow), ntfy
 * 400s that are not about `since` kept unlabeled, the 64-character per-topic
 * cap and the time its pattern takes on caller-sized text,
 * default-topic resolution, base_url override and its scheme validation,
 * enrichment (topic/since/count/truncated/filters/notice), format() rendering,
 * and — through the real service — `upstream_malformed`, a 429 on the status
 * line or as a mid-stream ntfy error line (`rate_limited`), and ntfy's
 * `upstreamTruncated` replay cap. Against a fake ntfy window: blank and
 * whitespace `since`/filter normalization as sent upstream, and `cursor`
 * paging — full-window walks, arrivals and expiry between pages, stale
 * cursors (`cursor_not_found`), boundaries, and the `totalCount` / `nextCursor`
 * enrichment and notice on both surfaces.
 * @module tests/tools/ntfy-fetch-messages.tool
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  forbidden,
  invalidParams,
  JsonRpcErrorCode,
  notFound,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetServerConfig } from '@/config/server-config.js';
import {
  isDuration,
  ntfyFetchMessages,
} from '@/mcp-server/tools/definitions/ntfy-fetch-messages.tool.js';
import {
  CALL_DEADLINE_MS,
  initNtfyService,
  type NtfyService,
  resetNtfyService,
} from '@/services/ntfy/ntfy-service.js';
import type { NtfyMessage } from '@/services/ntfy/types.js';
import { readCommonMark } from '../helpers/commonmark.js';

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

/** The empty-result notice's warning that ntfy may not return a just-published message yet. */
const JUST_PUBLISHED =
  'A message published in the last few seconds may not be returned yet, so retry shortly before concluding it is missing.';

/** Stub one `NtfyService.fetch` result: the polled envelopes, and ntfy's replay-cap flag. */
function stubFetch(svc: NtfyService, messages: NtfyMessage[], upstreamTruncated = false) {
  return vi.spyOn(svc, 'fetch').mockResolvedValue({ messages, upstreamTruncated });
}

/**
 * Settle `run()` on a fake clock advanced by `ms` — by default past one retry
 * backoff (500 ms base, ±25% jitter) — so a retried call never waits on the
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

describe('ntfyFetchMessages handler', () => {
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
  });

  it('drops `open` and `keepalive` frames and keeps the newest messages within `limit`', async () => {
    const svc = freshService();
    const upstream: NtfyMessage[] = [
      { id: 'a', time: 1, event: 'open', topic: 'alerts' },
      { id: 'b', time: 2, event: 'message', topic: 'alerts', message: 'first' },
      { id: 'c', time: 3, event: 'keepalive', topic: 'alerts' },
      { id: 'd', time: 4, event: 'message', topic: 'alerts', message: 'second' },
      { id: 'e', time: 5, event: 'message', topic: 'alerts', message: 'third' },
    ];
    stubFetch(svc, upstream);

    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts', limit: 2 });
    const result = await ntfyFetchMessages.handler(input, ctx);

    expect(result.messages).toHaveLength(2);
    expect(result.messages.map((m) => m.id)).toEqual(['d', 'e']);
    expect(getEnrichment(ctx)).toMatchObject({ count: 2, truncated: true });
  });

  it('keeps the newest `limit` of a larger window, still oldest-first, and says so in the notice', async () => {
    const svc = freshService();
    // ntfy hands back the cache oldest-first; ids ascend with time.
    const upstream: NtfyMessage[] = Array.from({ length: 24 }, (_, i) => ({
      id: `m${i + 1}`,
      time: i + 1,
      event: 'message' as const,
      topic: 'alerts',
      message: `body ${i + 1}`,
    }));
    stubFetch(svc, upstream);

    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts', since: '1h', limit: 3 });
    const result = await ntfyFetchMessages.handler(input, ctx);

    expect(result.messages.map((m) => m.id)).toEqual(['m22', 'm23', 'm24']);
    const e = getEnrichment(ctx);
    expect(e).toMatchObject({ count: 3, truncated: true });
    expect(e.notice).toContain('newest 3');
    expect(e.notice).toContain('24 messages matched');
  });

  it('serves a `limit` above the per-call cap as 100 and names the cap, rejecting only past the hard ceiling', async () => {
    const svc = freshService();
    const upstream: NtfyMessage[] = Array.from({ length: 150 }, (_, i) => ({
      id: `m${i + 1}`,
      time: i + 1,
      event: 'message' as const,
      topic: 'alerts',
      message: `body ${i + 1}`,
    }));
    stubFetch(svc, upstream);

    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts', since: '1h', limit: 500 });
    const result = await ntfyFetchMessages.handler(input, ctx);

    expect(result.messages).toHaveLength(100);
    expect(result.messages.at(-1)?.id).toBe('m150');
    const e = getEnrichment(ctx);
    expect(e).toMatchObject({ count: 100, truncated: true });
    expect(e.notice).toContain('at most 100');
    expect(e.notice).toContain('older 50');
    expect(ntfyFetchMessages.input.safeParse({ topic: 'alerts', limit: 1001 }).success).toBe(false);
  });

  it('returns every message when the window fits inside `limit`', async () => {
    const svc = freshService();
    stubFetch(svc, [
      { id: 'x', time: 1, event: 'message', topic: 'alerts', message: 'one' },
      { id: 'y', time: 2, event: 'message', topic: 'alerts', message: 'two' },
    ]);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts', limit: 5 });
    const result = await ntfyFetchMessages.handler(input, ctx);

    expect(result.messages.map((m) => m.id)).toEqual(['x', 'y']);
    expect(getEnrichment(ctx)).toMatchObject({ truncated: false });
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('truncates long message bodies to 500 chars and reports the dropped count', async () => {
    const svc = freshService();
    const longBody = 'a'.repeat(700);
    stubFetch(svc, [{ id: 'm', time: 1, event: 'message', topic: 'alerts', message: longBody }]);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts' });
    const result = await ntfyFetchMessages.handler(input, ctx);

    expect(result.messages[0]?.message).toHaveLength(500);
    expect(result.messages[0]?.messageTruncated).toBe(200);
  });

  it('returns the whole body, with no `messageTruncated`, when a single message is pinned by `id`', async () => {
    const svc = freshService();
    const longBody = 'b'.repeat(720);
    const fetch = stubFetch(svc, [
      { id: 'target', time: 1, event: 'message', topic: 'alerts', message: longBody },
    ]);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts', id: 'target' });
    const result = await ntfyFetchMessages.handler(input, ctx);

    expect(fetch.mock.calls[0]?.[0].id).toBe('target');
    expect(result.messages[0]?.message).toBe(longBody);
    expect(result.messages[0]?.message).toHaveLength(720);
    expect(result.messages[0]?.messageTruncated).toBeUndefined();
  });

  it('still truncates when `id` is absent, so list responses stay bounded', async () => {
    const svc = freshService();
    const longBody = 'c'.repeat(720);
    stubFetch(svc, [
      { id: 'listed', time: 1, event: 'message', topic: 'alerts', message: longBody },
    ]);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts' });
    const result = await ntfyFetchMessages.handler(input, ctx);

    expect(result.messages[0]?.message).toHaveLength(500);
    expect(result.messages[0]?.messageTruncated).toBe(220);
  });

  it('treats an empty `id` as no filter, so the list stays capped', async () => {
    const svc = freshService();
    const longBody = 'd'.repeat(720);
    const fetch = stubFetch(svc, [
      { id: 'first', time: 1, event: 'message', topic: 'alerts', message: longBody },
      { id: 'second', time: 2, event: 'message', topic: 'alerts', message: longBody },
    ]);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts', id: '' });
    const result = await ntfyFetchMessages.handler(input, ctx);

    // An empty `id` is resolved to no filter before the service call, so the response is a list.
    expect(fetch.mock.calls[0]?.[0].id).toBeUndefined();
    expect(result.messages).toHaveLength(2);
    for (const m of result.messages) {
      expect(m.message).toHaveLength(500);
      expect(m.messageTruncated).toBe(220);
    }
  });

  it('accepts every in-range priority filter value', () => {
    const parsed = ntfyFetchMessages.input.safeParse({
      topic: 'alerts',
      priority: [1, 2, 3, 4, 5],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an out-of-range priority filter with one issue naming the allowed range', () => {
    const parsed = ntfyFetchMessages.input.safeParse({ topic: 'alerts', priority: [9] });
    expect(parsed.success).toBe(false);
    const issues = parsed.error?.issues ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).not.toBe('invalid_union');
    expect(issues[0]?.message).toBe(
      'Priority must be a whole number from 1 (min) to 5 (max/urgent).',
    );
    expect(issues[0]?.path).toEqual(['priority', 0]);
  });

  it('advertises priority as a single constrained node rather than a five-branch union', () => {
    const schema = z.toJSONSchema(ntfyFetchMessages.input, { io: 'input' }) as unknown as {
      properties: { priority: { items: Record<string, unknown> } };
    };
    expect(schema.properties.priority.items).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 5,
    });
    expect(schema.properties.priority.items).not.toHaveProperty('anyOf');
  });

  it('preserves missing upstream fields as undefined (sparse payload)', async () => {
    const svc = freshService();
    // ntfy commonly omits title/tags/priority when default
    stubFetch(svc, [
      {
        id: 'sparse',
        time: 1,
        event: 'message',
        topic: 'alerts',
        message: 'minimal body',
      },
    ]);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts' });
    const result = await ntfyFetchMessages.handler(input, ctx);

    expect(result.messages[0]).toMatchObject({
      id: 'sparse',
      message: 'minimal body',
      title: undefined,
      tags: undefined,
      priority: undefined,
      attachment: undefined,
    });
  });

  it('forwards filter args to the service and echoes them as appliedFilters', async () => {
    const svc = freshService();
    const fetch = stubFetch(svc, []);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({
      topic: 'alerts',
      since: '2h',
      scheduled: true,
      priority: [4, 5],
      tags: ['warning'],
      title: 'Backup',
    });
    await ntfyFetchMessages.handler(input, ctx);
    expect(fetch.mock.calls[0]?.[0]).toMatchObject({
      topic: 'alerts',
      since: '2h',
      scheduled: true,
      priority: [4, 5],
      tags: ['warning'],
      title: 'Backup',
    });
    expect(getEnrichment(ctx).appliedFilters).toMatchObject({
      priority: [4, 5],
      tags: ['warning'],
      title: 'Backup',
    });
  });

  it('names the topic in double quotes, as plain text, when ntfy gave no `forbidden_topic` explanation', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'fetch').mockRejectedValue(
      forbidden('', { status: 403, body: '{"code":40301,"http":403,"error":"forbidden"}' }),
    );
    const result = await runToolContract(ntfyFetchMessages, { topic: '_secret_' });
    const { error } = result.structuredContent as {
      error: { message: string; data: { reason?: string } };
    };
    expect(error).toMatchObject({
      message: 'Forbidden for topic "_secret_"',
      data: { reason: 'forbidden_topic' },
    });
    expect(
      readCommonMark(result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')),
    ).toContain('Error: Forbidden for topic "_secret_"');
  });

  it("maps ntfy's 40008 `invalid since parameter` to `invalid_since`", async () => {
    const svc = freshService();
    vi.spyOn(svc, 'fetch').mockRejectedValue(
      invalidParams(
        'ntfy returned HTTP 400 Bad Request: invalid since parameter (see https://ntfy.sh/docs/subscribe/api/#fetch-cached-messages)',
        {
          status: 400,
          body: '{"code":40008,"http":400,"error":"invalid since parameter","link":"https://ntfy.sh/docs/subscribe/api/#fetch-cached-messages"}',
        },
      ),
    );
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts', since: '1d' });
    await expect(ntfyFetchMessages.handler(input, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('invalid since parameter'),
      data: { reason: 'invalid_since' },
    });
  });

  it.each([
    ['no explanation', ''],
    ['text that does not name `since`', 'Bad since value'],
  ])(
    'never labels a 400 with %s as `invalid_since`, and keeps its message',
    async (_case, message) => {
      const svc = freshService();
      vi.spyOn(svc, 'fetch').mockRejectedValue(invalidParams(message));
      const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
      const input = ntfyFetchMessages.input.parse({ topic: 'alerts', since: '2h`x' });
      await expect(ntfyFetchMessages.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        message,
      });
      await expect(ntfyFetchMessages.handler(input, ctx)).rejects.not.toHaveProperty('data.reason');
    },
  );

  it('keeps the upstream explanation alongside the `invalid_since` recovery hint', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'fetch').mockRejectedValue(
      invalidParams(
        'ntfy returned HTTP 400 Bad Request: invalid since parameter: unable to parse duration',
        {
          status: 400,
          body: '{"code":40008,"http":400,"error":"invalid since parameter: unable to parse duration"}',
        },
      ),
    );
    const result = await runToolContract(ntfyFetchMessages, {
      topic: 'alerts',
      since: 'tomorrow_maybe',
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          message: expect.stringContaining('invalid since parameter: unable to parse duration'),
          data: {
            reason: 'invalid_since',
            recovery: { hint: expect.stringContaining('`all`') },
          },
        },
      },
    });
  });

  it('renders message bodies and details in format()', () => {
    const blocks = ntfyFetchMessages.format!({
      messages: [
        {
          id: 'm1',
          time: '2023-11-14T22:13:20.000Z',
          event: 'message',
          topic: 'alerts',
          title: 'Backup failed',
          priority: 5,
          tags: ['warning'],
          message: 'content',
          messageTruncated: 200,
          click: 'https://example.com',
          attachment: { name: 'log.txt', url: 'https://example.com/log.txt' },
          actions: [{ action: 'view', label: 'Open', url: 'https://example.com' }],
          expires: '2023-11-14T22:30:00.000Z',
          sequence_id: 'seq_1',
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Backup failed');
    expect(text).toContain('warning');
    expect(text).toContain('200 chars more');
    expect(text).toContain('log.txt');
    expect(text).toContain('seq_1');
  });

  it('enriches resolved topic/since/active filters and a notice on an empty result', async () => {
    const svc = freshService();
    stubFetch(svc, []);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({
      topic: 'alerts',
      since: '10m',
      title: 'never-matches-xyz',
    });
    const result = await ntfyFetchMessages.handler(input, ctx);
    expect(result.messages).toHaveLength(0);

    const e = getEnrichment(ctx);
    expect(e).toMatchObject({ topic: 'alerts', since: '10m', count: 0, truncated: false });
    expect(e.appliedFilters).toMatchObject({ title: 'never-matches-xyz' });
    expect(e.notice).toContain('never-matches-xyz');
    expect(String(e.notice).toLowerCase()).toContain('try');
  });

  it('applies the default `since` of `10m` when omitted', async () => {
    const svc = freshService();
    const fetch = stubFetch(svc, []);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts' });
    await ntfyFetchMessages.handler(input, ctx);
    expect(fetch.mock.calls[0]?.[0].since).toBe('10m');
    expect(getEnrichment(ctx).since).toBe('10m');
  });

  it('uses NTFY_DEFAULT_TOPIC when topic is omitted', async () => {
    process.env.NTFY_DEFAULT_TOPIC = 'fallback';
    const svc = freshService();
    const fetch = stubFetch(svc, []);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({});
    await ntfyFetchMessages.handler(input, ctx);
    expect(fetch.mock.calls[0]?.[0].topic).toBe('fallback');
    expect(getEnrichment(ctx).topic).toBe('fallback');
  });

  it('throws ValidationError when neither topic nor NTFY_DEFAULT_TOPIC is set', async () => {
    freshService();
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({});
    await expect(ntfyFetchMessages.handler(input, ctx)).rejects.toThrow(/Topic is required/);
  });

  it('forwards `base_url` (trailing-slash-normalized) to the service', async () => {
    const svc = freshService();
    const fetch = stubFetch(svc, []);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({
      topic: 'alerts',
      base_url: 'https://other.example.com/',
    });
    await ntfyFetchMessages.handler(input, ctx);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ baseUrl: 'https://other.example.com' });
  });

  it('describes `base_url` credential forwarding as keyed on every registered server', () => {
    const description = ntfyFetchMessages.input.shape.base_url.description ?? '';
    expect(description).toContain('only when the override matches a registered server');
    expect(description).toContain('`NTFY_SERVERS` entry');
    expect(description).not.toContain('differs from the configured base URL');
  });

  it.each(['ftp://ntfy.example.com', 'ntfy.example.com', 'https://ntfy example.com'])(
    'rejects the %j base_url at the schema boundary',
    (base_url) => {
      expect(() => ntfyFetchMessages.input.parse({ topic: 'alerts', base_url })).toThrow();
    },
  );

  it('treats an empty `base_url` from a form client as no override', async () => {
    const svc = freshService();
    const fetch = stubFetch(svc, []);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts', base_url: '' });
    await ntfyFetchMessages.handler(input, ctx);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ baseUrl: undefined });
  });

  it('passes a rejected `base_url` through instead of blaming `since`', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'fetch').mockRejectedValue(
      validationError('base_url host 169.254.169.254 resolves to a non-public address', {
        baseUrlRejected: true,
        recovery: { hint: 'Target a publicly reachable ntfy server' },
      }),
    );
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({
      topic: 'alerts',
      base_url: 'http://169.254.169.254',
    });
    const err = await Promise.resolve(ntfyFetchMessages.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ message: expect.stringContaining('non-public address') });
    expect((err as { data?: { reason?: string } }).data?.reason).toBeUndefined();
  });

  it('maps a retry-exhausted network error to `upstream_unreachable`', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'fetch').mockRejectedValue(
      new Error('dns lookup failed (failed after 3 attempts)'),
    );
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts' });
    await expect(ntfyFetchMessages.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'upstream_unreachable' },
    });
  });

  it('maps a call that ran out of its deadline to `upstream_unreachable`', async () => {
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
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts' });
    const err = await onFakeClock(
      () => Promise.resolve(ntfyFetchMessages.handler(input, ctx)).catch((e: unknown) => e),
      CALL_DEADLINE_MS,
    );
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'ntfy poll exceeded its 50000ms retry deadline after 1 attempt.',
      data: { reason: 'upstream_unreachable' },
    });
  });

  it('rethrows unclassified errors so the framework auto-classifier handles them', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'fetch').mockRejectedValue(notFound('topic vanished'));
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts' });
    await expect(ntfyFetchMessages.handler(input, ctx)).rejects.not.toMatchObject({
      data: expect.objectContaining({ reason: expect.any(String) }),
    });
  });
});

/**
 * Through the real `NtfyService` — only the network is stubbed — so the poll
 * body parse, the retry boundary, and the header read all run.
 */
describe('ntfyFetchMessages against a stubbed ntfy upstream', () => {
  beforeEach(() => {
    resetServerConfig();
    resetNtfyService();
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.NTFY_BASE_URL = 'https://ntfy.test';
    freshService();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    resetServerConfig();
    resetNtfyService();
    vi.restoreAllMocks();
  });

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

  function errorOf(result: Awaited<ReturnType<typeof runToolContract>>) {
    return (
      result.structuredContent as {
        error: { code: number; message: string; data: Record<string, unknown> };
      }
    ).error;
  }

  function textOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
    return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  }

  it('fails a damaged poll body with `upstream_malformed` on both surfaces, never a partial list', async () => {
    stubUpstream(poll([line('a', 1), '{ this is not json', line('b', 2)].join('\n')));
    const result = await runToolContract(ntfyFetchMessages, {
      topic: 'alerts',
      since: 'all',
      limit: 100,
    });
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data.reason).toBe('upstream_malformed');
    expect(error.data.retryable).toBe(true);
    expect(error.message).toContain('line 2');
    expect(error.data.recovery).toMatchObject({
      hint: expect.stringContaining('points at an ntfy server'),
    });
    const text = textOf(result);
    expect(text).toContain('line 2');
    expect(text).toContain('reason upstream_malformed');
    expect(text).toContain('points at an ntfy server');
  });

  it('fails a 200 HTML page with `upstream_malformed` instead of the empty-topic notice', async () => {
    stubUpstream(
      () =>
        new Response('<!doctype html><html><body>Captive portal</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts', since: 'all' });
    expect(result.isError).toBe(true);
    expect(errorOf(result).data.reason).toBe('upstream_malformed');
    expect(textOf(result)).not.toContain('No messages on topic');
  });

  it("surfaces an error envelope line with ntfy's status and text, not `Invalid Date`", async () => {
    stubUpstream(
      poll(
        [
          line('a', 1),
          line('b', 2),
          '{"code":42905,"http":429,"error":"limit reached: daily bandwidth reached"}',
        ].join('\n'),
      ),
    );
    const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts', since: 'all' });
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.message).toContain('ntfy returned HTTP 429');
    expect(error.message).toContain('limit reached: daily bandwidth');
    expect(error.data.reason).toBe('rate_limited');
    expect(error.data.retryable).toBe(true);
    expect(error.data.recovery).toMatchObject({
      hint: expect.stringContaining('rate-limit window'),
    });
    const text = textOf(result);
    expect(text).not.toContain('Invalid Date');
    expect(text).toContain('reason rate_limited');
    expect(text).toContain('rate-limit window');
  });

  it('maps a 429 status line that outlasts the retries to `rate_limited` on both surfaces', async () => {
    resetNtfyService();
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
    const result = await onFakeClock(() => runToolContract(ntfyFetchMessages, { topic: 'alerts' }));
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data.reason).toBe('rate_limited');
    expect(error.data.retryable).toBe(true);
    expect(error.message).toContain('limit reached: too many requests');
    expect(error.message).toContain('(failed after 2 attempts)');
    expect(error.data.recovery).toMatchObject({
      hint: expect.stringContaining('rate-limit window'),
    });
    const text = textOf(result);
    expect(text).toContain('reason rate_limited');
    expect(text).toContain('limit reached: too many requests');
  });

  it('carries a Retry-After the call could not wait out onto `rate_limited`, without claiming it retried', async () => {
    // Retries allowed, so only the over-budget Retry-After keeps this to one attempt.
    resetNtfyService();
    initNtfyService({
      servers: [{ baseUrl: 'https://ntfy.test' }],
      requestTimeoutMs: 1000,
      maxRetries: 3,
    } as never);
    const upstream = stubUpstream(
      () =>
        new Response('{"code":42901,"http":429,"error":"limit reached: too many requests"}', {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '40' },
        }),
    );
    const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts' });
    expect(upstream).toHaveBeenCalledTimes(1);
    const error = errorOf(result);
    expect(error.data.reason).toBe('rate_limited');
    expect(error.data.retryAfter).toBe('40');
    expect(error.data).not.toHaveProperty('retryAttempts');
    expect(error.message).toContain('limit reached: too many requests');
    expect(error.message).not.toMatch(/failed after/);
    expect(error.data.recovery).toMatchObject({ hint: expect.stringContaining('retryAfter') });
    expect(textOf(result)).not.toMatch(/failed after/);
  });

  describe('a 5xx carrying Retry-After (#42)', () => {
    /** ntfy answering every request 503, with `retry-after` when one is given. */
    const unavailable = (retryAfter?: string) => () =>
      new Response('{"code":50301,"http":503,"error":"service unavailable"}', {
        status: 503,
        headers: {
          'content-type': 'application/json',
          ...(retryAfter === undefined ? {} : { 'retry-after': retryAfter }),
        },
      });

    beforeEach(() => {
      resetNtfyService();
      initNtfyService({
        servers: [{ baseUrl: 'https://ntfy.test' }],
        requestTimeoutMs: 1000,
        maxRetries: 3,
      } as never);
    });

    const DECLARED = ntfyFetchMessages.errors?.find((e) => e.reason === 'upstream_unreachable')
      ?.recovery as string;

    it('fails a Retry-After the call cannot wait out as `upstream_unreachable`, unretried, naming the wait', async () => {
      const upstream = stubUpstream(unavailable('120'));
      const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts' });
      expect(upstream).toHaveBeenCalledTimes(1);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toMatch(/^ntfy returned HTTP 503\b.*: service unavailable$/);
      expect(error.data).toMatchObject({
        reason: 'upstream_unreachable',
        retryable: true,
        retryAfter: '120',
        recovery: {
          hint: 'The ntfy server answered but asked to wait (Retry-After: 120); poll again once that wait has passed.',
        },
      });
      expect(error.data).not.toHaveProperty('retryAttempts');
      const text = readCommonMark(textOf(result));
      expect(text).toContain('Retry-After: 120); poll again once that wait has passed.');
      expect(text).toContain('reason upstream_unreachable');
      expect(text).not.toMatch(/failed after/);
    });

    it('carries the Retry-After of a ladder the deadline cut short onto `upstream_unreachable`', async () => {
      const upstream = stubUpstream(unavailable('26'));
      const result = await onFakeClock(
        () => runToolContract(ntfyFetchMessages, { topic: 'alerts' }),
        30_000,
      );
      expect(upstream).toHaveBeenCalledTimes(2);
      const error = errorOf(result);
      expect(error.message).toContain('(failed after 2 attempts)');
      expect(error.data).toMatchObject({ reason: 'upstream_unreachable', retryAfter: '26' });
      expect(error.data.recovery).toMatchObject({
        hint: expect.stringContaining('Retry-After: 26'),
      });
    });

    it('keeps the declared recovery on a 503 with no Retry-After, retried to exhaustion', async () => {
      const upstream = stubUpstream(unavailable());
      const result = await onFakeClock(
        () => runToolContract(ntfyFetchMessages, { topic: 'alerts' }),
        10_000,
      );
      expect(upstream).toHaveBeenCalledTimes(4);
      const error = errorOf(result);
      expect(error.message).toContain('(failed after 4 attempts)');
      expect(error.data.reason).toBe('upstream_unreachable');
      expect(error.data).not.toHaveProperty('retryAfter');
      expect(error.data.recovery).toEqual({ hint: DECLARED });
      expect(DECLARED).toContain('`retryAfter`');
      expect(DECLARED).toContain('`NTFY_BASE_URL`');
    });
  });

  it("discloses ntfy's replay cap in the enrichment and a notice on both surfaces", async () => {
    stubUpstream(
      poll(['a', 'b', 'c', 'd', 'e'].map((id, i) => line(id, i + 1)).join('\n'), {
        'x-messages-truncated': '1',
      }),
    );
    const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts', since: 'all' });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ count: 5, truncated: false, upstreamTruncated: true });
    expect(structured.notice).toContain('ntfy capped this replay');
    expect(structured.notice).toContain('5 messages are what ntfy returned');
    expect(structured.notice).toContain('not reachable through this server');
    const text = textOf(result);
    expect(text).toContain('ntfy capped this replay');
    expect(text).toMatch(/upstreamTruncated/);
  });

  it('words the replay-cap notice in the singular when ntfy returned one message', async () => {
    stubUpstream(poll(line('a', 1), { 'x-messages-truncated': '1' }));
    const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts', since: 'all' });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.notice).toContain('this message is what ntfy returned');
    expect(structured.notice).not.toContain('1 messages');
  });

  it('labels the count as what ntfy returned when both the replay cap and `limit` drop messages', async () => {
    stubUpstream(
      poll(['a', 'b', 'c', 'd', 'e'].map((id, i) => line(id, i + 1)).join('\n'), {
        'x-messages-truncated': '1',
      }),
    );
    const result = await runToolContract(ntfyFetchMessages, {
      topic: 'alerts',
      since: 'all',
      limit: 2,
    });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ count: 2, truncated: true, upstreamTruncated: true });
    expect(structured.notice).toContain('ntfy returned 5 messages');
    expect(structured.notice).not.toContain('matched');
    expect(structured.notice).toContain('newest 2');
    expect(structured.notice).toContain('ntfy capped this replay');
    expect((structured.messages as Array<{ id: string }>).map((m) => m.id)).toEqual(['d', 'e']);
  });

  it('leaves the enrichment unchanged when ntfy sends no replay-cap header', async () => {
    stubUpstream(poll([line('a', 1), line('b', 2)].join('\n')));
    const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts', since: 'all' });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ count: 2, truncated: false });
    expect(structured).not.toHaveProperty('upstreamTruncated');
    expect(structured).not.toHaveProperty('notice');
    expect(textOf(result)).not.toContain('upstreamTruncated');
  });

  it('keeps the empty-topic notice for an empty poll body', async () => {
    stubUpstream(poll(''));
    const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts', since: 'all' });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ count: 0, truncated: false });
    expect(structured.notice).toContain('No messages on topic `alerts`');
  });

  it('warns on both surfaces that a just-published message may not be returned yet, and keeps the topic hint', async () => {
    stubUpstream(poll(''));
    const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts' });
    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain('verify the topic name');
    expect(notice).toContain(JUST_PUBLISHED);
    const rendered = readCommonMark(textOf(result));
    expect(rendered).toContain('verify the topic name');
    expect(rendered).toContain(JUST_PUBLISHED);
  });

  it('leaves the just-published warning out of a non-empty result', async () => {
    stubUpstream(poll([line('a', 1), line('b', 2)].join('\n')));
    const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts', limit: 1 });
    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain('newest 1');
    expect(notice).not.toContain(JUST_PUBLISHED);
  });

  describe('400 rejections of the poll (#41)', () => {
    /** ntfy's JSON error envelope, texts and links as in its `server/errors.go`. */
    const rejection = (code: number, error: string, link?: string) => () =>
      new Response(JSON.stringify({ code, http: 400, error, ...(link ? { link } : {}) }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });

    it('labels 40008 `invalid since parameter` as `invalid_since` with the `since` recovery', async () => {
      stubUpstream(
        rejection(
          40008,
          'invalid since parameter',
          'https://ntfy.sh/docs/subscribe/api/#fetch-cached-messages',
        ),
      );
      const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts', since: '1d' });
      const error = errorOf(result);
      expect(error.data.reason).toBe('invalid_since');
      expect(error.message).toContain('invalid since parameter');
      expect(error.data.recovery).toMatchObject({
        hint: expect.stringContaining('Unix timestamp'),
      });
      const rendered = readCommonMark(textOf(result));
      expect(rendered).toContain('invalid_since');
      expect(rendered).toContain('Unix timestamp');
    });

    it.each([
      [40010, 'invalid request: topic name is not allowed', undefined],
      [
        40061,
        'invalid request: too many topics',
        'https://ntfy.sh/docs/subscribe/api/#subscribe-to-multiple-topics',
      ],
    ])(
      'keeps %i in ntfy’s own words, with no `invalid_since` label or `since` recovery',
      async (_code, text, link) => {
        const upstream = stubUpstream(rejection(_code, text, link));
        const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts,metrics' });
        expect(upstream).toHaveBeenCalledTimes(1);
        expect(result.isError).toBe(true);
        const error = errorOf(result);
        expect(error.message).toContain(text);
        expect(error.data).not.toHaveProperty('reason');
        expect(JSON.stringify(error.data)).not.toContain('Unix timestamp');
        const rendered = readCommonMark(textOf(result));
        expect(rendered).toContain(text);
        expect(rendered).not.toContain('invalid_since');
        expect(rendered).not.toContain('Unix timestamp');
      },
    );
  });

  describe("forbidden_topic only on ntfy's own auth envelope (#45)", () => {
    const AUTH_DOCS = 'https://ntfy.sh/docs/publish/#authentication';
    const envelope = (status: number, code: number, error: string) =>
      JSON.stringify({ code, http: status, error, link: AUTH_DOCS });
    const HINT = ntfyFetchMessages.errors?.find((e) => e.reason === 'forbidden_topic')
      ?.recovery as string;

    it.each([
      [401, 40101, 'unauthorized'],
      [403, 40301, 'forbidden'],
    ])(
      "maps ntfy's %i envelope (%i) to `forbidden_topic` on both surfaces",
      async (status, code, text) => {
        stubUpstream(
          () =>
            new Response(envelope(status, code, text), {
              status,
              headers: { 'content-type': 'application/json' },
            }),
        );
        const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts' });
        const error = errorOf(result);
        expect(error.data.reason).toBe('forbidden_topic');
        expect(error.data.recovery).toEqual({ hint: HINT });
        expect(error.message).toContain(`HTTP ${status}`);
        expect(error.message).toContain(`${text} (see ${AUTH_DOCS})`);
        const rendered = readCommonMark(textOf(result));
        expect(rendered).toContain(`Recovery: ${HINT}`);
        expect(rendered).toContain('reason forbidden_topic');
      },
    );

    it('maps an auth error line ntfy writes into a 200 replay to `forbidden_topic`', async () => {
      stubUpstream(poll(`${line('a', 1)}\n${envelope(403, 40301, 'forbidden')}`));
      const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts' });
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.Forbidden,
        data: { reason: 'forbidden_topic' },
      });
    });

    it("fails a proxy's HTML 403 without `forbidden_topic`, keeping the status in the message", async () => {
      const upstream = stubUpstream(
        () =>
          new Response(
            '<html>\n<head><title>403 Forbidden</title></head>\n<body>\n<center><h1>403 Forbidden</h1></center>\n<hr><center>nginx</center>\n</body>\n</html>\n',
            { status: 403, headers: { 'content-type': 'text/html' } },
          ),
      );
      const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts' });
      expect(upstream).toHaveBeenCalledTimes(1);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.Forbidden);
      expect(error.data).not.toHaveProperty('reason');
      expect(error.data).not.toHaveProperty('recovery');
      expect(error.message).toContain('HTTP 403');
      const rendered = readCommonMark(textOf(result));
      expect(rendered).toContain('HTTP 403');
      expect(rendered).not.toContain('forbidden_topic');
      expect(rendered).not.toContain('NTFY_AUTH_TOKEN');
    });
  });

  describe('per-topic length cap (#41)', () => {
    const t64 = `${'a'.repeat(63)}Z`;
    const t65 = 'b'.repeat(65);

    it.each([
      ['alone', t64],
      ['first in a list', `${t64},alerts`],
      ['last in a list', `alerts,${t64}`],
      ['twice', `${t64},${t64}`],
    ])('polls a 64-character topic %s', async (_where, topic) => {
      const upstream = stubUpstream(poll(''));
      const result = await runToolContract(ntfyFetchMessages, { topic });
      expect(result.isError).toBeFalsy();
      expect(upstream).toHaveBeenCalledTimes(1);
      expect((result.structuredContent as { topic: string }).topic).toBe(topic);
    });

    it.each([
      ['alone', t65],
      ['first in a list', `${t65},alerts`],
      ['last in a list', `alerts,${t65}`],
      ['beside a 64-character one', `${t64},${t65}`],
    ])(
      'refuses a 65-character topic %s, naming the 64-character limit, before any request',
      async (_where, topic) => {
        const upstream = stubUpstream(poll(''));
        const result = await runToolContract(ntfyFetchMessages, { topic });
        expect(result.isError).toBe(true);
        const error = errorOf(result);
        expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(error.message).toContain('1 to 64 characters');
        expect(readCommonMark(textOf(result))).toContain('1 to 64 characters');
        expect(upstream).not.toHaveBeenCalled();
      },
    );

    it.each(['', ' ', 'alerts,', ',alerts', 'alerts,,backups'])(
      'still refuses %j before any request',
      async (topic) => {
        const upstream = stubUpstream(poll(''));
        const result = await runToolContract(ntfyFetchMessages, { topic });
        expect(result.isError).toBe(true);
        expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(upstream).not.toHaveBeenCalled();
      },
    );

    it('advertises the cap in the `topic` pattern of `tools/list`, with no cap on the topic count', () => {
      const schema = z.toJSONSchema(ntfyFetchMessages.input, { io: 'input' }) as unknown as {
        properties: { topic: { pattern: string; maxLength?: number } };
      };
      const pattern = new RegExp(schema.properties.topic.pattern);
      expect(pattern.test(t64)).toBe(true);
      expect(pattern.test(Array.from({ length: 200 }, () => t64).join(','))).toBe(true);
      expect(pattern.test(t65)).toBe(false);
      expect(pattern.test(`alerts,${t65}`)).toBe(false);
      expect(schema.properties.topic.maxLength).toBeUndefined();
    });
  });

  /**
   * Upstream strings reach `content[]` as code spans and fences, never as live
   * Markdown, while `structuredContent` keeps every value as ntfy sent it (#28).
   * The fixtures run through the real poll parse and `shapeMessage()`.
   */
  describe('upstream text renders as literal Markdown (#28)', () => {
    const envelope = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      time: 1_700_000_000,
      event: 'message',
      topic: 'alerts',
      ...extra,
    });
    const ndjson = (...envelopes: object[]) =>
      poll(envelopes.map((e) => JSON.stringify(e)).join('\n'));
    const domainText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      (result.content[0] as { text: string }).text;

    const PLAIN = {
      title: 'Review <title> *literal*',
      message: '*literal* <admin@example.com> [text](https://example.invalid) `code`',
      click: 'https://example.invalid/a)b',
      attachment: { name: 'report](x) (draft).txt', url: 'https://example.invalid/file.txt' },
    };

    it('renders every value of a plain message as a code span or a `text` fence, exact lines', async () => {
      stubUpstream(ndjson(envelope('m1', PLAIN)));
      const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts', since: 'all' });
      expect(domainText(result)).toBe(
        [
          '### `m1` — `message` on `alerts`',
          'Time: 2023-11-14T22:13:20.000Z',
          'Title: `Review <title> *literal*`',
          'Click action: `https://example.invalid/a)b`',
          'Attachment: `report](x) (draft).txt` — `https://example.invalid/file.txt`',
          '',
          '```text',
          '*literal* <admin@example.com> [text](https://example.invalid) `code`',
          '```',
        ].join('\n'),
      );
      const [message] = (result.structuredContent as { messages: Record<string, unknown>[] })
        .messages;
      expect(message).toMatchObject(PLAIN);
      expect(message?.markdown).toBeUndefined();
      expect(JSON.parse(JSON.stringify(message))).not.toHaveProperty('markdown');
    });

    it('keeps a message with action buttons from swallowing the next message', async () => {
      const actions = [
        { action: 'view', label: 'Open', url: 'https://example.com' },
        { action: 'copy', label: 'Copy `code`', value: 'x' },
      ];
      stubUpstream(
        ndjson(
          envelope('m1', { message: 'content', actions, tags: ['warning', 'a`b', '`edge '] }),
          envelope('m2', { message: 'second' }),
        ),
      );
      const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts', since: 'all' });
      expect(domainText(result)).toBe(
        [
          '### `m1` — `message` on `alerts`',
          'Time: 2023-11-14T22:13:20.000Z',
          'Tags: `warning` · ``a`b`` · `` `edge  ``',
          'Actions:',
          '- `{"action":"view","label":"Open","url":"https://example.com"}`',
          '- ``{"action":"copy","label":"Copy `code`","value":"x"}``',
          '',
          '```text',
          'content',
          '```',
          '',
          '### `m2` — `message` on `alerts`',
          'Time: 2023-11-14T22:13:20.000Z',
          '',
          '```text',
          'second',
          '```',
        ].join('\n'),
      );
      const { messages } = result.structuredContent as {
        messages: Array<{ actions?: unknown; tags?: string[] }>;
      };
      expect(messages[0]?.actions).toEqual(actions);
      expect(messages[0]?.tags).toEqual(['warning', 'a`b', '`edge ']);
    });

    it('marks a `text/markdown` message on both surfaces and fences its source unescaped', async () => {
      stubUpstream(
        ndjson(
          envelope('m1', { message: '**bold** _md_', content_type: 'text/markdown' }),
          envelope('m2', { message: '**not** md' }),
        ),
      );
      const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts', since: 'all' });
      const { messages } = result.structuredContent as {
        messages: Array<{ message?: string; markdown?: boolean }>;
      };
      expect(messages[0]).toMatchObject({ message: '**bold** _md_', markdown: true });
      expect(messages[1]?.markdown).toBeUndefined();
      const text = domainText(result);
      expect(text).toContain('\n```markdown\n**bold** _md_\n```\n');
      expect(text).toContain('\n```text\n**not** md\n```');
    });

    it('sizes the body fence past a fence inside the body, and keeps the truncation suffix', async () => {
      const body = `before\n\`\`\`\nnot code\n\`\`\`\n${'x'.repeat(600)}`;
      stubUpstream(ndjson(envelope('m1', { message: body }), envelope('m2', { message: 'next' })));
      const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts', since: 'all' });
      const text = domainText(result);
      expect(text).toContain(`\n\`\`\`\`text\n${body.slice(0, 500)}\n\`\`\`\`\n_(`);
      expect(text).toMatch(/\n````\n_\(\d+ chars more\)_\n\n### `m2`/);
    });

    it('moves a title, tag, or id with a line break into its own `text` fence', async () => {
      stubUpstream(
        ndjson(
          envelope('m1\n# forged', {
            title: 'a\r\n# Forged heading',
            tags: ['ok', 'two\rlines'],
            message: 'body',
          }),
        ),
      );
      const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts', since: 'all' });
      const text = domainText(result);
      expect(text).toContain('### \n```text\nm1\n# forged\n```\n — `message` on `alerts`');
      expect(text).toContain('Title: \n```text\na\r\n# Forged heading\n```\n');
      expect(text).toContain('Tags: `ok` · \n```text\ntwo\rlines\n```\n');
    });

    it('wraps caller filter values and `since` in sized spans in the notice and the filter trailer', async () => {
      stubUpstream(poll(''));
      const result = await runToolContract(ntfyFetchMessages, {
        topic: 'alerts',
        since: '10m`x',
        title: 'a`b',
        tags: ['t`1'],
      });
      const structured = result.structuredContent as { notice?: string };
      expect(structured.notice).toContain('No messages on topic `alerts` (since ``10m`x``)');
      expect(structured.notice).toContain('title=``a`b``');
      expect(structured.notice).toContain('tags=[``t`1``]');
      expect(textOf(result)).toContain('**Filters:** title=``a`b``, tags=[``t`1``]');
    });

    it('quotes a backticked `cursor` as plain text in the `cursor_not_found` message, on both surfaces', async () => {
      stubUpstream(ndjson(envelope('m1', { message: 'one' })));
      const result = await runToolContract(ntfyFetchMessages, {
        topic: 'alerts',
        since: 'all',
        cursor: 'gone`*id*',
      });
      const message =
        'Cursor "gone`*id*" names none of the 1 messages in the window for topic "alerts" (since "all").';
      expect(errorOf(result).data.reason).toBe('cursor_not_found');
      expect(errorOf(result).message).toBe(message);
      expect(readCommonMark(textOf(result))).toContain(`Error: ${message}`);
    });
  });
});

/**
 * Blank-filter normalization and `cursor` paging, through the real
 * `NtfyService` against a fake ntfy that serves a mutable window, honors the
 * `id` filter the way ntfy does, and records every URL it was sent — so the
 * assertions read what actually went upstream, not what the handler meant to send.
 */
describe('ntfyFetchMessages filters and paging against a fake ntfy window', () => {
  type Envelope = { id: string; time: number; event: 'message'; topic: string; message: string };

  let store: Envelope[];
  let sent: URL[];
  let capHeader: boolean;
  /**
   * The fake ntfy's clock, in Unix seconds. While set, the fake bounds the
   * window by `since` the way ntfy does — a duration from this clock, a Unix
   * timestamp inclusively (`time >= since`, measured on ntfy.sh) — so a test can
   * move ntfy's "now" between pages. Unset, `since` is recorded but not applied.
   */
  let now: number | undefined;

  const DURATION_UNIT = { s: 1, m: 60, h: 3600 } as const;
  function lowerBound(since: string | null): number {
    if (now === undefined || since === null || since === 'all') return 0;
    if (/^\d+$/.test(since)) return Number(since);
    const d = /^(\d+)([smh])$/.exec(since);
    if (!d) throw new Error(`fake ntfy: unhandled since ${since}`);
    return now - Number(d[1]) * DURATION_UNIT[d[2] as keyof typeof DURATION_UNIT];
  }

  const env = (n: number, body = `body ${n}`): Envelope => ({
    id: `m${String(n).padStart(3, '0')}`,
    time: 1_700_000_000 + n,
    event: 'message',
    topic: 'alerts',
    message: body,
  });
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => env(from + i));
  const ids = (list: Array<{ id: string }>) => list.map((m) => m.id);

  beforeEach(() => {
    resetServerConfig();
    resetNtfyService();
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.NTFY_BASE_URL = 'https://ntfy.test';
    freshService();
    store = [];
    sent = [];
    capHeader = false;
    now = undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== 'ntfy.test') throw new Error(`Unmocked fetch: ${url.href}`);
      sent.push(url);
      const id = url.searchParams.get('id');
      const from = lowerBound(url.searchParams.get('since'));
      const window = store.filter((m) => m.time >= from && (!id || m.id === id));
      return new Response(window.map((m) => JSON.stringify(m)).join('\n'), {
        status: 200,
        headers: {
          'content-type': 'application/x-ndjson; charset=utf-8',
          ...(capHeader ? { 'x-messages-truncated': '1' } : {}),
        },
      });
    });
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    resetServerConfig();
    resetNtfyService();
    vi.restoreAllMocks();
  });

  type Structured = {
    messages: Array<{ id: string; message?: string; messageTruncated?: number }>;
    count: number;
    totalCount: number;
    nextCursor?: string;
    truncated: boolean;
    since: string;
    appliedFilters?: Record<string, unknown>;
    notice?: string;
    upstreamTruncated?: boolean;
  };

  async function call(args: Record<string, unknown>) {
    const result = await runToolContract(ntfyFetchMessages, args);
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    return { result, structured: result.structuredContent as Structured, text };
  }

  /**
   * Walks a window the way an agent would: the default call, then `nextCursor`
   * fed back verbatim through the tool's own input schema until it is absent.
   * `between` runs after each page so a test can change the window mid-walk.
   */
  async function walk(base: Record<string, unknown>, between?: (page: number) => void) {
    const first = await call(base);
    const pages: Structured[] = [];
    let cursor = first.structured.nextCursor;
    while (cursor !== undefined) {
      between?.(pages.length);
      const args = ntfyFetchMessages.input.parse({ ...base, cursor });
      expect(args.cursor).toBe(cursor);
      const page = await call(args);
      expect(page.result.isError).toBeFalsy();
      pages.push(page.structured);
      cursor = page.structured.nextCursor;
      expect(pages.length).toBeLessThan(50);
    }
    return { first: first.structured, pages, seen: pages.flatMap((p) => ids(p.messages)) };
  }

  describe('blank and whitespace filters (#26)', () => {
    it.each(['', '   ', '\t'])(
      'sends and echoes the `10m` default for a blank `since` (%j), never ntfy `all`',
      async (since) => {
        store = range(1, 3);
        const { structured } = await call({ topic: 'alerts', since });
        expect(sent[0]?.searchParams.get('since')).toBe('10m');
        expect(structured.since).toBe('10m');
      },
    );

    it('names the resolved `since` in the empty-result notice when `since` was blank', async () => {
      const { structured } = await call({ topic: 'alerts', since: ' ' });
      expect(structured.notice).toContain('(since `10m`)');
    });

    it.each(['all', 'latest', '30s', '2h', '1700000000', 'abcDEF123456'])(
      'passes `since` %j through unchanged, and echoes exactly what was sent',
      async (since) => {
        const { structured } = await call({ topic: 'alerts', since });
        expect(sent[0]?.searchParams.get('since')).toBe(since);
        expect(structured.since).toBe(since);
      },
    );

    it.each(['all', '2h', 'abcDEF123456'])(
      'trims a padded `since` %j before sending, so the echo is the value ntfy received',
      async (since) => {
        const { structured } = await call({ topic: 'alerts', since: ` ${since}\t` });
        expect(sent[0]?.searchParams.get('since')).toBe(since);
        expect(structured.since).toBe(since);
      },
    );

    it('keeps list bodies capped and sends no `id` when `id` is whitespace', async () => {
      store = [env(1, 'd'.repeat(720)), env(2, 'd'.repeat(720))];
      const { structured } = await call({ topic: 'alerts', since: 'all', id: ' ' });
      expect(sent[0]?.searchParams.has('id')).toBe(false);
      expect(structured.messages).toHaveLength(2);
      for (const m of structured.messages) {
        expect(m.message).toHaveLength(500);
        expect(m.messageTruncated).toBe(220);
      }
      expect(structured.appliedFilters).toBeUndefined();
    });

    it.each([
      ['title', { title: ' ' }],
      ['message', { message: '  ' }],
      ['tags', { tags: [' ', '\t'] }],
    ])('neither sends nor echoes a whitespace `%s` filter', async (key, filter) => {
      store = range(1, 2);
      const { structured, text } = await call({ topic: 'alerts', since: 'all', ...filter });
      expect(sent[0]?.searchParams.has(key)).toBe(false);
      expect(structured.appliedFilters).toBeUndefined();
      expect(structured.notice).toBeUndefined();
      expect(text).not.toContain('**Filters:**');
    });

    it('trims filter values the way ntfy does, and echoes the trimmed values that were sent', async () => {
      await call({
        topic: 'alerts',
        since: 'all',
        title: ' Backup ',
        message: ' done\t',
        tags: [' warning ', ' ', 'disk'],
      });
      const q = sent[0]?.searchParams;
      expect(q?.get('title')).toBe('Backup');
      expect(q?.get('message')).toBe('done');
      expect(q?.get('tags')).toBe('warning,disk');
      const { structured } = await call({
        topic: 'alerts',
        since: 'all',
        title: ' Backup ',
        tags: [' warning ', ' ', 'disk'],
      });
      expect(structured.appliedFilters).toEqual({ title: 'Backup', tags: ['warning', 'disk'] });
    });

    it('still pins one message, sends the trimmed `id`, and lifts the body cap for a padded `id`', async () => {
      store = [env(1, 'e'.repeat(720)), env(2, 'e'.repeat(720))];
      const { structured } = await call({ topic: 'alerts', since: 'all', id: ' m002 ' });
      expect(sent[0]?.searchParams.get('id')).toBe('m002');
      expect(ids(structured.messages)).toEqual(['m002']);
      expect(structured.messages[0]?.message).toHaveLength(720);
      expect(structured.appliedFilters).toEqual({ id: 'm002' });
    });

    it('advertises only `since` forms ntfy accepts, and no unknown-ID failure', () => {
      const since = z.toJSONSchema(ntfyFetchMessages.input, { io: 'input' }) as unknown as {
        properties: { since: { description: string } };
      };
      expect(since.properties.since.description).not.toMatch(/`1d`/);
      expect(since.properties.since.description).toContain('`24h`');
      expect(since.properties.since.description).toContain('whole cache');
      const entry = ntfyFetchMessages.errors?.find((e) => e.reason === 'invalid_since');
      expect(entry?.when).not.toMatch(/unknown message ID/i);
      expect(entry?.recovery).not.toMatch(/`1d`/);
    });
  });

  describe('`cursor` paging (#27)', () => {
    it('walks a 105-message window from the default call: 1–100, then 101–105, no skips or repeats', async () => {
      store = range(1, 105);
      const { first, pages, seen } = await walk({ topic: 'alerts', since: 'all', limit: 100 });

      expect(ids(first.messages)).toEqual(ids(range(6, 105)));
      expect(first).toMatchObject({
        count: 100,
        totalCount: 105,
        truncated: true,
        nextCursor: 'm001',
      });
      expect(pages.map((p) => p.count)).toEqual([100, 5]);
      expect(ids(pages[0]!.messages)).toEqual(ids(range(1, 100)));
      expect(ids(pages[1]!.messages)).toEqual(ids(range(101, 105)));
      expect(pages[1]).not.toHaveProperty('nextCursor');
      expect(seen).toEqual(ids(store));
    });

    it.each([
      [105, [100, 5]],
      [250, [100, 100, 50]],
    ])(
      'serves `limit` 500 as 100 per page and walks a %i-message window in pages of %j',
      async (n, sizes) => {
        store = range(1, n);
        const { first, pages, seen } = await walk({ topic: 'alerts', since: 'all', limit: 500 });
        expect(first).toMatchObject({ count: 100, totalCount: n, nextCursor: 'm001' });
        expect(first.notice).toContain('at most 100');
        expect(first.notice).not.toMatch(/Raise `limit`|raise `limit`/);
        expect(pages.map((p) => p.count)).toEqual(sizes);
        expect(seen).toEqual(ids(store));
        expect(new Set(seen).size).toBe(seen.length);
      },
    );

    it('walks a 250-message window at the default `limit` 20 across 13 pages', async () => {
      store = range(1, 250);
      const { pages, seen } = await walk({ topic: 'alerts', since: 'all' });
      expect(pages).toHaveLength(13);
      expect(pages.slice(0, 12).every((p) => p.count === 20 && p.truncated)).toBe(true);
      expect(pages[12]).toMatchObject({ count: 10, totalCount: 250, truncated: true });
      expect(seen).toEqual(ids(store));
    });

    it('neither skips nor repeats when messages arrive between pages, and a late scheduled delivery lands in time order', async () => {
      store = range(1, 45);
      const { pages, seen } = await walk({ topic: 'alerts', since: 'all' }, (page) => {
        if (page === 1) store.push(env(46), env(47));
        // A scheduled message is delivered with its delivery time, after everything cached.
        if (page === 2) store.push({ ...env(48), message: 'scheduled' });
      });
      expect(seen).toEqual(ids(range(1, 48)));
      expect(new Set(seen).size).toBe(48);
      expect(pages.at(-1)).not.toHaveProperty('nextCursor');
      expect(ids(pages.at(-1)!.messages).at(-1)).toBe('m048');
    });

    it('does not shift later pages when messages older than the cursor expire between pages', async () => {
      store = range(1, 60);
      const { pages, seen } = await walk({ topic: 'alerts', since: 'all' }, (page) => {
        if (page === 1) store = store.filter((m) => m.time > env(15).time);
      });
      expect(ids(pages[0]!.messages)).toEqual(ids(range(1, 20)));
      expect(ids(pages[1]!.messages)).toEqual(ids(range(21, 40)));
      expect(ids(pages[2]!.messages)).toEqual(ids(range(41, 60)));
      expect(pages[1]!.totalCount).toBe(45);
      expect(seen).toEqual(ids(range(1, 60)));
    });

    it('fails a stale cursor with `cursor_not_found` on both surfaces and returns no window', async () => {
      store = range(1, 30);
      const { result, text } = await call({
        topic: 'alerts',
        since: 'all',
        cursor: 'gone12345678',
      });
      expect(result.isError).toBe(true);
      const error = (
        result.structuredContent as {
          error: { code: number; message: string; data: Record<string, unknown> };
        }
      ).error;
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data.reason).toBe('cursor_not_found');
      expect(error.message).toContain('gone12345678');
      expect(error.data.recovery).toMatchObject({
        hint: expect.stringMatching(/without `cursor`[\s\S]*widen `since`/),
      });
      expect(text).toContain('reason cursor_not_found');
      expect(text).not.toContain('m001');
    });

    it('fails with `cursor_not_found` once the cursor message itself has expired', async () => {
      store = range(1, 30);
      const first = await call({ topic: 'alerts', since: 'all' });
      expect(first.structured.nextCursor).toBe('m001');
      store = store.slice(5);
      const { result } = await call({ topic: 'alerts', since: 'all', cursor: 'm001' });
      expect(result.isError).toBe(true);
      expect(
        (result.structuredContent as { error: { data: { reason: string } } }).error.data.reason,
      ).toBe('cursor_not_found');
    });

    it('never carries `nextCursor` on an `id`-pinned call, and returns its whole body', async () => {
      store = [...range(1, 149), env(150, 'f'.repeat(720))];
      const { structured } = await call({ topic: 'alerts', since: 'all', id: 'm150' });
      expect(structured).toMatchObject({ count: 1, totalCount: 1, truncated: false });
      expect(structured).not.toHaveProperty('nextCursor');
      expect(structured.messages[0]?.message).toHaveLength(720);
    });

    it('carries no `nextCursor` and no notice when the window fits within `limit`', async () => {
      store = range(1, 7);
      const { structured, text } = await call({ topic: 'alerts', since: 'all', limit: 7 });
      expect(structured).toMatchObject({ count: 7, totalCount: 7, truncated: false });
      expect(structured).not.toHaveProperty('nextCursor');
      expect(structured).not.toHaveProperty('notice');
      expect(text).toContain('**totalCount:** 7');
      expect(text).not.toContain('nextCursor');
    });

    it('keeps the empty-result notice and carries no `nextCursor` on an empty window', async () => {
      const { structured } = await call({ topic: 'alerts', since: 'all' });
      expect(structured).toMatchObject({ count: 0, totalCount: 0, truncated: false });
      expect(structured).not.toHaveProperty('nextCursor');
      expect(structured.notice).toContain('No messages on topic `alerts`');
    });

    it('treats a blank `cursor` as unset', async () => {
      store = range(1, 30);
      const { structured } = await call({ topic: 'alerts', since: 'all', cursor: '  ' });
      expect(ids(structured.messages)).toEqual(ids(range(11, 30)));
      expect(structured.nextCursor).toBe('m001');
    });

    describe('under a duration `since`, whose lower bound moves with ntfy’s clock', () => {
      const start = String(env(1).time);
      const cursorSince = () => sent.slice(1).map((u) => u.searchParams.get('since'));

      it('reaches every page while the bound moves past the walk’s first message', async () => {
        store = range(1, 45);
        now = env(45).time + 5;
        const { first, pages, seen } = await walk({ topic: 'alerts', since: '66s' }, () => {
          now = (now as number) + 20;
        });
        expect(first).toMatchObject({ since: '66s', totalCount: 45, nextCursor: `m001@${start}` });
        expect(pages.map((p) => p.count)).toEqual([20, 20, 5]);
        expect(seen).toEqual(ids(store));
        // ntfy's own clock has by now put m001–m043 outside `66s`; the pages read from the walk's start.
        expect(lowerBound('66s')).toBeGreaterThan(env(43).time);
        expect(cursorSince()).toEqual([start, start, start]);
        expect(pages.map((p) => [p.since, p.totalCount])).toEqual([
          [start, 45],
          [start, 45],
          [start, 45],
        ]);
      });

      it('reaches every page under the default `10m` when every message ages out of it mid-walk', async () => {
        store = range(1, 30);
        now = env(30).time + 1;
        const { first, pages, seen } = await walk({ topic: 'alerts' }, () => {
          now = (now as number) + 590;
        });
        expect(sent[0]?.searchParams.get('since')).toBe('10m');
        expect(first.nextCursor).toBe(`m001@${start}`);
        expect(pages.map((p) => p.count)).toEqual([20, 10]);
        expect(seen).toEqual(ids(store));
        expect(lowerBound('10m')).toBeGreaterThan(env(30).time);
      });

      it('neither skips nor repeats across arrivals and expiry while the bound moves', async () => {
        store = range(1, 45);
        now = env(45).time;
        const { pages, seen } = await walk({ topic: 'alerts', since: '1h' }, (page) => {
          if (page === 1) store.push(env(46), env(47));
          if (page === 2) {
            store = store.filter((m) => m.time > env(15).time);
            now = (now as number) + 3600;
          }
        });
        expect(seen).toEqual(ids(range(1, 47)));
        expect(new Set(seen).size).toBe(47);
        // From the walk's start: m016–m047 are still cached.
        expect(pages.at(-1)).toMatchObject({ count: 7, totalCount: 32 });
      });

      it('fails with `cursor_not_found` once the cursor message itself has expired', async () => {
        store = range(1, 30);
        now = env(30).time;
        const first = await call({ topic: 'alerts', since: '10m' });
        store = store.slice(1);
        const { result } = await call({
          topic: 'alerts',
          since: '10m',
          cursor: first.structured.nextCursor,
        });
        const { error } = result.structuredContent as {
          error: { message: string; data: { reason: string } };
        };
        expect(error.data.reason).toBe('cursor_not_found');
        expect(error.message).toContain(`(since "${start}", where the walk began)`);
      });

      it.each([
        ['30s', true],
        ['1h30m', true],
        ['1.5h', true],
        ['250ms', true],
        ['all', false],
        ['1700000000', false],
        ['abcDEF123456', false],
      ])(
        '`since` %j: the cursor pins the window start only for a duration (%s)',
        async (since, pinned) => {
          store = range(1, 30);
          const first = await call({ topic: 'alerts', since });
          expect(first.structured.nextCursor).toBe(pinned ? `m001@${start}` : 'm001');
          const page = await call({ topic: 'alerts', since, cursor: first.structured.nextCursor });
          expect(page.result.isError).toBeFalsy();
          expect(sent[1]?.searchParams.get('since')).toBe(pinned ? start : since);
          expect(page.structured.since).toBe(pinned ? start : since);
          expect(page.structured.nextCursor).toBe(pinned ? `m021@${start}` : 'm021');
        },
      );

      it('sends a long almost-duration `since` as given and leaves its cursor unpinned', async () => {
        const since = `${'99h'.repeat(25)}x`;
        store = range(1, 30);
        const first = await call({ topic: 'alerts', since });
        expect(sent[0]?.searchParams.get('since')).toBe(since);
        expect(first.structured.nextCursor).toBe('m001');
      });

      it('offers no "drop `cursor`" shortcut on a pinned page, whose window the duration no longer covers', async () => {
        store = range(1, 30);
        now = env(30).time;
        const first = await call({ topic: 'alerts', since: '1m', limit: 10 });
        expect(first.structured.notice).toContain('raise `limit` to 30');
        now = (now as number) + 45;
        const page = await call({
          topic: 'alerts',
          since: '1m',
          limit: 10,
          cursor: first.structured.nextCursor,
        });
        expect(ids(page.structured.messages)).toEqual(ids(range(1, 10)));
        expect(page.structured.notice).toContain(`\`cursor\` set to \`m011@${start}\``);
        expect(page.structured.notice).not.toMatch(/raise `limit`|drop `cursor`/);
      });

      it('accepts a bare message-ID cursor on a duration call and pins the next cursor', async () => {
        store = range(1, 30);
        const { structured } = await call({ topic: 'alerts', since: '1h', cursor: 'm001' });
        expect(sent[0]?.searchParams.get('since')).toBe('1h');
        expect(ids(structured.messages)).toEqual(ids(range(1, 20)));
        expect(structured.nextCursor).toBe(`m021@${start}`);
      });

      it('puts the pinned `since`, the pinned `nextCursor`, and the notice on both surfaces', async () => {
        store = range(1, 150);
        const { result, structured, text } = await call({
          topic: 'alerts',
          since: '10m',
          cursor: `m021@${start}`,
        });
        expect(result.isError).toBeFalsy();
        const success = ntfyFetchMessages.output.extend(ntfyFetchMessages.enrichment ?? {});
        expect(success.parse(structured)).toMatchObject({
          since: start,
          totalCount: 150,
          nextCursor: `m041@${start}`,
        });
        // Enrichment string values render as code literals, so a copied cursor carries no escapes.
        const rendered = readCommonMark(text);
        expect(rendered).toContain(`⟨strong⟩since:⟨/strong⟩ ⟨code_inline:${start}⟩`);
        expect(rendered).toContain(`⟨strong⟩nextCursor:⟨/strong⟩ ⟨code_inline:m041@${start}⟩`);
        expect(structured.notice).toContain(`\`cursor\` set to \`m041@${start}\``);
        expect(structured.notice).toContain('same `topic`, `since`, and filters');
        expect(text).toContain(`\`cursor\` set to \`m041@${start}\``);
      });

      it('teaches the same walk in every surface, and no longer blames a moving `since` for a lost cursor', () => {
        const input = JSON.stringify(z.toJSONSchema(ntfyFetchMessages.input, { io: 'input' }));
        const enrichment = JSON.stringify(
          z.toJSONSchema(z.object(ntfyFetchMessages.enrichment ?? {}), { io: 'output' }),
        );
        expect(input).toMatch(/`cursor`[^"]*duration/);
        expect(enrichment).toMatch(/verbatim/);
        expect(enrichment).toMatch(/where the walk began/);
        const entry = ntfyFetchMessages.errors?.find((e) => e.reason === 'cursor_not_found');
        expect(entry?.when).not.toMatch(/duration `since` moved/);
        expect(entry?.recovery).toMatch(/without `cursor`/);
      });
    });

    describe('a window that repeats a message ID', () => {
      it('ends the walk, returning each ID once, instead of naming the same cursor again', async () => {
        store = [env(1), env(2), { ...env(2), message: 'repeat' }, env(3)];
        const { first, pages, seen } = await walk({ topic: 'alerts', since: 'all', limit: 1 });
        expect(first).toMatchObject({ count: 1, totalCount: 3, nextCursor: 'm001' });
        expect(seen).toEqual(['m001', 'm002', 'm003']);
        expect(pages.at(-1)).not.toHaveProperty('nextCursor');
      });

      it('counts and lists a repeated ID once without `cursor` too', async () => {
        store = [env(1), env(1), env(2)];
        const { structured } = await call({ topic: 'alerts', since: 'all' });
        expect(ids(structured.messages)).toEqual(['m001', 'm002']);
        expect(structured).toMatchObject({ count: 2, totalCount: 2, truncated: false });
      });
    });

    describe('boundaries', () => {
      it('a 1-message window: no cursor without one, and a cursor on that message returns it alone', async () => {
        store = range(1, 1);
        const plain = await call({ topic: 'alerts', since: 'all' });
        expect(plain.structured).toMatchObject({ count: 1, totalCount: 1, truncated: false });
        expect(plain.structured).not.toHaveProperty('nextCursor');
        const paged = await call({ topic: 'alerts', since: 'all', cursor: 'm001' });
        expect(ids(paged.structured.messages)).toEqual(['m001']);
        expect(paged.structured).toMatchObject({ count: 1, totalCount: 1, truncated: false });
        expect(paged.structured).not.toHaveProperty('nextCursor');
        expect(paged.structured).not.toHaveProperty('notice');
      });

      it('a cursor naming the last message returns just that message as the last page', async () => {
        store = range(1, 105);
        const { structured } = await call({
          topic: 'alerts',
          since: 'all',
          cursor: 'm105',
          limit: 100,
        });
        expect(ids(structured.messages)).toEqual(['m105']);
        expect(structured).toMatchObject({ count: 1, totalCount: 105, truncated: true });
        expect(structured).not.toHaveProperty('nextCursor');
        expect(structured.notice).toContain('Last page: this message ends the window');
        expect(structured.notice).not.toContain('`cursor` set to');
      });

      it('a cursor naming the first message starts the window, inclusive', async () => {
        store = range(1, 105);
        const { structured } = await call({
          topic: 'alerts',
          since: 'all',
          cursor: 'm001',
          limit: 100,
        });
        expect(ids(structured.messages)).toEqual(ids(range(1, 100)));
        expect(structured.nextCursor).toBe('m101');
      });
    });

    describe('enrichment through the production parse', () => {
      it.each([
        ['the zero-result page', 0, {}, { totalCount: 0, truncated: false }, undefined],
        ['the under-cap page', 12, {}, { totalCount: 12, truncated: false }, undefined],
        ['the default truncated page', 150, {}, { totalCount: 150, truncated: true }, 'm001'],
        [
          'a middle cursor page',
          150,
          { cursor: 'm021' },
          { totalCount: 150, truncated: true },
          'm041',
        ],
        [
          'the last cursor page',
          150,
          { cursor: 'm141' },
          { totalCount: 150, truncated: true },
          undefined,
        ],
      ])('%s', async (_label, n, extra, expected, next) => {
        store = range(1, n);
        const { result, structured, text } = await call({
          topic: 'alerts',
          since: 'all',
          ...extra,
        });
        expect(result.isError).toBeFalsy();
        expect(structured).toMatchObject(expected);
        expect(structured.truncated).toBe(structured.count < structured.totalCount);
        expect(text).toContain(`**totalCount:** ${n}`);
        if (next) {
          expect(structured.nextCursor).toBe(next);
          expect(readCommonMark(text)).toContain(
            `⟨strong⟩nextCursor:⟨/strong⟩ ⟨code_inline:${next}⟩`,
          );
        } else {
          expect(structured).not.toHaveProperty('nextCursor');
          expect(text).not.toContain('nextCursor:');
        }
      });

      it.each([
        ['an empty window', 0, {}, false],
        ['a window that fits', 7, {}, false],
        ['a truncated window', 150, {}, false],
        ['a cursor page', 150, { cursor: 'm021' }, false],
        ['an `id`-pinned call', 150, { id: 'm150' }, false],
        ['a window ntfy capped', 105, {}, true],
      ])(
        'requires `totalCount` in the success schema, and %s carries it',
        async (_label, n, extra, cap) => {
          store = range(1, n);
          capHeader = cap;
          const { result, structured } = await call({ topic: 'alerts', since: 'all', ...extra });
          expect(result.isError).toBeFalsy();
          // The schema the framework parses a success against: output plus enrichment.
          const success = ntfyFetchMessages.output.extend(ntfyFetchMessages.enrichment ?? {});
          expect(structured.totalCount).toBeTypeOf('number');
          expect(success.parse(structured)).toMatchObject({ totalCount: structured.totalCount });
          const { totalCount: _dropped, ...withoutTotal } = structured;
          expect(success.safeParse(withoutTotal).success).toBe(false);
        },
      );
    });

    describe('truncation notice', () => {
      it('names the literal `nextCursor`, the repeat rule, and `totalCount`, without dead-end levers', async () => {
        store = range(1, 150);
        const { structured, text } = await call({ topic: 'alerts', since: 'all', limit: 20 });
        const notice = structured.notice ?? '';
        expect(notice).toContain('`cursor` set to `m001`');
        expect(notice).toContain('same `topic`, `since`, and filters');
        expect(notice).toContain('150');
        expect(notice).toContain('`totalCount`');
        expect(notice).not.toMatch(/tighter `since`|message `id`|Raise `limit`|raise `limit`/);
        expect(text).toContain('`cursor` set to `m001`');
      });

      it('suggests raising `limit` only when it is below 100 and fewer than 100 matched', async () => {
        store = range(1, 30);
        const under = await call({ topic: 'alerts', since: 'all', limit: 10 });
        expect(under.structured.notice).toContain('raise `limit` to 30');
        expect(under.structured.notice).toContain('`cursor` set to `m001`');

        store = range(1, 100);
        const atCap = await call({ topic: 'alerts', since: 'all', limit: 10 });
        expect(atCap.structured.notice).not.toContain('raise `limit`');
      });

      it('names the next cursor on a middle cursor page', async () => {
        store = range(1, 150);
        const { structured } = await call({ topic: 'alerts', since: 'all', cursor: 'm021' });
        expect(structured.notice).toContain('`cursor` set to `m041`');
        expect(structured.notice).toContain('150');
      });

      it('counts what ntfy returned and still pages inside a window ntfy capped', async () => {
        store = range(1, 105);
        capHeader = true;
        const { first, pages, seen } = await walk({ topic: 'alerts', since: 'all', limit: 100 });
        expect(first).toMatchObject({
          totalCount: 105,
          upstreamTruncated: true,
          nextCursor: 'm001',
        });
        expect(first.notice).toContain('ntfy returned 105 messages');
        expect(first.notice).not.toContain('matched');
        expect(first.notice).toContain('ntfy capped this replay');
        expect(pages.map((p) => p.count)).toEqual([100, 5]);
        expect(pages[1]!.notice).toContain('ntfy capped this replay');
        expect(seen).toEqual(ids(store));
      });
    });

    it('steers paging to `cursor` in every description that used to offer `since`', () => {
      const json = JSON.stringify(z.toJSONSchema(ntfyFetchMessages.output, { io: 'output' }));
      expect(ntfyFetchMessages.description).not.toMatch(/as `since` to page/);
      expect(ntfyFetchMessages.description).toContain('`cursor`');
      expect(json).not.toMatch(/`since` to paginate/);
      expect(json).toContain('`cursor`');
    });
  });
});

describe('isDuration on caller-sized `since` text', () => {
  /** Large-input CPU budget; a run past it already fails, so the remaining runs are skipped. */
  const CPU_LIMIT_MS = 50;

  /** Thread CPU milliseconds for `reps` calls on `input`: the least of up to three runs. */
  function cpuMs(input: string, reps: number): number {
    let least = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const start = process.threadCpuUsage();
      for (let i = 0; i < reps; i++) isDuration(input);
      const { user, system } = process.threadCpuUsage(start);
      least = Math.min(least, (user + system) / 1000);
      if (least > CPU_LIMIT_MS * reps) break;
    }
    return least;
  }

  /**
   * Each case spans 64× in length; a linear matcher grows about 64× and a
   * quadratic one about 4096×. The segment case stays under ~80k characters,
   * where Bun's regex engine leaves its JIT for a slower interpreter.
   */
  it.each([
    ['repeated `99h` segments', (chars: number) => `${'99h'.repeat(chars / 3)}x`, 900],
    ['one long digit run', (chars: number) => `${'9'.repeat(chars)}x`, 5_000],
  ])('rejects %s in time linear in their length', (_shape, make, small) => {
    const large = small * 64;
    expect(isDuration(make(small))).toBe(false);
    // 64 short calls read as many characters as one long call, so both runs are long enough to time.
    const smallPerCallMs = cpuMs(make(small), 64) / 64;
    const largeMs = cpuMs(make(large), 1);
    expect(largeMs).toBeLessThan(CPU_LIMIT_MS);
    expect(largeMs / smallPerCallMs).toBeLessThan(256);
  });
});

describe('the `topic` pattern on caller-sized text (#41)', () => {
  const topic = ntfyFetchMessages.input.shape.topic;
  /** Per-call CPU budget at every size; a run past it already fails, so the remaining runs are skipped. */
  const CPU_LIMIT_MS = 50;

  /** Thread CPU milliseconds per schema parse of `input` over `reps` parses: the least of up to three runs. */
  function cpuMsPerCall(input: string, reps: number): number {
    let least = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const start = process.threadCpuUsage();
      for (let i = 0; i < reps; i++) topic.safeParse(input);
      const { user, system } = process.threadCpuUsage(start);
      least = Math.min(least, (user + system) / 1000 / reps);
      if (least > CPU_LIMIT_MS) break;
    }
    return least;
  }

  /**
   * Each shape doubles from `small` to 64× `small`, checking the per-call budget
   * at each size before the next, so a quadratic regression fails at its first
   * oversized step instead of running the 64× input. A linear matcher grows about
   * 64× across the span and a quadratic one about 4096×. Shapes the pattern
   * scans end to end stay under ~80k characters, where Bun's regex engine leaves
   * its JIT for a slower interpreter; the digit run carries the 5k → 320k span.
   */
  it.each([
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`, 5_000],
    ['line breaks throughout', (n: number) => '  \r\n'.repeat(n / 4), 5_000],
    ['one long digit run', (n: number) => '9'.repeat(n), 5_000],
    [
      '64-character topics closed by a bad character',
      (n: number) => `${`${'a'.repeat(64)},`.repeat(Math.floor(n / 65))}!`,
      1_250,
    ],
    [
      'one-character topics closed by a bad character',
      (n: number) => `${'a,'.repeat(n / 2)}!`,
      1_250,
    ],
  ])('rejects %s in time linear in its length', (_shape, make, small) => {
    expect(topic.safeParse(make(small)).success).toBe(false);
    const smallMs = cpuMsPerCall(make(small), 64);
    let largeMs = smallMs;
    for (let n = small * 2; n <= small * 64; n *= 2) {
      largeMs = cpuMsPerCall(make(n), Math.max(1, (64 * small) / n));
      expect(largeMs).toBeLessThan(CPU_LIMIT_MS);
    }
    expect(largeMs / smallMs).toBeLessThan(256);
  });
});
