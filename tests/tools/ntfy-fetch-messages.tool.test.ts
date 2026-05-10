/**
 * @fileoverview Tests for `ntfy_fetch_messages` — open/keepalive filtering,
 * client-side limit truncation, message-body truncation, sparse upstream
 * payloads (per checklist), error mapping (forbidden / invalid_since /
 * upstream_unreachable / generic rethrow), default-topic resolution,
 * base_url override, and format() rendering.
 * @module tests/tools/ntfy-fetch-messages.tool
 */

import { forbidden, invalidParams, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

  it('drops `open` and `keepalive` frames and respects the limit', async () => {
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
    expect(result.messages.map((m) => m.id)).toEqual(['b', 'd']);
    expect(result.count).toBe(2);
    expect(result.truncated).toBe(true);
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

  it('forwards filter args to the service', async () => {
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

  it('renders message bodies and truncation note in format()', () => {
    const blocks = ntfyFetchMessages.format!({
      topic: 'alerts',
      since: '10m',
      messages: [
        {
          id: 'm1',
          time: 1700000000,
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
          expires: 1700001000,
          sequence_id: 'seq_1',
        },
      ],
      count: 1,
      truncated: true,
      filters: {},
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Backup failed');
    expect(text).toContain('warning');
    expect(text).toContain('200 chars more');
    expect(text).toContain('log.txt');
    expect(text).toContain('seq_1');
    expect(text).toContain('and more');
  });

  it('echoes the resolved topic, since, and active filters in the empty-result message', () => {
    const blocks = ntfyFetchMessages.format!({
      topic: 'alerts',
      since: '10m',
      messages: [],
      count: 0,
      truncated: false,
      filters: { title: 'never-matches-xyz' },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0');
    expect(text).toContain('alerts');
    expect(text).toContain('10m');
    expect(text).toContain('never-matches-xyz');
    expect(text.toLowerCase()).toContain('try');
  });

  it('applies the default `since` of `10m` when omitted', async () => {
    const svc = freshService();
    const fetch = vi.spyOn(svc, 'fetch').mockResolvedValue([]);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({ topic: 'alerts' });
    const result = await ntfyFetchMessages.handler(input, ctx);
    expect(fetch.mock.calls[0]?.[0].since).toBe('10m');
    expect(result.since).toBe('10m');
  });

  it('uses NTFY_DEFAULT_TOPIC when topic is omitted', async () => {
    process.env.NTFY_DEFAULT_TOPIC = 'fallback';
    const svc = freshService();
    const fetch = vi.spyOn(svc, 'fetch').mockResolvedValue([]);
    const ctx = createMockContext({ errors: ntfyFetchMessages.errors });
    const input = ntfyFetchMessages.input.parse({});
    const result = await ntfyFetchMessages.handler(input, ctx);
    expect(fetch.mock.calls[0]?.[0].topic).toBe('fallback');
    expect(result.topic).toBe('fallback');
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
