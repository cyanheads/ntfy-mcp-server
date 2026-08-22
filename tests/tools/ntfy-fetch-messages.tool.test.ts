/**
 * @fileoverview Tests for `ntfy_fetch_messages` — open/keepalive filtering,
 * newest-first limit truncation, message-body truncation and the untruncated
 * single-message (`id`) path plus its empty-`id` fallback, the priority
 * schema's single-node validation,
 * sparse upstream payloads (per checklist), error mapping (forbidden /
 * invalid_since / upstream_unreachable / generic rethrow), default-topic
 * resolution, base_url override and its scheme validation, enrichment
 * (topic/since/count/truncated/filters/notice), and format() rendering.
 * @module tests/tools/ntfy-fetch-messages.tool
 */

import { z } from '@cyanheads/mcp-ts-core';
import { forbidden, invalidParams, notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetServerConfig } from '@/config/server-config.js';
import { ntfyFetchMessages } from '@/mcp-server/tools/definitions/ntfy-fetch-messages.tool.js';
import { initNtfyService, resetNtfyService } from '@/services/ntfy/ntfy-service.js';
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
    vi.spyOn(svc, 'fetch').mockResolvedValue(upstream);

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
    vi.spyOn(svc, 'fetch').mockResolvedValue(upstream);

    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts', since: '1h', limit: 3 });
    const result = await ntfyFetchMessages.handler(input, ctx);

    expect(result.messages.map((m) => m.id)).toEqual(['m22', 'm23', 'm24']);
    const e = getEnrichment(ctx);
    expect(e).toMatchObject({ count: 3, truncated: true });
    expect(e.notice).toContain('newest 3');
    expect(e.notice).toContain('24 messages matched');
  });

  it('returns every message when the window fits inside `limit`', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'fetch').mockResolvedValue([
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
    vi.spyOn(svc, 'fetch').mockResolvedValue([
      { id: 'm', time: 1, event: 'message', topic: 'alerts', message: longBody },
    ]);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts' });
    const result = await ntfyFetchMessages.handler(input, ctx);

    expect(result.messages[0]?.message).toHaveLength(500);
    expect(result.messages[0]?.messageTruncated).toBe(200);
  });

  it('returns the whole body, with no `messageTruncated`, when a single message is pinned by `id`', async () => {
    const svc = freshService();
    const longBody = 'b'.repeat(720);
    const fetch = vi
      .spyOn(svc, 'fetch')
      .mockResolvedValue([
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
    vi.spyOn(svc, 'fetch').mockResolvedValue([
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
    const fetch = vi.spyOn(svc, 'fetch').mockResolvedValue([
      { id: 'first', time: 1, event: 'message', topic: 'alerts', message: longBody },
      { id: 'second', time: 2, event: 'message', topic: 'alerts', message: longBody },
    ]);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts', id: '' });
    const result = await ntfyFetchMessages.handler(input, ctx);

    // An empty `id` never reaches ntfy as a filter, so the response is a list.
    expect(fetch.mock.calls[0]?.[0].id).toBe('');
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
    vi.spyOn(svc, 'fetch').mockResolvedValue([
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
    const fetch = vi.spyOn(svc, 'fetch').mockResolvedValue([]);
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

  it('maps Forbidden upstream to reason `forbidden_topic`', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'fetch').mockRejectedValue(forbidden('Protected topic'));
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'protected' });
    await expect(ntfyFetchMessages.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'forbidden_topic' },
    });
  });

  it('maps a 4xx since-parse failure to `invalid_since`', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'fetch').mockRejectedValue(invalidParams('Bad since value'));
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({
      topic: 'alerts',
      since: 'tomorrow_maybe',
    });
    await expect(ntfyFetchMessages.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_since' },
    });
  });

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
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts', since: 'tomorrow_maybe' });
    await expect(ntfyFetchMessages.handler(input, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('invalid since parameter: unable to parse duration'),
      data: {
        reason: 'invalid_since',
        recovery: { hint: expect.stringContaining('`all`') },
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
    vi.spyOn(svc, 'fetch').mockResolvedValue([]);
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
    const fetch = vi.spyOn(svc, 'fetch').mockResolvedValue([]);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts' });
    await ntfyFetchMessages.handler(input, ctx);
    expect(fetch.mock.calls[0]?.[0].since).toBe('10m');
    expect(getEnrichment(ctx).since).toBe('10m');
  });

  it('uses NTFY_DEFAULT_TOPIC when topic is omitted', async () => {
    process.env.NTFY_DEFAULT_TOPIC = 'fallback';
    const svc = freshService();
    const fetch = vi.spyOn(svc, 'fetch').mockResolvedValue([]);
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
    const fetch = vi.spyOn(svc, 'fetch').mockResolvedValue([]);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({
      topic: 'alerts',
      base_url: 'https://other.example.com/',
    });
    await ntfyFetchMessages.handler(input, ctx);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ baseUrl: 'https://other.example.com' });
  });

  it.each(['ftp://ntfy.example.com', 'ntfy.example.com', 'https://ntfy example.com'])(
    'rejects the %j base_url at the schema boundary',
    (base_url) => {
      expect(() => ntfyFetchMessages.input.parse({ topic: 'alerts', base_url })).toThrow();
    },
  );

  it('treats an empty `base_url` from a form client as no override', async () => {
    const svc = freshService();
    const fetch = vi.spyOn(svc, 'fetch').mockResolvedValue([]);
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
