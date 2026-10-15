/**
 * @fileoverview Tests for `ntfy_manage_message` — clear and delete dispatch,
 * reason mapping (not_found / forbidden_topic / rate_limited /
 * upstream_unreachable / upstream_malformed without a resend / generic
 * rethrow), the advertised annotations and the
 * no-dedupe guarantee they reflect, default-topic resolution,
 * missing-topic ValidationError,
 * base_url override plus its scheme validation, format() rendering for both
 * operations, and the consent gate across both round trips — the first round's
 * `input_required` result, its prompt contents, and the consent record it
 * stores; the round that redeems that record (accepted, refused, cancelled,
 * schema-invalid, wrong response kind); and every round that must ask again
 * instead of acting (replay, pre-answer, fabricated or malformed id, a record
 * minted for another target, operation, tool, or caller, an expired record).
 * @module tests/tools/ntfy-manage-message.tool
 */

import type { AuthContext, InputRequiredResult } from '@cyanheads/mcp-ts-core';
import {
  forbidden,
  invalidParams,
  JsonRpcErrorCode,
  type McpError,
  notFound,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  expectInputRequired,
  type MockContextOptions,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetServerConfig } from '@/config/server-config.js';
import { ntfyManageMessage } from '@/mcp-server/tools/definitions/ntfy-manage-message.tool.js';
import { ntfyPublishMessage } from '@/mcp-server/tools/definitions/ntfy-publish-message.tool.js';
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

type ManageInput = ReturnType<typeof ntfyManageMessage.input.parse>;

const ACCEPT = { action: 'accept', content: { confirm: true } } as const;

/** Where the gate keeps the record a round-one prompt minted. */
const recordKey = (id: unknown) => `consent/${String(id)}`;

/**
 * Round one on its own context: the handler asks, and the record it stored
 * under the returned `requestState` is read back so a round-two context can
 * carry it — each mock context has its own `ctx.state`.
 */
async function askFirst(input: ManageInput, auth?: AuthContext) {
  const first = createMockContext({ errors: ntfyManageMessage.errors, ...(auth ? { auth } : {}) });
  const asked = await expectInputRequired(() => ntfyManageMessage.handler(input, first));
  return { asked, record: await first.state.get(recordKey(asked.requestState)) };
}

/** A round-two context: the reply, the round's `requestState`, and the record behind it. */
async function roundTwoCtx(
  requestState: unknown,
  record: unknown,
  reply: Record<string, unknown> = ACCEPT,
  auth?: AuthContext,
) {
  const ctx = createMockContext({
    errors: ntfyManageMessage.errors,
    inputResponses: { confirm: reply },
    requestState,
    ...(auth ? { auth } : {}),
  } as MockContextOptions<typeof ntfyManageMessage.errors>);
  if (record !== null) await ctx.state.set(recordKey(requestState), record);
  return ctx;
}

/**
 * The second round of a real exchange: round one asked about `input`, and this
 * context carries its record, its `requestState`, and the user's `reply`.
 */
