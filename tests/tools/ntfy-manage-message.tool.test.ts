/**
 * @fileoverview Tests for `ntfy_manage_message` — clear and delete dispatch,
 * reason mapping (not_found / forbidden_topic / upstream_unreachable / generic
 * rethrow), default-topic resolution, missing-topic ValidationError,
 * base_url override plus its scheme validation, format() rendering for both
 * operations, and the consent gate across both round trips — the first round's
 * `input_required` result and its prompt contents, and every re-entry reply
 * (accepted, refused, cancelled, schema-invalid, wrong response kind).
 * @module tests/tools/ntfy-manage-message.tool
 */

import type { InputRequiredResult } from '@cyanheads/mcp-ts-core';
import { forbidden, invalidParams, notFound } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  expectInputRequired,
  type MockContextOptions,
} from '@cyanheads/mcp-ts-core/testing';
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

/** The wire shape of the embedded `elicitation/create` request the gate emits. */
type ElicitParams = {
  message: string;
  requestedSchema: { properties: Record<string, { type: string }>; required?: string[] };
};

/**
 * Every clear/delete is gated, so a handler test that wants to reach the
 * upstream stands in for the second round: the context carries the approval the
 * client would have collected after the first round's `input_required`.
 */
function consentedCtx(
  reply: Record<string, unknown> = { action: 'accept', content: { confirm: true } },
) {
  return createMockContext({
    errors: ntfyManageMessage.errors,
    inputResponses: { confirm: reply },
  } as MockContextOptions<typeof ntfyManageMessage.errors>);
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

    const ctx = consentedCtx();
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
    const ctx = consentedCtx();
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
    const ctx = consentedCtx();
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
    const ctx = consentedCtx();
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
    const ctx = consentedCtx();
    const input = ntfyManageMessage.input.parse({
      sequence_id: 'seq_1',
      operation: 'delete',
    });
    await ntfyManageMessage.handler(input, ctx);
    expect(manage.mock.calls[0]?.[0]).toBe('fallback');
  });

  it('renders the operation banner in format()', () => {
    const blocks = ntfyManageMessage.format!({
      event_id: 'evt_1',
      topic: 'alerts',
      sequence_id: 'seq_1',
      operation: 'delete',
      time: '2023-11-14T22:13:20.000Z',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('DELETED');
    expect(text).toContain('alerts');
    expect(text).toContain('seq_1');
    expect(text).toContain('evt_1');
    expect(text).toContain('2023-11-14T22:13:20.000Z');
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
    const ctx = consentedCtx();
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
    const ctx = consentedCtx();
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
    const ctx = consentedCtx();
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
    const ctx = consentedCtx();
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
    const ctx = consentedCtx();
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
    const ctx = consentedCtx();
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

  /** The elicitation params the first round hands back to the client. */
  function confirmRequest(asked: InputRequiredResult): ElicitParams {
    const request = asked.inputRequests?.confirm;
    if (!request) throw new Error('Expected a `confirm` input request.');
    expect(request.method).toBe('elicitation/create');
    return request.params as ElicitParams;
  }

  function firstRound(): Promise<InputRequiredResult> {
    return expectInputRequired(() =>
      ntfyManageMessage.handler(input(), createMockContext({ errors: ntfyManageMessage.errors })),
    );
  }

  it('asks before touching the upstream and names the topic, sequence_id, and operation', async () => {
    const manage = stubbedManage();

    const { message } = confirmRequest(await firstRound());

    expect(message).toContain('alerts');
    expect(message).toContain('seq_1');
    expect(message).toMatch(/delete/i);
    expect(manage).not.toHaveBeenCalled();
  });

  it('advertises a single boolean `confirm` field on the prompt schema', async () => {
    stubbedManage();
    const { requestedSchema } = confirmRequest(await firstRound());

    expect(Object.keys(requestedSchema.properties)).toEqual(['confirm']);
    expect(requestedSchema.properties.confirm?.type).toBe('boolean');
    expect(requestedSchema.required).toEqual(['confirm']);
  });

  it('describes the operation being asked about, not a fixed prompt', async () => {
    stubbedManage();
    const asked = await expectInputRequired(() =>
      ntfyManageMessage.handler(
        ntfyManageMessage.input.parse({
          topic: 'alerts',
          sequence_id: 'seq_1',
          operation: 'clear',
        }),
        createMockContext({ errors: ntfyManageMessage.errors }),
      ),
    );
    const { message } = confirmRequest(asked);
    expect(message).toMatch(/^Clear/);
    expect(message).toContain('message_clear');
  });

  it('carries out the operation once the retried call approves it', async () => {
    const manage = stubbedManage();

    const result = await ntfyManageMessage.handler(input(), consentedCtx());

    expect(manage).toHaveBeenCalledTimes(1);
    expect(result.operation).toBe('delete');
  });

  it.each([
    ['decline', { action: 'decline' }],
    ['cancel', { action: 'cancel' }],
    ['accept with confirm=false', { action: 'accept', content: { confirm: false } }],
    ['accept with a missing confirm', { action: 'accept', content: {} }],
    ['accept with a stringified boolean', { action: 'accept', content: { confirm: 'true' } }],
    ['accept with no content at all', { action: 'accept' }],
    ['a roots listing instead of an elicitation', { roots: [] }],
  ])(
    'fails with `consent_declined` on %s, without touching the upstream',
    async (_label, reply) => {
      const manage = stubbedManage();

      await expect(ntfyManageMessage.handler(input(), consentedCtx(reply))).rejects.toMatchObject({
        data: { reason: 'consent_declined' },
      });
      expect(manage).not.toHaveBeenCalled();
    },
  );

  it('does not re-ask after a refusal — a declined round is a dead end', async () => {
    stubbedManage();
    const declined = ntfyManageMessage.handler(input(), consentedCtx({ action: 'decline' }));
    await expect(declined).rejects.toMatchObject({ data: { reason: 'consent_declined' } });
    await expect(declined).rejects.not.toMatchObject({ isInputRequiredSignal: true });
  });
});
