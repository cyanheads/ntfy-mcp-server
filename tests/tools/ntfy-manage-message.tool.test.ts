/**
 * @fileoverview Tests for `ntfy_manage_message` — clear and delete dispatch,
 * reason mapping (not_found / forbidden_topic / upstream_unreachable / generic
 * rethrow), default-topic resolution, missing-topic ValidationError,
 * base_url override plus its scheme validation, format() rendering for both
 * operations, and the consent gate — prompt contents, every declining reply,
 * the proceed-anyway path on clients without elicitation, and a failing
 * elicitation call.
 * @module tests/tools/ntfy-manage-message.tool
 */

import { forbidden, invalidParams, notFound } from '@cyanheads/mcp-ts-core/errors';
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

  it('keeps the upstream explanation alongside the `not_found` recovery hint', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'manage').mockRejectedValue(
      notFound('ntfy returned HTTP 404 Not Found: message not found or already expired', {
        status: 404,
        body: '{"code":40401,"http":404,"error":"message not found or already expired"}',
      }),
    );
    const ctx = createMockContext({ errors: ntfyManageMessage.errors });
    const input = ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_missing',
      operation: 'delete',
    });
    await expect(ntfyManageMessage.handler(input, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('message not found or already expired'),
      data: {
        reason: 'not_found',
        recovery: { hint: expect.stringContaining('ntfy_fetch_messages') },
      },
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

  it('dispatches the `delete` operation distinctly from `clear`', async () => {
    const svc = freshService();
    const manage = vi.spyOn(svc, 'manage').mockResolvedValue({
      id: 'evt_2',
      time: 1700000000,
      event: 'message_delete',
      topic: 'alerts',
      sequence_id: 'seq_2',
    });
    const ctx = createMockContext({ errors: ntfyManageMessage.errors });
    const input = ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_2',
      operation: 'delete',
    });
    const result = await ntfyManageMessage.handler(input, ctx);
    expect(manage).toHaveBeenCalledWith('alerts', 'seq_2', 'delete', expect.objectContaining({}));
    expect(result.operation).toBe('delete');
  });

  it('renders the `CLEARED` banner for clear operations', () => {
    const blocks = ntfyManageMessage.format!({
      event_id: 'evt_3',
      topic: 'alerts',
      sequence_id: 'seq_3',
      operation: 'clear',
      time: '2023-11-14T22:13:20.000Z',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('CLEARED');
    expect(text).toContain('Operation: clear');
  });

  it('throws ValidationError when neither topic nor NTFY_DEFAULT_TOPIC is set', async () => {
    freshService();
    const ctx = createMockContext({ errors: ntfyManageMessage.errors });
    const input = ntfyManageMessage.input.parse({
      sequence_id: 'seq_x',
      operation: 'clear',
    });
    await expect(ntfyManageMessage.handler(input, ctx)).rejects.toThrow(/Topic is required/);
  });

  it('forwards `base_url` (trailing-slash-normalized) to the service', async () => {
    const svc = freshService();
    const manage = vi.spyOn(svc, 'manage').mockResolvedValue({
      id: 'evt_4',
      time: 1700000000,
      event: 'message_delete',
      topic: 'alerts',
      sequence_id: 'seq_4',
    });
    const ctx = createMockContext({ errors: ntfyManageMessage.errors });
    const input = ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_4',
      operation: 'delete',
      base_url: 'https://other.example.com/',
    });
    await ntfyManageMessage.handler(input, ctx);
    expect(manage.mock.calls[0]?.[3]).toMatchObject({ baseUrl: 'https://other.example.com' });
  });

  it.each(['ftp://ntfy.example.com', 'ntfy.example.com', 'https://ntfy example.com'])(
    'rejects the %j base_url at the schema boundary',
    (base_url) => {
      expect(() =>
        ntfyManageMessage.input.parse({
          topic: 'alerts',
          sequence_id: 'seq_1',
          operation: 'clear',
          base_url,
        }),
      ).toThrow();
    },
  );

  it('treats an empty `base_url` from a form client as no override', async () => {
    const svc = freshService();
    const manage = vi.spyOn(svc, 'manage').mockResolvedValue({
      id: 'evt_5',
      time: 1700000000,
      event: 'message_clear',
      topic: 'alerts',
      sequence_id: 'seq_5',
    });
    const ctx = createMockContext({ errors: ntfyManageMessage.errors });
    const input = ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_5',
      operation: 'clear',
      base_url: '',
    });
    await ntfyManageMessage.handler(input, ctx);
    expect(manage.mock.calls[0]?.[3]).toMatchObject({ baseUrl: undefined });
  });

  it('maps a retry-exhausted network error to `upstream_unreachable`', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'manage').mockRejectedValue(new Error('econnreset (failed after 3 attempts)'));
    const ctx = createMockContext({ errors: ntfyManageMessage.errors });
    const input = ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_x',
      operation: 'clear',
    });
    await expect(ntfyManageMessage.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'upstream_unreachable' },
    });
  });

  it('rethrows unclassified errors so the framework auto-classifier handles them', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'manage').mockRejectedValue(invalidParams('weird upstream complaint'));
    const ctx = createMockContext({ errors: ntfyManageMessage.errors });
    const input = ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_x',
      operation: 'clear',
    });
    await expect(ntfyManageMessage.handler(input, ctx)).rejects.not.toMatchObject({
      data: expect.objectContaining({ reason: expect.any(String) }),
    });
  });
});

