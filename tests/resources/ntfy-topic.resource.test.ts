/**
 * @fileoverview Tests for the `ntfy://{topic}` resource — fixed snapshot
 * window, open/keepalive filtering, forbidden-topic mapping.
 * @module tests/resources/ntfy-topic.resource
 */

import { forbidden, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetServerConfig } from '@/config/server-config.js';
import { ntfyTopicResource } from '@/mcp-server/resources/definitions/ntfy-topic.resource.js';
import { initNtfyService, resetNtfyService } from '@/services/ntfy/ntfy-service.js';

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
});
