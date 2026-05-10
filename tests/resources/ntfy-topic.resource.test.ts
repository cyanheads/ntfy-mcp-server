/**
 * @fileoverview Tests for the `ntfy://{topic}` resource — fixed snapshot
 * window, open/keepalive filtering, forbidden-topic mapping, generic-error
 * rethrow, the 20-message truncation cap, and the snapshot envelope shape
 * (baseUrl, since, count, truncated).
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

  it('maps Forbidden upstream to a Forbidden McpError', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'fetch').mockRejectedValue(forbidden('Protected'));
    const ctx = createMockContext({ uri: new URL('ntfy://protected') });
    await expect(ntfyTopicResource.handler({ topic: 'protected' }, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
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

  it('truncates to 20 messages and flags `truncated: true`', async () => {
    const svc = freshService();
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
      messages: unknown[];
      count: number;
      truncated: boolean;
    };
    expect(result.messages).toHaveLength(20);
    expect(result.count).toBe(20);
    expect(result.truncated).toBe(true);
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