describe('ntfyManageMessage consent gate', () => {
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

  function stubbedManage() {
    return vi.spyOn(freshService(), 'manage').mockResolvedValue({
      id: 'evt_1',
      time: 1700000000,
      event: 'message_delete',
      topic: 'alerts',
      sequence_id: 'seq_1',
    });
  }

  const input = () =>
    ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_1',
      operation: 'delete',
    });

  it('names the topic, sequence_id, and operation in the prompt', async () => {
    const manage = stubbedManage();
    const elicit = vi.fn().mockResolvedValue({ action: 'accept', content: { confirm: true } });
    const ctx = createMockContext({ errors: ntfyManageMessage.errors, elicit });

    await ntfyManageMessage.handler(input(), ctx);

    const prompt = elicit.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('alerts');
    expect(prompt).toContain('seq_1');
    expect(prompt).toMatch(/delete/i);
    expect(manage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['decline', { action: 'decline' }],
    ['cancel', { action: 'cancel' }],
    ['accept with confirm=false', { action: 'accept', content: { confirm: false } }],
    ['accept with a missing confirm', { action: 'accept', content: {} }],
    ['accept with a stringified boolean', { action: 'accept', content: { confirm: 'true' } }],
    ['accept with no content at all', { action: 'accept' }],
  ])(
    'fails with `consent_declined` on %s, without touching the upstream',
    async (_label, reply) => {
      const manage = stubbedManage();
      const ctx = createMockContext({
        errors: ntfyManageMessage.errors,
        elicit: vi.fn().mockResolvedValue(reply),
      });

      await expect(ntfyManageMessage.handler(input(), ctx)).rejects.toMatchObject({
        data: { reason: 'consent_declined' },
      });
      expect(manage).not.toHaveBeenCalled();
    },
  );

  it('proceeds when the client does not support elicitation', async () => {
    const manage = stubbedManage();
    const ctx = createMockContext({ errors: ntfyManageMessage.errors });
    expect(ctx.elicit).toBeUndefined();

    await ntfyManageMessage.handler(input(), ctx);
    expect(manage).toHaveBeenCalledTimes(1);
  });

  it('fails the call when an advertised elicitation errors out', async () => {
    const manage = stubbedManage();
    const ctx = createMockContext({
      errors: ntfyManageMessage.errors,
      elicit: vi.fn().mockRejectedValue(new Error('client transport closed')),
    });

    await expect(ntfyManageMessage.handler(input(), ctx)).rejects.toThrow(
      /client transport closed/,
    );
    expect(manage).not.toHaveBeenCalled();
  });
});
