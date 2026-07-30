/**
 * @fileoverview Tests for the `ntfy://{topic}` resource — fixed snapshot
 * window, open/keepalive filtering, forbidden-topic mapping, generic-error
 * rethrow, the newest-20 truncation cap, message normalization (ISO 8601
 * timestamps, body truncation, sparse payloads), and the snapshot envelope
 * shape (baseUrl, since, count, truncated).
 * @module tests/resources/ntfy-topic.resource
 */

import { forbidden, JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetServerConfig } from '@/config/server-config.js';
import { ntfyTopicResource } from '@/mcp-server/resources/definitions/ntfy-topic.resource.js';
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
  });

  it('returns a snapshot envelope with the synthesized URL', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'fetch').mockResolvedValue([
      { id: 'a', time: 1, event: 'open', topic: 'alerts' },
      { id: 'b', time: 2, event: 'message', topic: 'alerts', message: 'hi' },
    ]);
    const ctx = createMockContext({ uri: new URL('ntfy://alerts') });
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
      forbidden('ntfy returned HTTP 403 Forbidden: reserved topic access denied'),
    );
    const ctx = createMockContext({ uri: new URL('ntfy://protected') });
    await expect(ntfyTopicResource.handler({ topic: 'protected' }, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      message: expect.stringContaining('reserved topic access denied'),
    });
  });

  it('rethrows non-auth upstream errors so the framework auto-classifier handles them', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'fetch').mockRejectedValue(notFound('topic vanished'));
    const ctx = createMockContext({ uri: new URL('ntfy://gone') });
    await expect(ntfyTopicResource.handler({ topic: 'gone' }, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('echoes baseUrl and the fixed `since` window in the snapshot envelope', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'fetch').mockResolvedValue([]);
    const ctx = createMockContext({ uri: new URL('ntfy://alerts') });
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
    vi.spyOn(svc, 'fetch').mockResolvedValue(upstream);
    const ctx = createMockContext({ uri: new URL('ntfy://alerts') });
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
    vi.spyOn(svc, 'fetch').mockResolvedValue([
      {
        id: '3sZEC2WVcTLg',
        time: 1779777011,
        expires: 1779820211,
        event: 'message',
        topic: 'alerts',
        message: 'hi',
      },
    ]);
    const ctx = createMockContext({ uri: new URL('ntfy://alerts') });
    const result = (await ntfyTopicResource.handler({ topic: 'alerts' }, ctx)) as {
      messages: Array<{ expires?: string; time: string }>;
    };
    expect(result.messages[0]?.time).toBe('2026-05-26T06:30:11.000Z');
    expect(result.messages[0]?.expires).toBe('2026-05-26T18:30:11.000Z');
  });

  it('truncates long message bodies and reports the dropped count', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'fetch').mockResolvedValue([
      { id: 'm', time: 1, event: 'message', topic: 'alerts', message: 'a'.repeat(700) },
    ]);
    const ctx = createMockContext({ uri: new URL('ntfy://alerts') });
    const result = (await ntfyTopicResource.handler({ topic: 'alerts' }, ctx)) as {
      messages: Array<{ message?: string; messageTruncated?: number }>;
    };
    expect(result.messages[0]?.message).toHaveLength(500);
    expect(result.messages[0]?.messageTruncated).toBe(200);
  });

  it('leaves omitted upstream fields undefined (sparse payload)', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'fetch').mockResolvedValue([
      { id: 'sparse', time: 1700000000, event: 'message', topic: 'alerts', message: 'minimal' },
    ]);
    const ctx = createMockContext({ uri: new URL('ntfy://alerts') });
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

  it('drops keepalive frames alongside open frames', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'fetch').mockResolvedValue([
      { id: 'a', time: 1, event: 'open', topic: 'alerts' },
      { id: 'b', time: 2, event: 'keepalive', topic: 'alerts' },
      { id: 'c', time: 3, event: 'message', topic: 'alerts', message: 'real' },
    ]);
    const ctx = createMockContext({ uri: new URL('ntfy://alerts') });
    const result = (await ntfyTopicResource.handler({ topic: 'alerts' }, ctx)) as {
      messages: Array<{ id: string }>;
    };
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.id).toBe('c');
  });
});
