/**
 * @fileoverview Tests for `ntfy_manage_message` — clear and delete dispatch,
 * reason mapping for not_found / forbidden_topic, default-topic resolution,
 * and format() rendering.
 * @module tests/tools/ntfy-manage-message.tool
 */

import { forbidden, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetServerConfig } from '@/config/server-config.js';
import { ntfyManageMessage } from '@/mcp-server/tools/definitions/ntfy-manage-message.tool.js';
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

describe('ntfyManageMessage handler', () => {
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

  it('forwards the operation and echoes the event envelope', async () => {
    const svc = freshService();
    const manage = vi.spyOn(svc, 'manage').mockResolvedValue({
      id: 'evt_1',
      time: 1700000000,
      event: 'message_clear',
      topic: 'alerts',
      sequence_id: 'seq_1',
    });

    const ctx = createMockContext({ errors: ntfyManageMessage.errors });
    const input = ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_1',
      operation: 'clear',
    });
    const result = await ntfyManageMessage.handler(input, ctx);

    expect(manage).toHaveBeenCalledWith('alerts', 'seq_1', 'clear', expect.objectContaining({}));
    expect(result).toEqual({
      event_id: 'evt_1',
      topic: 'alerts',
      sequence_id: 'seq_1',
      operation: 'clear',
      time: '2023-11-14T22:13:20.000Z',
    });
  });

  it('maps NotFound to reason `not_found`', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'manage').mockRejectedValue(notFound('No such sequence'));
    const ctx = createMockContext({ errors: ntfyManageMessage.errors });
    const input = ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_missing',
      operation: 'delete',
    });
    await expect(ntfyManageMessage.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('maps Forbidden to reason `forbidden_topic`', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'manage').mockRejectedValue(forbidden('Topic forbidden'));
    const ctx = createMockContext({ errors: ntfyManageMessage.errors });
    const input = ntfyManageMessage.input.parse({
      topic: 'protected',
      sequence_id: 'seq_1',
      operation: 'clear',
    });
    await expect(ntfyManageMessage.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'forbidden_topic' },
    });
  });

  it('uses NTFY_DEFAULT_TOPIC when topic is omitted', async () => {
    process.env.NTFY_DEFAULT_TOPIC = 'fallback';
    const svc = freshService();
    const manage = vi.spyOn(svc, 'manage').mockResolvedValue({
      id: 'evt_1',
      time: 1,
      event: 'message_delete',
      topic: 'fallback',
      sequence_id: 'seq_1',
    });
    const ctx = createMockContext({ errors: ntfyManageMessage.errors });
    const input = ntfyManageMessage.input.parse({
      sequence_id: 'seq_1',
      operation: 'delete',
    });
    await ntfyManageMessage.handler(input, ctx);
    expect(manage.mock.calls[0]?.[0]).toBe('fallback');
  });

  it('renders the operation banner in format()', () => {
    const blocks = ntfyManageMessage.format!({
      id: 'evt_1',
      topic: 'alerts',
      sequence_id: 'seq_1',
      operation: 'delete',
      time: 1700000000,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('DELETED');
    expect(text).toContain('alerts');
    expect(text).toContain('seq_1');
    expect(text).toContain('1700000000');
  });
});