async function approvedCtx(
  input: ManageInput,
  reply: Record<string, unknown> = ACCEPT,
  auth?: AuthContext,
) {
  const { asked, record } = await askFirst(input, auth);
  return roundTwoCtx(asked.requestState, record, reply, auth);
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

    const input = ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_1',
      operation: 'clear',
    });
    const result = await ntfyManageMessage.handler(input, await approvedCtx(input));

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
    const input = ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_missing',
      operation: 'delete',
    });
    await expect(ntfyManageMessage.handler(input, await approvedCtx(input))).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('keeps the upstream explanation on a `not_found` failure whose declared recovery names the next step', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'manage').mockRejectedValue(
      notFound('ntfy returned HTTP 404 Not Found: message not found or already expired', {
        status: 404,
        body: '{"code":40401,"http":404,"error":"message not found or already expired"}',
      }),
    );
    const input = ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_missing',
      operation: 'delete',
    });
    const err = (await Promise.resolve(
      ntfyManageMessage.handler(input, await approvedCtx(input)),
    ).catch((e: unknown) => e)) as McpError;

    expect(err.message).toContain('message not found or already expired');
    expect(err.data?.reason).toBe('not_found');
    // The framework puts the declared entry's recovery on the wire for this reason.
    expect(ntfyManageMessage.errors?.find((e) => e.reason === 'not_found')?.recovery).toContain(
      'ntfy_fetch_messages',
    );
  });

  it('maps Forbidden to reason `forbidden_topic`', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'manage').mockRejectedValue(forbidden('Topic forbidden'));
    const input = ntfyManageMessage.input.parse({
      topic: 'protected',
      sequence_id: 'seq_1',
      operation: 'clear',
    });
    await expect(ntfyManageMessage.handler(input, await approvedCtx(input))).rejects.toMatchObject({
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
    const input = ntfyManageMessage.input.parse({
      sequence_id: 'seq_1',
      operation: 'delete',
    });
    await ntfyManageMessage.handler(input, await approvedCtx(input));
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
    const input = ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_2',
      operation: 'delete',
    });
    const result = await ntfyManageMessage.handler(input, await approvedCtx(input));
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

  it('renders plain identifiers in format() exactly as before the literal() sweep', () => {
    const blocks = ntfyManageMessage.format!({
      event_id: 'evt_1',
      topic: 'alerts',
      sequence_id: 'seq_1',
      operation: 'delete',
      time: '2023-11-14T22:13:20.000Z',
    });
    expect((blocks[0] as { text: string }).text).toBe(
      '**DELETED** sequence `seq_1` on topic `alerts`\nEvent ID: `evt_1`\nOperation: delete\nTime: 2023-11-14T22:13:20.000Z',
    );
  });

  it('renders the topic, sequence, and event ID ntfy echoes as code spans, keeping structuredContent raw', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'manage').mockResolvedValue({
      id: '<i>e</i>',
      time: 1700000000,
      event: 'message_delete',
      topic: '[x](y)',
      sequence_id: 'a`b',
    });
    const input = ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_1',
      operation: 'delete',
    });
    const result = await ntfyManageMessage.handler(input, await approvedCtx(input));

    expect(result).toMatchObject({ event_id: '<i>e</i>', topic: '[x](y)', sequence_id: 'a`b' });
    const text = (ntfyManageMessage.format!(result)[0] as { text: string }).text;
    expect(text.split('\n').slice(0, 2)).toEqual([
      '**DELETED** sequence ``a`b`` on topic `[x](y)`',
      'Event ID: `<i>e</i>`',
    ]);
  });

  it('moves an echoed value with a line break into its own `text` fence', () => {
    const blocks = ntfyManageMessage.format!({
      event_id: 'evt_1',
      topic: 'alerts',
      sequence_id: 'seq\n# forged',
      operation: 'clear',
      time: '2023-11-14T22:13:20.000Z',
    });
    expect((blocks[0] as { text: string }).text).toContain(
      '**CLEARED** sequence \n```text\nseq\n# forged\n```\n on topic `alerts`',
    );
  });

  it.each([
    ['forbidden_topic', forbidden(''), 'Forbidden for topic `_secret_`'],
    ['not_found', notFound(''), 'No cached message `_seq_` on topic `_secret_`.'],
  ])(
    'names the topic in a code span when ntfy gave no %s explanation',
    async (reason, upstreamErr, message) => {
      const svc = freshService();
      vi.spyOn(svc, 'manage').mockRejectedValue(upstreamErr);
      const input = ntfyManageMessage.input.parse({
        topic: '_secret_',
        sequence_id: '_seq_',
        operation: 'delete',
      });
      await expect(
        ntfyManageMessage.handler(input, await approvedCtx(input)),
      ).rejects.toMatchObject({ message, data: { reason } });
    },
  );

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
    const input = ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_4',
      operation: 'delete',
      base_url: 'https://other.example.com/',
    });
    await ntfyManageMessage.handler(input, await approvedCtx(input));
    expect(manage.mock.calls[0]?.[3]).toMatchObject({ baseUrl: 'https://other.example.com' });
  });

  it('describes `base_url` credential forwarding as keyed on every registered server', () => {
    const description = ntfyManageMessage.input.shape.base_url.description ?? '';
    expect(description).toContain('only when the override matches a registered server');
    expect(description).toContain('`NTFY_SERVERS` entry');
    expect(description).not.toContain('differs from the configured base URL');
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
    const input = ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_5',
      operation: 'clear',
      base_url: '',
    });
    await ntfyManageMessage.handler(input, await approvedCtx(input));
    expect(manage.mock.calls[0]?.[3]).toMatchObject({ baseUrl: undefined });
  });

  it('maps a retry-exhausted network error to `upstream_unreachable`', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'manage').mockRejectedValue(new Error('econnreset (failed after 3 attempts)'));
    const input = ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_x',
      operation: 'clear',
    });
    await expect(ntfyManageMessage.handler(input, await approvedCtx(input))).rejects.toMatchObject({
      data: { reason: 'upstream_unreachable' },
    });
  });

  it('maps a call that ran out of its deadline to `upstream_unreachable`', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'manage').mockRejectedValue(
      timeout('ntfy clear exceeded its 50000ms retry deadline after 4 attempts.', {
        reason: 'retry_deadline_exceeded',
      }),
    );
    const input = ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_x',
      operation: 'clear',
    });
    await expect(ntfyManageMessage.handler(input, await approvedCtx(input))).rejects.toMatchObject({
      data: { reason: 'upstream_unreachable' },
    });
  });

  it('maps a 429 that outlasts the retries to `rate_limited`, through the real service', async () => {
    initNtfyService({
      servers: [{ baseUrl: 'https://ntfy.test' }],
      requestTimeoutMs: 1000,
      maxRetries: 1,
    } as never);
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (new URL(String(url)).hostname !== 'ntfy.test') throw new Error(`Unmocked fetch: ${url}`);
      return new Response('{"code":42901,"http":429,"error":"limit reached: too many requests"}', {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    });
    const input = ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_x',
      operation: 'delete',
    });
    const err = (await Promise.resolve(
      ntfyManageMessage.handler(input, await approvedCtx(input)),
    ).catch((e: unknown) => e)) as McpError;
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.data).toMatchObject({ reason: 'rate_limited', retryable: true });
    expect(err.message).toContain('limit reached: too many requests');
    expect(err.message).toContain('(failed after 2 attempts)');
    expect(ntfyManageMessage.errors?.find((e) => e.reason === 'rate_limited')).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      recovery: expect.stringContaining('rate-limit window'),
    });
  });

  /**
   * A `200` whose body is not ntfy's event reply (#39), through the real service
   * with `NTFY_MAX_RETRIES` at 3: the request count is how many
   * `message_clear` / `message_delete` events went out.
   */
  it.each([
    ['clear', 'an empty body', '', undefined],
    ['delete', 'an HTML page', '<!doctype html><html>Captive portal</html>', 'text/html'],
    ['clear', 'JSON `null`', 'null', 'application/json'],
    [
      'delete',
      'an event with no `sequence_id`',
      '{"id":"e1","time":1,"event":"message_delete","topic":"alerts"}',
      'application/json',
    ],
  ] as const)(
    'fails a %s answered with %s as `upstream_malformed`, sending it once',
    async (operation, _label, text, contentType) => {
      initNtfyService({
        servers: [{ baseUrl: 'https://ntfy.test' }],
        requestTimeoutMs: 1000,
        maxRetries: 3,
      } as never);
      const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (new URL(String(url)).hostname !== 'ntfy.test')
          throw new Error(`Unmocked fetch: ${url}`);
        return new Response(text, {
          status: 200,
          ...(contentType ? { headers: { 'content-type': contentType } } : {}),
        });
      });
      const input = ntfyManageMessage.input.parse({
        topic: 'alerts',
        sequence_id: 'seq_x',
        operation,
      });
      const err = (await Promise.resolve(
        ntfyManageMessage.handler(input, await approvedCtx(input)),
      ).catch((e: unknown) => e)) as McpError;
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data).toMatchObject({ reason: 'upstream_malformed', retryable: false });
      expect(err.message).toContain(`${operation} was answered with HTTP 200`);
    },
  );

  it('declares `upstream_malformed` as not retryable, pointing at the cached event before a reissue', () => {
    const entry = ntfyManageMessage.errors?.find((e) => e.reason === 'upstream_malformed');
    expect(entry).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable, retryable: false });
    expect(entry?.recovery).toContain('`ntfy_fetch_messages`');
    expect(entry?.recovery).toContain('`message_clear` / `message_delete`');
    // An event emitted through an override is cached only on that server.
    expect(entry?.recovery).toContain('same `base_url`');
  });

  it('keeps `upstream_malformed` when the call deadline landed on the malformed reply', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'manage').mockRejectedValue(
      serviceUnavailable(
        'The clear was answered with HTTP 200, but the reply is not an ntfy message: the body is empty. (failed after 1 attempt)',
        { reason: 'upstream_malformed', retryable: false, retryAttempts: 1, deadlineMs: 50_000 },
      ),
    );
    const input = ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_x',
      operation: 'clear',
    });
    await expect(ntfyManageMessage.handler(input, await approvedCtx(input))).rejects.toMatchObject({
      data: { reason: 'upstream_malformed', retryable: false },
    });
  });

  it('rethrows unclassified errors so the framework auto-classifier handles them', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'manage').mockRejectedValue(invalidParams('weird upstream complaint'));
    const input = ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_x',
      operation: 'clear',
    });
    await expect(
      ntfyManageMessage.handler(input, await approvedCtx(input)),
    ).rejects.not.toMatchObject({
      data: expect.objectContaining({ reason: expect.any(String) }),
    });
  });

  it('advertises destructive and open-world, never idempotent — each call appends an event', () => {
    expect(ntfyManageMessage.annotations).toEqual({
      destructiveHint: true,
      openWorldHint: true,
    });
  });

  it('sends every confirmed repeat of the same clear to ntfy, with no dedupe', async () => {
    freshService();
    let events = 0;
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (new URL(String(url)).hostname !== 'ntfy.test') throw new Error(`Unmocked fetch: ${url}`);
      expect(init?.method).toBe('PUT');
      events += 1;
      return Response.json({
        id: `evt_${events}`,
        time: 1700000000 + events,
        event: 'message_clear',
        topic: 'alerts',
        sequence_id: 's1',
      });
    });
    const input = ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 's1',
      operation: 'clear',
    });

    const first = await ntfyManageMessage.handler(input, await approvedCtx(input));
    const second = await ntfyManageMessage.handler(input, await approvedCtx(input));

    expect(upstream).toHaveBeenCalledTimes(2);
    for (const call of upstream.mock.calls) {
      expect(String(call[0])).toBe('https://ntfy.test/alerts/s1/clear');
    }
    expect([first.event_id, second.event_id]).toEqual(['evt_1', 'evt_2']);
    expect(second.sequence_id).toBe('s1');
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * The ntfy server at the HTTP boundary — every call is one outbound request,
   * so the call count is how many clear/delete events actually went out.
   */
  function fakeUpstream() {
    freshService();
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({
        id: 'evt_1',
        time: 1700000000,
        event: 'message_delete',
        topic: 'alerts',
        sequence_id: 'seq_1',
      }),
    );
  }

  const input = (overrides: Record<string, unknown> = {}) =>
    ntfyManageMessage.input.parse({
      topic: 'alerts',
      sequence_id: 'seq_1',
      operation: 'delete',
      ...overrides,
    });

  const ALICE: AuthContext = { clientId: 'client-a', sub: 'alice', scopes: [] };

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
    const upstream = fakeUpstream();

    const { message } = confirmRequest(await firstRound());

    expect(message).toContain('alerts');
    expect(message).toContain('seq_1');
    expect(message).toMatch(/delete/i);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('sends a requestState with the prompt that names a record it stored', async () => {
    const upstream = fakeUpstream();

    const { asked, record } = await askFirst(input());

    expect(asked.requestState).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(record).not.toBeNull();
    expect(upstream).not.toHaveBeenCalled();
  });

  it('advertises a single boolean `confirm` field on the prompt schema', async () => {
    fakeUpstream();
    const { requestedSchema } = confirmRequest(await firstRound());

    expect(Object.keys(requestedSchema.properties)).toEqual(['confirm']);
    expect(requestedSchema.properties.confirm?.type).toBe('boolean');
    expect(requestedSchema.required).toEqual(['confirm']);
  });

  it('describes the operation being asked about, not a fixed prompt', async () => {
    fakeUpstream();
    const asked = await expectInputRequired(() =>
      ntfyManageMessage.handler(
        input({ operation: 'clear' }),
        createMockContext({ errors: ntfyManageMessage.errors }),
      ),
    );
    const { message } = confirmRequest(asked);
    expect(message).toMatch(/^Clear/);
    expect(message).toContain('message_clear');
  });

  it('names the sequence and topic in code spans in the prompt and in a decline', async () => {
    const upstream = fakeUpstream();
    const gated = input({ topic: '_secret_', sequence_id: '__seq__' });

    const { message } = confirmRequest(
      await expectInputRequired(() =>
        ntfyManageMessage.handler(gated, createMockContext({ errors: ntfyManageMessage.errors })),
      ),
    );
    expect(message).toBe(
      'Delete ntfy notification `__seq__` on topic `_secret_`? Subscribers receive a message_delete event.',
    );

    await expect(
      ntfyManageMessage.handler(gated, await approvedCtx(gated, { action: 'decline' })),
    ).rejects.toMatchObject({
      message: 'The delete of `__seq__` on topic `_secret_` was not confirmed.',
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('carries out the operation once, on the round that redeems its own record', async () => {
    const upstream = fakeUpstream();

    const result = await ntfyManageMessage.handler(input(), await approvedCtx(input()));

    expect(upstream).toHaveBeenCalledOnce();
    expect(String(upstream.mock.calls[0]?.[0])).toBe('https://ntfy.test/alerts/seq_1');
    expect(upstream.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
    expect(result.operation).toBe('delete');
  });

  it('carries out the operation for the same authenticated caller on both rounds', async () => {
    const upstream = fakeUpstream();

    await ntfyManageMessage.handler(input(), await approvedCtx(input(), ACCEPT, ALICE));

    expect(upstream).toHaveBeenCalledOnce();
  });

  it('asks again when a redeemed round is replayed, and sends nothing more', async () => {
    const upstream = fakeUpstream();
    const ctx = await approvedCtx(input());
    await ntfyManageMessage.handler(input(), ctx);
    const spent = ctx.inputs.state();

    const again = await expectInputRequired(() => ntfyManageMessage.handler(input(), ctx));

    expect(again.requestState).toEqual(expect.any(String));
    expect(again.requestState).not.toBe(spent);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('asks instead of acting on an accepted answer that nothing asked for', async () => {
    const upstream = fakeUpstream();
    const preAnswered = createMockContext({
      errors: ntfyManageMessage.errors,
      inputResponses: { confirm: ACCEPT },
    });

    const asked = await expectInputRequired(() => ntfyManageMessage.handler(input(), preAnswered));

    expect(asked.inputRequests?.confirm).toBeDefined();
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown id', '0b8f5a52-6a52-4c49-9b4b-6f5e6f0d2a11'],
    ['a malformed id', 'not-a-consent-id'],
    ['a path-shaped id', '../consent/x'],
    ['an id outside the storage key charset', 'a:b'],
    ['an empty id', ''],
  ])('asks again for %s, sending nothing', async (_label, requestState) => {
    const upstream = fakeUpstream();
    const ctx = await roundTwoCtx(requestState, null);

    await expectInputRequired(() => ntfyManageMessage.handler(input(), ctx));

    expect(upstream).not.toHaveBeenCalled();
  });

  it('asks again for a malformed id even when a matching record sits under it', async () => {
    const upstream = fakeUpstream();
    const { record } = await askFirst(input());
    const ctx = await roundTwoCtx('forged', record);

    await expectInputRequired(() => ntfyManageMessage.handler(input(), ctx));

    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ['another sequence_id', { sequence_id: 'seq_2' }],
    ['another topic', { topic: 'other' }],
    ['the other operation', { operation: 'clear' }],
    ['another ntfy server', { base_url: 'https://other.example.com' }],
  ])('asks again when the record was minted for %s', async (_label, overrides) => {
    const upstream = fakeUpstream();
    const { asked, record } = await askFirst(input());
    const ctx = await roundTwoCtx(asked.requestState, record);

    await expectInputRequired(() => ntfyManageMessage.handler(input(overrides), ctx));

    expect(upstream).not.toHaveBeenCalled();
  });

  it('asks again on a record minted by ntfy_publish_message', async () => {
    const upstream = fakeUpstream();
    const first = createMockContext({ errors: ntfyPublishMessage.errors });
    const asked = await expectInputRequired(() =>
      ntfyPublishMessage.handler(
        ntfyPublishMessage.input.parse({ topic: 'alerts', email: 'ops@example.com' }),
        first,
      ),
    );
    const record = await first.state.get(recordKey(asked.requestState));
    const ctx = await roundTwoCtx(asked.requestState, record);

    await expectInputRequired(() => ntfyManageMessage.handler(input(), ctx));

    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ['another client', { clientId: 'client-b', sub: 'alice', scopes: [] }],
    ['another subject', { clientId: 'client-a', sub: 'mallory', scopes: [] }],
    ['no authenticated caller', undefined],
  ])('asks again when a record minted for one caller is redeemed by %s', async (_label, auth) => {
    const upstream = fakeUpstream();
    const { asked, record } = await askFirst(input(), ALICE);
    const ctx = await roundTwoCtx(asked.requestState, record, ACCEPT, auth);

    await expectInputRequired(() => ntfyManageMessage.handler(input(), ctx));

    expect(upstream).not.toHaveBeenCalled();
  });

  it('lets the stored record expire, so a late answer asks again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const upstream = fakeUpstream();
    const first = createMockContext({ errors: ntfyManageMessage.errors });
    const asked = await expectInputRequired(() => ntfyManageMessage.handler(input(), first));
    expect(await first.state.get(recordKey(asked.requestState))).not.toBeNull();

    vi.advanceTimersByTime(60 * 60 * 1000);

    const record = await first.state.get(recordKey(asked.requestState));
    expect(record).toBeNull();
    const ctx = await roundTwoCtx(asked.requestState, record);
    await expectInputRequired(() => ntfyManageMessage.handler(input(), ctx));
    expect(upstream).not.toHaveBeenCalled();
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
    'fails with `consent_declined` on %s against its own record, without touching the upstream',
    async (_label, reply) => {
      const upstream = fakeUpstream();

      await expect(
        ntfyManageMessage.handler(input(), await approvedCtx(input(), reply)),
      ).rejects.toMatchObject({
        data: { reason: 'consent_declined' },
      });
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it('does not re-ask after a refusal — a declined round is a dead end', async () => {
    fakeUpstream();
    const declined = ntfyManageMessage.handler(
      input(),
      await approvedCtx(input(), { action: 'decline' }),
    );
    await expect(declined).rejects.toMatchObject({ data: { reason: 'consent_declined' } });
    await expect(declined).rejects.not.toMatchObject({ isInputRequiredSignal: true });
  });
});
