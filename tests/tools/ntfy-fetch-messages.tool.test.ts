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
 * line or as a mid-stream ntfy error line (`rate_limited`), an answer that
 * never reached an ntfy topic route (`not_ntfy_endpoint`), and ntfy's
 * `upstreamTruncated` replay cap. Against a fake ntfy window: blank and
 * whitespace `since`/filter normalization as sent upstream, and `cursor`
 * paging — full-window walks, arrivals and expiry between pages, stale
 * cursors (`cursor_not_found`), boundaries, and the `totalCount` / `nextCursor`
 * enrichment and notice on both surfaces. Message rows on both surfaces: the
 * body cut before a surrogate pair, `icon`, body `encoding`, action ids, and
 * queued rows marked `scheduled` against ntfy's `Date` or a faked local clock.
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
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
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

/** Every text block of a tool result, joined by a newline. */
function textOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
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

  it('serves a `limit` above the per-call cap as 100 and names the requested and served values', async () => {
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
    expect(e.notice).toContain('`limit` 500 was served as 100');
    expect(e.notice).toContain('older 50');
  });

  it('accepts any positive `limit` with no ceiling of its own, clamping it to the cap', async () => {
    const svc = freshService();
    stubFetch(
      svc,
      Array.from({ length: 150 }, (_, i) => ({
        id: `m${i + 1}`,
        time: i + 1,
        event: 'message' as const,
        topic: 'alerts',
        message: `body ${i + 1}`,
      })),
    );

    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts', since: '1h', limit: 5000 });
    const result = await ntfyFetchMessages.handler(input, ctx);

    expect(result.messages).toHaveLength(100);
    expect(getEnrichment(ctx).notice).toContain('`limit` 5000 was served as 100');
    expect(ntfyFetchMessages.input.safeParse({ topic: 'alerts', limit: 0 }).success).toBe(false);
    const schema = z.toJSONSchema(ntfyFetchMessages.input, { io: 'input' }) as unknown as {
      properties: { limit: Record<string, unknown> };
    };
    expect(schema.properties.limit).toMatchObject({ type: 'integer', minimum: 1, default: 20 });
    expect(schema.properties.limit).not.toHaveProperty('maximum');
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

  it('truncates long message bodies to 500 UTF-16 code units and reports the dropped count', async () => {
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

  it('falls back to a message without the topic when ntfy gave no `forbidden_topic` explanation', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'fetch').mockRejectedValue(
      forbidden('', { status: 403, body: '{"code":40301,"http":403,"error":"forbidden"}' }),
    );
    const result = await runToolContract(ntfyFetchMessages, { topic: '_secret_' });
    const { error } = result.structuredContent as {
      error: { message: string; data: { reason?: string } };
    };
    expect(error).toMatchObject({
      message: 'ntfy refused access to the topic.',
      data: { reason: 'forbidden_topic' },
    });
    expect(
      readCommonMark(result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')),
    ).toContain('Error: ntfy refused access to the topic.');
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
    expect(text).toContain('_(200 more UTF-16 code units)_');
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

  const NOT_NTFY_HINT = ntfyFetchMessages.errors?.find((e) => e.reason === 'not_ntfy_endpoint')
    ?.recovery as string;

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
    // The closing trailer names the wait: the header's string, as a code span.
    expect(readCommonMark(textOf(result))).toContain(
      '(reason rate_limited · retryable · retry after ⟨code_inline:40⟩',
    );
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
      expect(text).toContain(
        'reason upstream_unreachable · retryable · retry after ⟨code_inline:120⟩',
      );
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

  it('suggests a wider `since` window only when the window is not already `all`', async () => {
    stubUpstream(poll(''));
    const whole = await runToolContract(ntfyFetchMessages, { topic: 'alerts', since: 'all' });
    expect((whole.structuredContent as { notice?: string }).notice).toBe(
      'No messages on topic `alerts` (since `all`). That window is everything ntfy still caches, so verify the topic name. A delayed message ntfy has not delivered yet is returned only with `scheduled: true`. A message published in the last few seconds may not be returned yet, so retry shortly before concluding it is missing.',
    );
    const filtered = await runToolContract(ntfyFetchMessages, {
      topic: 'alerts',
      since: 'all',
      priority: [5],
    });
    const filteredNotice = (filtered.structuredContent as { notice?: string }).notice;
    expect(filteredNotice).toContain('so drop filters or verify the topic name.');
    expect(filteredNotice).not.toContain('wider');
    const recent = await runToolContract(ntfyFetchMessages, { topic: 'alerts', since: '1h' });
    expect((recent.structuredContent as { notice?: string }).notice).toContain(
      'Try a wider `since` window or verify the topic name.',
    );
  });

  it('points an empty result at `scheduled: true` only when the call did not set it', async () => {
    stubUpstream(poll(''));
    const without = await runToolContract(ntfyFetchMessages, { topic: 'alerts' });
    expect((without.structuredContent as { notice?: string }).notice).toContain(
      'is returned only with `scheduled: true`',
    );
    const withFlag = await runToolContract(ntfyFetchMessages, { topic: 'alerts', scheduled: true });
    expect((withFlag.structuredContent as { notice?: string }).notice).not.toContain(
      '`scheduled: true`',
    );
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
        // ntfy's words reach the caller through the message; the captured body stays on the server.
        expect(error.data).toMatchObject({
          status: 400,
          operation: 'fetch',
          topic: 'alerts,metrics',
        });
        expect(error.data).not.toHaveProperty('body');
        expect(error.data).not.toHaveProperty('responseBody');
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
      // Something other than ntfy answered (#55): its own reason, never the auth one.
      expect(error.data.reason).toBe('not_ntfy_endpoint');
      expect(error.data.recovery).toEqual({ hint: NOT_NTFY_HINT });
      // The proxy's page stays on the server, off both surfaces.
      expect(error.data).not.toHaveProperty('body');
      expect(error.data).not.toHaveProperty('responseBody');
      expect(error.message).toContain('HTTP 403');
      const rendered = readCommonMark(textOf(result));
      expect(rendered).toContain('HTTP 403');
      expect(rendered).not.toContain('forbidden_topic');
      expect(rendered).not.toContain('NTFY_AUTH_TOKEN');
      expect(rendered).not.toContain('nginx');
    });
  });

  /**
   * #55: an answer that did not come from an ntfy topic route. ntfy.sh answers
   * a `docs` poll with a redirect to its docs site, whose HTML 404 has no ntfy
   * envelope; ntfy's own route miss is its 40401.
   */
  describe('not_ntfy_endpoint (#55)', () => {
    it.each([
      [
        "the docs site's HTML 404 to a `docs` poll",
        () =>
          new Response(
            '<!doctype html><html><head><title>404</title></head><body>Not found</body></html>',
            {
              status: 404,
              statusText: 'Not Found',
              headers: { 'content-type': 'text/html; charset=utf-8' },
            },
          ),
        'ntfy.test returned HTTP 404 Not Found.',
      ],
      [
        "ntfy's own 40401",
        () =>
          new Response('{"code":40401,"http":404,"error":"page not found"}', {
            status: 404,
            statusText: 'Not Found',
            headers: { 'content-type': 'application/json' },
          }),
        'ntfy returned HTTP 404 Not Found: page not found',
      ],
    ])('fails %s with its declared recovery on both surfaces', async (_label, respond, message) => {
      const upstream = stubUpstream(respond);
      const result = await runToolContract(ntfyFetchMessages, { topic: 'docs' });
      expect(upstream).toHaveBeenCalledTimes(1);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.message).toBe(message);
      expect(error.data).toMatchObject({
        reason: 'not_ntfy_endpoint',
        retryable: false,
        recovery: { hint: NOT_NTFY_HINT },
      });
      expect(error.data).not.toHaveProperty('body');
      expect(error.data).not.toHaveProperty('responseBody');
      for (const term of [
        '`base_url`',
        '`NTFY_BASE_URL`',
        'proxy',
        '`docs`',
        '`static`',
        '`file`',
      ]) {
        expect(NOT_NTFY_HINT).toContain(term);
      }
      const rendered = readCommonMark(textOf(result));
      expect(rendered).toContain(`Error: ${message}`);
      expect(rendered).toContain(`Recovery: ${NOT_NTFY_HINT}`);
      expect(rendered).toContain('(reason not_ntfy_endpoint · not retryable)');
      // The answering page stays on the server, off both surfaces.
      expect(JSON.stringify(result)).not.toContain('<title>');
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
      expect(text).toMatch(/\n````\n_\(\d+ more UTF-16 code units\)_\n\n### `m2`/);
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
        'Cursor "gone`*id*" names none of the 1 messages in the fetched window (since "all").';
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
        expect(first.notice).toContain('`limit` 500 was served as 100');
        expect(first.notice).not.toMatch(/Raise `limit`|raise `limit`/);
        expect(pages[0]?.notice).toContain('`limit` 500 was served as 100');
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

describe('ntfyFetchMessages `limit` clamp wiring', () => {
  const FLAG = 'NTFY_CLAMP_LIMITS';
  const window = Array.from({ length: 150 }, (_, i) => ({
    id: `m${i + 1}`,
    time: i + 1,
    event: 'message' as const,
    topic: 'alerts',
  }));
  /** The `limit` property as `tools/list` advertises it. */
  const advertisedLimit = () =>
    (
      z.toJSONSchema(ntfyFetchMessages.input, { io: 'input' }) as unknown as {
        properties: { limit: Record<string, unknown> };
      }
    ).properties.limit;
  /** The clamp's log line, read off the mock logger. */
  const clampLog = (ctx: ReturnType<typeof createMockContext>) =>
    (ctx.log as MockContextLogger).calls.filter((c) => c.msg === 'Clamped limit');

  beforeEach(() => {
    resetNtfyService();
    delete process.env[FLAG];
    process.env.NTFY_BASE_URL = 'https://ntfy.test';
    resetServerConfig();
  });
  afterEach(() => {
    delete process.env[FLAG];
    delete process.env.NTFY_BASE_URL;
    resetServerConfig();
    resetNtfyService();
    vi.restoreAllMocks();
  });

  it('clamps a `limit` above 100 to 100 and logs it under this tool', async () => {
    stubFetch(freshService(), window);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const result = await ntfyFetchMessages.handler(
      ntfyFetchMessages.input.parse({ topic: 'alerts', since: 'all', limit: 101 }),
      ctx,
    );

    expect(result.messages).toHaveLength(100);
    expect(getEnrichment(ctx).notice).toContain('`limit` 101 was served as 100');
    expect(clampLog(ctx)).toEqual([
      {
        level: 'info',
        msg: 'Clamped limit',
        data: { tool: 'ntfy_fetch_messages', requested: 101, applied: 100 },
      },
    ]);
  });

  it('leaves a `limit` of 100 alone, with no clamp log and no served-as wording', async () => {
    stubFetch(freshService(), window);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    await ntfyFetchMessages.handler(
      ntfyFetchMessages.input.parse({ topic: 'alerts', since: 'all', limit: 100 }),
      ctx,
    );

    expect(getEnrichment(ctx).notice).toContain('`limit` was 100');
    expect(getEnrichment(ctx).notice).not.toContain('served as');
    expect(clampLog(ctx)).toEqual([]);
  });

  it('advertises no maximum while clamping, and maximum 100 with a parse rejection when NTFY_CLAMP_LIMITS=false', () => {
    expect(advertisedLimit()).not.toHaveProperty('maximum');
    expect(advertisedLimit().description).toMatch(
      /^Client-side cap on returned messages\. Default 20\. One call returns at most 100; a larger value is served as 100, and the notice says so whenever more remain\. Without `cursor`/,
    );

    process.env[FLAG] = 'false';
    resetServerConfig();
    expect(advertisedLimit()).toMatchObject({ type: 'integer', minimum: 1, maximum: 100 });
    expect(advertisedLimit().description).toMatch(
      /^Client-side cap on returned messages\. Default 20\. At most 100 per call\. Without `cursor`/,
    );
    expect(ntfyFetchMessages.input.safeParse({ topic: 'alerts', limit: 101 }).success).toBe(false);
    expect(ntfyFetchMessages.input.safeParse({ topic: 'alerts', limit: 100 }).success).toBe(true);
  });
});

describe('ntfyFetchMessages numeric `since` (#52)', () => {
  const window: NtfyMessage[] = [1, 2, 3].map((n) => ({
    id: `m${n}`,
    time: 1_700_000_000 + n,
    event: 'message' as const,
    topic: 'alerts',
  }));

  beforeEach(() => {
    resetNtfyService();
    process.env.NTFY_BASE_URL = 'https://ntfy.test';
    resetServerConfig();
  });
  afterEach(() => {
    delete process.env.NTFY_BASE_URL;
    resetServerConfig();
    resetNtfyService();
    vi.restoreAllMocks();
  });

  it.each([
    '1794577386000',
    '0001794577386000',
    '+1794577386000',
    ' 1794577386000 ',
    '1000000000000',
    '99999999999999999999',
  ])('rejects %j, 10¹² or more, as `invalid_since` before any request', async (since) => {
    const fetch = stubFetch(freshService(), window);
    const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts', since });

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining(`"${since.trim()}"`),
          data: {
            reason: 'invalid_since',
            recovery: { hint: expect.stringContaining('divide a millisecond timestamp by 1000') },
          },
        },
      },
    });
    const text = readCommonMark(textOf(result));
    expect(text).toContain('divide a millisecond timestamp by 1000');
    expect(text).toContain('reason invalid_since');
    expect(JSON.stringify(result.structuredContent)).not.toContain('alerts');
  });

  it('sends a zero-padded 10-digit timestamp unchanged, with no notice', async () => {
    const fetch = stubFetch(freshService(), window);
    const result = await runToolContract(ntfyFetchMessages, {
      topic: 'alerts',
      since: '0001794636450',
    });

    expect(fetch.mock.calls[0]?.[0].since).toBe('0001794636450');
    expect(result.structuredContent).toMatchObject({ since: '0001794636450', count: 3 });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it.each([
    ['10', '1970-01-01T00:00:10Z'],
    [' 10 ', '1970-01-01T00:00:10Z'],
    ['0000000010', '1970-01-01T00:00:10Z'],
    ['+10', '1970-01-01T00:00:10Z'],
    ['-1', '1969-12-31T23:59:59Z'],
    ['0', '1970-01-01T00:00:00Z'],
    ['999999999', '2001-09-09T01:46:39Z'],
    ['-1794577386000', '-054898-02-09T09:40:00Z'],
  ])(
    'returns the window for %j with a notice naming %s and a duration unit',
    async (since, instant) => {
      const fetch = stubFetch(freshService(), window);
      const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts', since });

      expect(fetch.mock.calls[0]?.[0].since).toBe(since.trim());
      const structured = result.structuredContent as { count: number; notice: string };
      expect(structured.count).toBe(3);
      expect(structured.notice).toBe(
        `ntfy reads \`since\` \`${since.trim()}\` as Unix seconds, ${instant}, not as a duration; for a duration, add a unit, such as \`10m\`.`,
      );
      expect(textOf(result)).toContain(instant);
    },
  );

  it('names a negative timestamp past the range of a date as before 1970', async () => {
    stubFetch(freshService(), window);
    const result = await runToolContract(ntfyFetchMessages, {
      topic: 'alerts',
      since: '-99999999999999999999',
    });

    expect((result.structuredContent as { notice: string }).notice).toContain(
      'as Unix seconds, a time before 1970, not as a duration',
    );
  });

  it('adds no notice at 10⁹, the first 10-digit timestamp', async () => {
    stubFetch(freshService(), window);
    const result = await runToolContract(ntfyFetchMessages, {
      topic: 'alerts',
      since: '1000000000',
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it.each(['123456789012', '000000000010'])(
    'reads the 12-digit %j as a message ID in the notice, beside the rows ntfy returned',
    async (since) => {
      const fetch = stubFetch(freshService(), window);
      const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts', since });

      expect(fetch.mock.calls[0]?.[0].since).toBe(since);
      const structured = result.structuredContent as { count: number; notice: string };
      expect(structured.count).toBe(3);
      expect(structured.notice).toBe(
        `ntfy reads the 12-digit \`since\` \`${since}\` as a message ID, not a Unix timestamp; an ID it does not hold returns the whole cache.`,
      );
      expect(textOf(result)).toContain('as a message ID, not a Unix timestamp');
    },
  );

  it('adds no message-ID notice for a 12-character ID holding a letter', async () => {
    stubFetch(freshService(), window);
    const result = await runToolContract(ntfyFetchMessages, {
      topic: 'alerts',
      since: '12345678901a',
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('puts the timestamp sentence before the empty-window guidance', async () => {
    stubFetch(freshService(), []);
    const result = await runToolContract(ntfyFetchMessages, { topic: 'alerts', since: '10' });
    const notice = (result.structuredContent as { notice: string }).notice;

    expect(notice).toMatch(
      /^ntfy reads `since` `10` as Unix seconds, 1970-01-01T00:00:10Z, not as a duration; .* No messages on topic `alerts`/,
    );
  });

  it('never checks the window start a duration cursor carries, even one of 10¹² or more', async () => {
    const fetch = stubFetch(freshService(), window);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({
      topic: 'alerts',
      since: '10m',
      cursor: 'gone@1794577386000',
    });

    await expect(ntfyFetchMessages.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'cursor_not_found' },
    });
    expect(fetch.mock.calls[0]?.[0].since).toBe('1794577386000');
  });

  it('adds no numeric-`since` sentence to a duration cursor page polled from its 10-digit start', async () => {
    const fetch = stubFetch(freshService(), window);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({
      topic: 'alerts',
      since: '10m',
      cursor: 'm2@1700000001',
      limit: 1,
    });
    await ntfyFetchMessages.handler(input, ctx);

    expect(fetch.mock.calls[0]?.[0].since).toBe('1700000001');
    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('This page holds 1 of the 3');
    expect(notice).not.toContain('Unix seconds');
    expect(notice).not.toContain('message ID');
  });

  it('describes `since` timestamps as seconds and `invalid_since` as covering a value of 10¹² or more', () => {
    const since = (
      z.toJSONSchema(ntfyFetchMessages.input, { io: 'input' }) as unknown as {
        properties: { since: { description: string } };
      }
    ).properties.since.description;
    expect(since).toContain('a Unix timestamp in seconds');
    const entry = ntfyFetchMessages.errors?.find((e) => e.reason === 'invalid_since');
    expect(entry?.when).toContain('1000000000000 or more');
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

/**
 * The message rows themselves, through the real `NtfyService` poll parse and
 * `shapeMessage()` — only the network is stubbed, with rows and headers as
 * ntfy.sh sent them. The shaper's own cases live in its test file; these prove
 * the tool carries each one onto both surfaces.
 */
describe('ntfyFetchMessages message rows', () => {
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

  /** Answers every poll of `ntfy.test` with `envelopes` as NDJSON, plus `headers`. */
  function answer(envelopes: object[], headers: Record<string, string> = {}) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).hostname !== 'ntfy.test') throw new Error(`Unmocked fetch: ${url}`);
      return new Response(envelopes.map((e) => JSON.stringify(e)).join('\n'), {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8', ...headers },
      });
    });
  }

  type Row = Record<string, unknown>;

  /** One call through the tool contract: its rows as the wire carries them, and the `format()` text. */
  async function call(args: Record<string, unknown>) {
    const result = await runToolContract(ntfyFetchMessages, args);
    expect(result.isError).toBeFalsy();
    const { messages } = JSON.parse(JSON.stringify(result.structuredContent)) as {
      messages: Row[];
    };
    return { rows: messages, text: (result.content[0] as { text: string }).text };
  }

  describe('body cap on a surrogate pair (#48)', () => {
    it('cuts before a pair the cap would split, and counts code units, on both surfaces', async () => {
      const body = `${'a'.repeat(499)}🚀${'b'.repeat(20)}`;
      answer([{ id: 'm1', time: 1_700_000_000, event: 'message', topic: 'alerts', message: body }]);
      const { rows, text } = await call({ topic: 'alerts', since: 'all' });
      expect(rows[0]).toMatchObject({ message: 'a'.repeat(499), messageTruncated: 22 });
      expect(text).toContain(`\n${'a'.repeat(499)}\n\`\`\`\n_(22 more UTF-16 code units)_`);
      expect(text.isWellFormed()).toBe(true);
    });
  });

  describe('icon, body encoding, and action ids (#49)', () => {
    /** Two rows exactly as ntfy.sh polled them: one published with every URL field, one with none. */
    const WITH_ICON = {
      id: 'Z4MeYFR5eSYs',
      time: 1_794_636_448,
      expires: 1_794_679_648,
      event: 'message',
      topic: 'alerts',
      title: 'icon raw',
      message: 'icon probe raw',
      tags: ['warning'],
      click: 'https://example.com/click',
      icon: 'https://example.com/icon.png',
      actions: [
        {
          id: 'DAaFWDY6Vc',
          action: 'view',
          label: 'Open',
          clear: false,
          url: 'https://example.com/view',
        },
      ],
      attachment: { name: 'file.jpg', url: 'https://example.com/file.jpg' },
    };
    const WITHOUT_ICON = {
      id: 'izHh1tTm9hD3',
      time: 1_794_636_446,
      expires: 1_794_679_646,
      event: 'message',
      topic: 'alerts',
      message: 'no icon',
    };

    it('carries `icon` and the action `id` onto both surfaces, the icon as a code span', async () => {
      answer([WITH_ICON]);
      const { rows, text } = await call({ topic: 'alerts', since: 'all' });
      expect(rows[0]).toMatchObject({
        icon: 'https://example.com/icon.png',
        actions: [
          {
            id: 'DAaFWDY6Vc',
            action: 'view',
            label: 'Open',
            clear: false,
            url: 'https://example.com/view',
          },
        ],
      });
      expect(text).toBe(
        [
          '### `Z4MeYFR5eSYs` — `message` on `alerts`',
          'Time: 2026-11-14T06:07:28.000Z',
          'Cache expires: 2026-11-14T18:07:28.000Z',
          'Title: `icon raw`',
          'Tags: `warning`',
          'Click action: `https://example.com/click`',
          'Icon: `https://example.com/icon.png`',
          'Attachment: `file.jpg` — `https://example.com/file.jpg`',
          'Actions:',
          '- `{"action":"view","label":"Open","url":"https://example.com/view","clear":false,"id":"DAaFWDY6Vc"}`',
          '',
          '```text',
          'icon probe raw',
          '```',
        ].join('\n'),
      );
    });

    it('omits `icon` on a row ntfy sent without one, on both surfaces', async () => {
      answer([WITHOUT_ICON]);
      const { rows, text } = await call({ topic: 'alerts', since: 'all' });
      expect(rows[0]).not.toHaveProperty('icon');
      expect(rows[0]).not.toHaveProperty('encoding');
      expect(text).not.toContain('Icon:');
      expect(text).not.toContain('encoding');
    });

    it('names a base64 body encoding on both surfaces, leaving the body as ntfy sent it', async () => {
      answer([
        {
          id: 'up1',
          time: 1_794_636_448,
          event: 'message',
          topic: 'alerts',
          message: 'AAECAwQ=',
          encoding: 'base64',
        },
      ]);
      const { rows, text } = await call({ topic: 'alerts', since: 'all' });
      expect(rows[0]).toMatchObject({ message: 'AAECAwQ=', encoding: 'base64' });
      expect(text).toContain('\nBody encoding: `base64`\n\n```text\nAAECAwQ=\n```');
    });
  });

  describe('pending scheduled rows (#51)', () => {
    /** Rows a `scheduled=1` poll of ntfy.sh returned, one delivered and two still queued. */
    const DELIVERED = {
      id: 'tQr2btTcNsiO',
      time: 1_794_636_462,
      event: 'message',
      topic: 'alerts',
      message: 'icon probe mcp',
    };
    const SOON = {
      id: 'x2aOvGFtRodt',
      time: 1_794_636_533,
      event: 'message',
      topic: 'alerts',
      message: 'sched probe short',
    };
    const LATER = {
      id: 'WCyu0oXzagSx',
      time: 1_794_636_755,
      event: 'message',
      topic: 'alerts',
      message: 'sched probe long',
    };
    /** ntfy's `Date` on that poll: 14 s before `SOON` was due. */
    const POLLED_BEFORE_DUE = 'Sat, 14 Nov 2026 06:08:39 GMT';
    /** ntfy's `Date` on a later poll, 4 s past `SOON`'s `time`, while ntfy still held it. */
    const POLLED_AFTER_DUE = 'Sat, 14 Nov 2026 06:08:57 GMT';

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Fake this server's clock (only `Date`, so the poll's timers run as usual). */
    function thisServerClockAt(iso: string) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(iso));
    }

    it("marks rows due after ntfy's `Date` and labels their time `Delivers:`, on both surfaces", async () => {
      // Every row is in this server's future, so only ntfy's `Date` leaves the first unmarked.
      thisServerClockAt('2000-01-01T00:00:00Z');
      answer([DELIVERED, SOON, LATER], { date: POLLED_BEFORE_DUE });
      const { rows, text } = await call({ topic: 'alerts', since: 'all', scheduled: true });
      expect(rows.map((r) => r.scheduled)).toEqual([undefined, true, true]);
      expect(text).toContain(
        '### `tQr2btTcNsiO` — `message` on `alerts`\nTime: 2026-11-14T06:07:42.000Z\n',
      );
      expect(text).toContain(
        '### `x2aOvGFtRodt` — `message` on `alerts`\nDelivers: 2026-11-14T06:08:53.000Z (scheduled)\n',
      );
      expect(text).toContain(
        '### `WCyu0oXzagSx` — `message` on `alerts`\nDelivers: 2026-11-14T06:12:35.000Z (scheduled)\n',
      );
    });

    it("leaves a row due at or before ntfy's `Date` unmarked, even one ntfy still holds", async () => {
      thisServerClockAt('2000-01-01T00:00:00Z');
      const dueNow = { ...LATER, id: 'dueNow000000', time: 1_794_636_537 };
      answer([SOON, dueNow, LATER], { date: POLLED_AFTER_DUE });
      const { rows, text } = await call({ topic: 'alerts', since: 'all', scheduled: true });
      expect(rows.map((r) => r.scheduled)).toEqual([undefined, undefined, true]);
      expect(text).toContain(
        '### `x2aOvGFtRodt` — `message` on `alerts`\nTime: 2026-11-14T06:08:53.000Z\n',
      );
      expect(text).toContain(
        '### `dueNow000000` — `message` on `alerts`\nTime: 2026-11-14T06:08:57.000Z\n',
      );
    });

    it('marks nothing on a call without `scheduled: true`, whatever the clocks say', async () => {
      thisServerClockAt('2000-01-01T00:00:00Z');
      answer([DELIVERED, SOON, LATER], { date: POLLED_BEFORE_DUE });
      const { rows, text } = await call({ topic: 'alerts', since: 'all' });
      expect(rows).toHaveLength(3);
      for (const r of rows) expect(r).not.toHaveProperty('scheduled');
      expect(text).not.toContain('Delivers:');
      expect(text).not.toContain('scheduled');
    });

    it.each([
      ['sends no `Date`', {}],
      ['sends a `Date` it cannot parse', { date: 'not a date' }],
    ])("falls back to this server's clock when ntfy %s", async (_case, headers) => {
      // This server's clock where ntfy's was on the first poll; the real clock is past every row.
      thisServerClockAt('2026-11-14T06:08:39Z');
      answer([DELIVERED, SOON, LATER], headers);
      const { rows } = await call({ topic: 'alerts', since: 'all', scheduled: true });
      expect(rows.map((r) => r.scheduled)).toEqual([undefined, true, true]);
    });
  });
});
