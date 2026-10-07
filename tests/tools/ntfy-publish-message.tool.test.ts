/**
 * @fileoverview Tests for `ntfy_publish_message` — happy path with mocked
 * upstream, default-topic resolution, the priority schema's single-node
 * validation and advertised shape, byte-length message validation,
 * format-rendering (including the scheduled delivery-time label), scheduled-flag
 * synthesis, base_url override and its scheme validation, the consent gate
 * across both round trips (which inputs prompt and which publish straight
 * through, the first round's `input_required` result and the consent record
 * it stores, every reply on the round that redeems that record, and every
 * round that must ask again instead of publishing — replay, pre-answer,
 * fabricated or malformed id, a record minted for other content, target, tool,
 * or caller), and the full contract error mapping
 * (forbidden / rate-limit / payload-too-large from a 413 / invalid-attachment /
 * unverified-contact / upstream-unreachable / generic rethrow) with the upstream
 * explanation preserved on the error message.
 * @module tests/tools/ntfy-publish-message.tool
 */

import { type AuthContext, type InputRequiredResult, z } from '@cyanheads/mcp-ts-core';
import {
  forbidden,
  invalidParams,
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  expectInputRequired,
  type MockContextOptions,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetServerConfig } from '@/config/server-config.js';
import { ntfyManageMessage } from '@/mcp-server/tools/definitions/ntfy-manage-message.tool.js';
import { ntfyPublishMessage } from '@/mcp-server/tools/definitions/ntfy-publish-message.tool.js';
import { initNtfyService, resetNtfyService } from '@/services/ntfy/ntfy-service.js';
import type { NtfyPublishResponse } from '@/services/ntfy/types.js';

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

type PublishInput = ReturnType<typeof ntfyPublishMessage.input.parse>;

const ACCEPT = { action: 'accept', content: { confirm: true } } as const;

/** Where the gate keeps the record a round-one prompt minted. */
const recordKey = (id: unknown) => `consent/${String(id)}`;

/**
 * Round one of a gated publish on its own context: the handler asks, and the
 * record it stored under the returned `requestState` is read back so a
 * round-two context can carry it — each mock context has its own `ctx.state`.
 */
async function askFirst(input: PublishInput, auth?: AuthContext) {
  const first = createMockContext({ errors: ntfyPublishMessage.errors, ...(auth ? { auth } : {}) });
  const asked = await expectInputRequired(() => ntfyPublishMessage.handler(input, first));
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
    errors: ntfyPublishMessage.errors,
    inputResponses: { confirm: reply },
    requestState,
    ...(auth ? { auth } : {}),
  } as MockContextOptions<typeof ntfyPublishMessage.errors>);
  if (record !== null) await ctx.state.set(recordKey(requestState), record);
  return ctx;
}

/**
 * The second round of a real gated exchange: round one asked about `input`,
 * and this context carries its record, its `requestState`, and the `reply`.
 */
async function approvedCtx(
  input: PublishInput,
  reply: Record<string, unknown> = ACCEPT,
  auth?: AuthContext,
) {
  const { asked, record } = await askFirst(input, auth);
  return roundTwoCtx(asked.requestState, record, reply, auth);
}

describe('ntfyPublishMessage handler', () => {
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

  it('publishes with all the input fields and synthesizes the topic URL', async () => {
    const svc = freshService();
    const upstream: NtfyPublishResponse = {
      id: 'mid_42',
      time: 1700000000,
      topic: 'alerts',
      expires: 1700001000,
      title: 'Hello',
      message: 'world',
      priority: 4,
      tags: ['warning'],
      click: 'https://example.com/click',
    };
    const publish = vi.spyOn(svc, 'publish').mockResolvedValue(upstream);

    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    const input = ntfyPublishMessage.input.parse({
      topic: 'alerts',
      message: 'world',
      title: 'Hello',
      priority: 4,
      tags: ['warning'],
      click: 'https://example.com/click',
      cache: false,
      firebase: false,
    });

    const result = await ntfyPublishMessage.handler(input, ctx);

    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      topic: 'alerts',
      message: 'world',
      title: 'Hello',
      priority: 4,
      tags: ['warning'],
      click: 'https://example.com/click',
      cache: false,
      firebase: false,
    });
    expect(result).toMatchObject({
      id: 'mid_42',
      topic: 'alerts',
      url: 'https://ntfy.test/alerts',
      title: 'Hello',
      message: 'world',
      tags: ['warning'],
    });
  });

  it('accepts every in-range priority and rejects out-of-range values with one readable issue', () => {
    for (const priority of [1, 2, 3, 4, 5]) {
      expect(ntfyPublishMessage.input.safeParse({ topic: 'alerts', priority }).success).toBe(true);
    }

    for (const priority of [9, 0, -1, 2.5, 'high']) {
      const parsed = ntfyPublishMessage.input.safeParse({ topic: 'alerts', priority });
      expect(parsed.success).toBe(false);
      const issues = parsed.error?.issues ?? [];
      expect(issues).toHaveLength(1);
      expect(issues[0]?.code).not.toBe('invalid_union');
      expect(issues[0]?.message).toBe(
        'Priority must be a whole number from 1 (min) to 5 (max/urgent).',
      );
      expect(issues[0]?.path).toEqual(['priority']);
    }
  });

  it('advertises priority as a single constrained node on both input and output schemas', () => {
    const input = z.toJSONSchema(ntfyPublishMessage.input, { io: 'input' }) as unknown as {
      properties: { priority: Record<string, unknown> };
    };
    const output = z.toJSONSchema(ntfyPublishMessage.output, { io: 'output' }) as unknown as {
      properties: { priority: Record<string, unknown> };
    };
    for (const node of [input.properties.priority, output.properties.priority]) {
      expect(node).toMatchObject({ type: 'integer', minimum: 1, maximum: 5 });
      expect(node).not.toHaveProperty('anyOf');
    }
    // The label mapping rides the input field; the output field documents the echo.
    expect(input.properties.priority.description).toContain('1=min');
  });

  it('uses NTFY_DEFAULT_TOPIC when the input omits topic', async () => {
    process.env.NTFY_DEFAULT_TOPIC = 'fallback_topic';
    const svc = freshService();
    const publish = vi.spyOn(svc, 'publish').mockResolvedValue({
      id: 'm1',
      time: 1,
      topic: 'fallback_topic',
    });

    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    const input = ntfyPublishMessage.input.parse({ message: 'hi' });
    await ntfyPublishMessage.handler(input, ctx);

    expect(publish.mock.calls[0]?.[0].topic).toBe('fallback_topic');
  });

  it('throws ValidationError when neither topic nor NTFY_DEFAULT_TOPIC is set', async () => {
    freshService();
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    const input = ntfyPublishMessage.input.parse({ message: 'hi' });
    await expect(ntfyPublishMessage.handler(input, ctx)).rejects.toThrow(/Topic is required/);
  });

  it('maps a Forbidden upstream to reason `forbidden_topic`', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'publish').mockRejectedValue(forbidden('Topic forbidden'));
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    const input = ntfyPublishMessage.input.parse({ topic: 'protected', message: 'x' });
    await expect(ntfyPublishMessage.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'forbidden_topic' },
    });
  });

  it('maps a RateLimited upstream to reason `rate_limited`', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'publish').mockRejectedValue(rateLimited('Slow down'));
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    const input = ntfyPublishMessage.input.parse({ topic: 'alerts', message: 'x' });
    await expect(ntfyPublishMessage.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'rate_limited' },
    });
  });

  it('maps a 4xx with attachment-too-large hint to `payload_too_large`', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'publish').mockRejectedValue(invalidParams('Attachment too large for topic'));
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    const input = ntfyPublishMessage.input.parse({ topic: 'alerts', message: 'x' });
    await expect(ntfyPublishMessage.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'payload_too_large' },
    });
  });

  it('maps a 413 upstream to `payload_too_large` and keeps the upstream explanation', async () => {
    const svc = freshService();
    // 413 maps to InvalidRequest, which the InvalidParams gate excludes — the
    // canonical `data.status` is what makes this reachable.
    vi.spyOn(svc, 'publish').mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.InvalidRequest,
        'ntfy returned HTTP 413 Request Entity Too Large: JSON body too large; increase your limits with a paid plan',
        {
          status: 413,
          body: '{"code":41303,"http":413,"error":"JSON body too large; increase your limits with a paid plan"}',
        },
      ),
    );
    const result = await runToolContract(ntfyPublishMessage, {
      topic: 'alerts',
      message: 'x'.repeat(100),
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining('JSON body too large'),
          data: {
            reason: 'payload_too_large',
            recovery: { hint: expect.stringContaining('Shorten the message') },
          },
        },
      },
    });
  });

  it('maps an invalid `attach` URL to `invalid_attachment`, not `payload_too_large`', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'publish').mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.InvalidParams,
        'ntfy returned HTTP 400 Bad Request: invalid request: attachment URL is invalid',
        {
          status: 400,
          body: '{"code":40023,"http":400,"error":"invalid request: attachment URL is invalid"}',
        },
      ),
    );
    const result = await runToolContract(ntfyPublishMessage, {
      topic: 'alerts',
      message: 'x',
      attach: 'not-a-url',
    });
    const error = (
      result.structuredContent as {
        error: { message: string; data: { reason: string; recovery: { hint: string } } };
      }
    ).error;
    expect(result.isError).toBe(true);
    expect(error.data.reason).toBe('invalid_attachment');
    expect(error.message).toContain('attachment URL is invalid');
    expect(error.data.recovery.hint).toContain('absolute URL');
    expect(error.data.recovery.hint).not.toContain('Shorten the message');
  });

  it('rejects a multibyte message over 4096 bytes but under 4096 characters', () => {
    // 3000 × 'é' = 3000 UTF-16 units but 6000 UTF-8 bytes.
    expect(() =>
      ntfyPublishMessage.input.parse({ topic: 'alerts', message: 'é'.repeat(3000) }),
    ).toThrow(/byte/i);
  });

  it('accepts a multibyte message that fits inside the 4096-byte limit', () => {
    // 2000 × 'é' = 4000 UTF-8 bytes.
    const input = ntfyPublishMessage.input.parse({
      topic: 'alerts',
      message: 'é'.repeat(2000),
    });
    expect(input.message).toHaveLength(2000);
  });

  it('preserves the upstream explanation on an unclassified 4xx rethrow', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'publish').mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.InvalidParams,
        'ntfy returned HTTP 400 Bad Request: invalid delay parameter: unable to parse delay (see https://ntfy.sh/docs/publish/#scheduled-delivery)',
        {
          status: 400,
          body: '{"code":40004,"http":400,"error":"invalid delay parameter: unable to parse delay"}',
        },
      ),
    );
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    const input = ntfyPublishMessage.input.parse({
      topic: 'alerts',
      message: 'x',
      delay: '9 fortnights',
    });
    const err = (await Promise.resolve(ntfyPublishMessage.handler(input, ctx)).catch(
      (e: unknown) => e,
    )) as McpError;
    expect(err.message).toContain('invalid delay parameter: unable to parse delay');
    expect(err.data?.reason).toBeUndefined();
  });

  it('maps a 4xx with email/phone-verification hint to `unverified_contact`', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'publish').mockRejectedValue(invalidParams('Phone number is not verified'));
    const input = ntfyPublishMessage.input.parse({
      topic: 'alerts',
      message: 'x',
      call: '+15555550100',
    });
    // `call` is a gated side effect — run the approved second round.
    const ctx = await approvedCtx(input);
    await expect(ntfyPublishMessage.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'unverified_contact' },
    });
  });

  it('renders every output field in format()', () => {
    const blocks = ntfyPublishMessage.format!({
      id: 'mid_42',
      time: '2023-11-14T22:13:20.000Z',
      topic: 'alerts',
      url: 'https://ntfy.test/alerts',
      expires: '2023-11-14T22:30:00.000Z',
      sequence_id: 'seq_1',
      scheduled: false,
      title: 'Hello',
      message: 'world',
      priority: 4,
      tags: ['warning', 'cd'],
      click: 'https://example.com/click',
      attachment: {
        name: 'flower.jpg',
        url: 'https://example.com/flower.jpg',
        type: 'image/jpeg',
        size: 1024,
        expires: 1700002000,
      },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('mid_42');
    expect(text).toContain('alerts');
    // Unscheduled publishes report the accept time under the plain `Time:` label.
    expect(text).toContain('Time: 2023-11-14T22:13:20.000Z');
    expect(text).toContain('Cache expires: 2023-11-14T22:30:00.000Z');
    expect(text).not.toContain('Delivers:');
    expect(text).toContain('https://ntfy.test/alerts');
    expect(text).toContain('Hello');
    expect(text).toContain('world');
    expect(text).toContain('high');
    expect(text).toContain('warning');
    expect(text).toContain('flower.jpg');
    expect(text).toContain('seq_1');
  });

  it('synthesizes `scheduled: true` when delay is set, even if upstream omits it', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'publish').mockResolvedValue({
      id: 'mid_43',
      time: 1700000000,
      topic: 'alerts',
    });
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    const input = ntfyPublishMessage.input.parse({
      topic: 'alerts',
      message: 'later',
      delay: '30m',
    });
    const result = await ntfyPublishMessage.handler(input, ctx);
    expect(result.scheduled).toBe(true);
  });

  it('preserves upstream `scheduled: true` when delay is not set', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'publish').mockResolvedValue({
      id: 'mid_44',
      time: 1700000000,
      topic: 'alerts',
      scheduled: true,
    });
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    const input = ntfyPublishMessage.input.parse({ topic: 'alerts', message: 'queued' });
    const result = await ntfyPublishMessage.handler(input, ctx);
    expect(result.scheduled).toBe(true);
  });

  it('omits `scheduled` from the output when neither delay nor upstream flag is set', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'publish').mockResolvedValue({
      id: 'mid_45',
      time: 1700000000,
      topic: 'alerts',
    });
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    const input = ntfyPublishMessage.input.parse({ topic: 'alerts', message: 'now' });
    const result = await ntfyPublishMessage.handler(input, ctx);
    expect(result.scheduled).toBeUndefined();
  });

  it('forwards `base_url` (trailing-slash-normalized) to the service', async () => {
    const svc = freshService();
    const publish = vi.spyOn(svc, 'publish').mockResolvedValue({
      id: 'mid_46',
      time: 1700000000,
      topic: 'alerts',
    });
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    const input = ntfyPublishMessage.input.parse({
      topic: 'alerts',
      message: 'hi',
      base_url: 'https://other.example.com/',
    });
    const result = await ntfyPublishMessage.handler(input, ctx);
    expect(publish.mock.calls[0]?.[1]).toMatchObject({ baseUrl: 'https://other.example.com' });
    expect(result.url).toBe('https://other.example.com/alerts');
  });

  it('passes a rejected `base_url` through even when it reads like another failure', async () => {
    const svc = freshService();
    // The rejection message embeds the URL, and the upstream 4xx classifier
    // matches on keywords like "email" — a locally-rejected base_url must not
    // land on `unverified_contact`.
    vi.spyOn(svc, 'publish').mockRejectedValue(
      validationError(
        'base_url host email.internal.example.com resolves to a non-public address (10.0.0.9)',
        { baseUrlRejected: true, recovery: { hint: 'Target a publicly reachable ntfy server' } },
      ),
    );
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    const input = ntfyPublishMessage.input.parse({
      topic: 'alerts',
      message: 'hi',
      base_url: 'http://email.internal.example.com',
    });
    const err = await Promise.resolve(ntfyPublishMessage.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ message: expect.stringContaining('non-public address') });
    expect((err as { data?: { reason?: string } }).data?.reason).toBeUndefined();
  });

  it.each(['ftp://ntfy.example.com', 'ntfy.example.com', 'https://ntfy example.com'])(
    'rejects the %j base_url at the schema boundary',
    (base_url) => {
      expect(() =>
        ntfyPublishMessage.input.parse({ topic: 'alerts', message: 'hi', base_url }),
      ).toThrow();
    },
  );

  it('falls back to the configured base when a form client sends an empty `base_url`', async () => {
    const svc = freshService();
    const publish = vi.spyOn(svc, 'publish').mockResolvedValue({
      id: 'mid_47',
      time: 1700000000,
      topic: 'alerts',
    });
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    const input = ntfyPublishMessage.input.parse({
      topic: 'alerts',
      message: 'hi',
      base_url: '',
    });
    const result = await ntfyPublishMessage.handler(input, ctx);
    expect(publish.mock.calls[0]?.[1]).toMatchObject({ baseUrl: undefined });
    expect(result.url).toBe('https://ntfy.test/alerts');
  });

  it('maps a retry-exhausted network error to `upstream_unreachable`', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'publish').mockRejectedValue(
      new Error('connection refused (failed after 3 attempts)'),
    );
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    const input = ntfyPublishMessage.input.parse({ topic: 'alerts', message: 'x' });
    await expect(ntfyPublishMessage.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'upstream_unreachable' },
    });
  });

  it('rethrows unclassified errors (not auth/rate/invalid/unreachable) for the framework auto-classifier', async () => {
    const svc = freshService();
    // NotFound is not in the publish contract — it must not be silently
    // rebadged; re-throw lets the auto-classifier bubble it correctly.
    vi.spyOn(svc, 'publish').mockRejectedValue(notFound('vanished'));
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    const input = ntfyPublishMessage.input.parse({ topic: 'alerts', message: 'x' });
    await expect(ntfyPublishMessage.handler(input, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('vanished'),
    });
    await expect(ntfyPublishMessage.handler(input, ctx)).rejects.not.toMatchObject({
      data: expect.objectContaining({ reason: expect.any(String) }),
    });
  });

  it('renders the scheduled banner and actions list in format()', () => {
    const blocks = ntfyPublishMessage.format!({
      id: 'mid_99',
      time: '2026-07-28T13:00:13.000Z',
      topic: 'alerts',
      url: 'https://ntfy.test/alerts',
      scheduled: true,
      actions: [
        { action: 'view', label: 'Open dashboard', url: 'https://example.com/dashboard' },
        { action: 'http', label: 'Acknowledge', url: 'https://example.com/ack', method: 'POST' },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Scheduled');
    expect(text).toContain('Actions:');
    expect(text).toContain('Open dashboard');
    expect(text).toContain('Acknowledge');
    // `time` carries the scheduled delivery time here, so it must not read as
    // the accept time an unscheduled publish reports in the same slot.
    expect(text).toContain('Delivers: 2026-07-28T13:00:13.000Z');
    expect(text).not.toContain('Time:');
  });
});

describe('ntfyPublishMessage consent gate', () => {
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

  /**
   * The ntfy server at the HTTP boundary — every call is one outbound publish,
   * so the call count is how many notifications (and the emails, calls, and
   * buttons they carry) actually went out.
   */
  function fakeUpstream() {
    freshService();
    return vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        Response.json({ id: 'mid_1', time: 1700000000, topic: 'alerts' }),
      );
  }

  /** The JSON body of the `n`th outbound publish. */
  function sentBody(upstream: ReturnType<typeof fakeUpstream>, n = 0): Record<string, unknown> {
    return JSON.parse(String((upstream.mock.calls[n]?.[1] as RequestInit | undefined)?.body));
  }

  const ALICE: AuthContext = { clientId: 'client-a', sub: 'alice', scopes: [] };
  const EMAIL = { email: 'ops@example.com' } as const;

  const HTTP_ACTION = {
    action: 'http',
    label: 'Acknowledge',
    url: 'https://example.com/ack',
    method: 'DELETE',
  } as const;
  const BROADCAST_ACTION = { action: 'broadcast', label: 'Run macro' } as const;

  const inputWith = (extra: Record<string, unknown>) =>
    ntfyPublishMessage.input.parse({ topic: 'alerts', message: 'hi', ...extra });

  /** The elicitation params the first round hands back to the client. */
  function confirmRequest(asked: InputRequiredResult): ElicitParams {
    const request = asked.inputRequests?.confirm;
    if (!request) throw new Error('Expected a `confirm` input request.');
    expect(request.method).toBe('elicitation/create');
    return request.params as ElicitParams;
  }

  function firstRound(extra: Record<string, unknown>): Promise<InputRequiredResult> {
    return expectInputRequired(() =>
      ntfyPublishMessage.handler(
        inputWith(extra),
        createMockContext({ errors: ntfyPublishMessage.errors }),
      ),
    );
  }

  it.each([
    ['email forwarding', { email: 'ops@example.com' }, 'ops@example.com'],
    ['a voice call', { call: '+15551234567' }, '+15551234567'],
    ['a broadcast action', { actions: [BROADCAST_ACTION] }, 'broadcast intent'],
    ['an http action', { actions: [HTTP_ACTION] }, 'https://example.com/ack'],
  ])('asks before publishing %s and names the target', async (_label, extra, expected) => {
    const upstream = fakeUpstream();

    const { message } = confirmRequest(await firstRound(extra));

    expect(message).toContain('alerts');
    expect(message).toContain(expected);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('sends a requestState with the prompt that names a record it stored', async () => {
    const upstream = fakeUpstream();

    const { asked, record } = await askFirst(inputWith(EMAIL));

    expect(asked.requestState).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(record).not.toBeNull();
    expect(upstream).not.toHaveBeenCalled();
  });

  it('names the method of an http action button', async () => {
    fakeUpstream();
    const { message } = confirmRequest(await firstRound({ actions: [HTTP_ACTION] }));
    expect(message).toContain('HTTP DELETE');
  });

  it('lists every side effect when a publish carries more than one', async () => {
    fakeUpstream();
    const { message } = confirmRequest(
      await firstRound({
        email: 'ops@example.com',
        call: '+15551234567',
        actions: [HTTP_ACTION],
      }),
    );
    expect(message).toContain('ops@example.com');
    expect(message).toContain('+15551234567');
    expect(message).toContain('https://example.com/ack');
  });

  it('advertises a single boolean `confirm` field on the prompt schema', async () => {
    fakeUpstream();
    const { requestedSchema } = confirmRequest(await firstRound(EMAIL));

    expect(Object.keys(requestedSchema.properties)).toEqual(['confirm']);
    expect(requestedSchema.properties.confirm?.type).toBe('boolean');
    expect(requestedSchema.required).toEqual(['confirm']);
  });

  it.each([
    ['a plain notification', {}],
    ['a title, tags, and a priority', { title: 'Heads up', tags: ['warning'], priority: 5 }],
    ['a click URL', { click: 'https://example.com/dashboard' }],
    ['a view action', { actions: [{ action: 'view', label: 'Open', url: 'https://example.com' }] }],
    ['a copy action', { actions: [{ action: 'copy', label: 'Copy', value: 'token' }] }],
  ])('publishes %s on the first call, without asking', async (_label, extra) => {
    const upstream = fakeUpstream();
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });

    await ntfyPublishMessage.handler(inputWith(extra), ctx);

    expect(upstream).toHaveBeenCalledOnce();
  });

  it('publishes an ungated notification on each call, with no consent round in between', async () => {
    const upstream = fakeUpstream();
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });

    await ntfyPublishMessage.handler(inputWith({}), ctx);
    await ntfyPublishMessage.handler(inputWith({}), ctx);

    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('publishes once, on the round that redeems its own record', async () => {
    const upstream = fakeUpstream();

    const result = await ntfyPublishMessage.handler(
      inputWith(EMAIL),
      await approvedCtx(inputWith(EMAIL)),
    );

    expect(upstream).toHaveBeenCalledOnce();
    expect(String(upstream.mock.calls[0]?.[0])).toBe('https://ntfy.test/');
    expect(sentBody(upstream)).toMatchObject({ topic: 'alerts', email: 'ops@example.com' });
    expect(result.id).toBe('mid_1');
  });

  it('publishes for the same authenticated caller on both rounds', async () => {
    const upstream = fakeUpstream();

    await ntfyPublishMessage.handler(
      inputWith(EMAIL),
      await approvedCtx(inputWith(EMAIL), ACCEPT, ALICE),
    );

    expect(upstream).toHaveBeenCalledOnce();
  });

  it('asks again when a redeemed round is replayed, and sends nothing more', async () => {
    const upstream = fakeUpstream();
    const ctx = await approvedCtx(inputWith(EMAIL));
    await ntfyPublishMessage.handler(inputWith(EMAIL), ctx);
    const spent = ctx.inputs.state();

    const again = await expectInputRequired(() =>
      ntfyPublishMessage.handler(inputWith(EMAIL), ctx),
    );

    expect(again.requestState).toEqual(expect.any(String));
    expect(again.requestState).not.toBe(spent);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('asks instead of acting on an accepted answer that nothing asked for', async () => {
    const upstream = fakeUpstream();
    const preAnswered = createMockContext({
      errors: ntfyPublishMessage.errors,
      inputResponses: { confirm: ACCEPT },
    });

    const asked = await expectInputRequired(() =>
      ntfyPublishMessage.handler(inputWith(EMAIL), preAnswered),
    );

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

    await expectInputRequired(() => ntfyPublishMessage.handler(inputWith(EMAIL), ctx));

    expect(upstream).not.toHaveBeenCalled();
  });

  it('asks again for a malformed id even when a matching record sits under it', async () => {
    const upstream = fakeUpstream();
    const { record } = await askFirst(inputWith(EMAIL));
    const ctx = await roundTwoCtx('forged', record);

    await expectInputRequired(() => ntfyPublishMessage.handler(inputWith(EMAIL), ctx));

    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ['another email recipient', { email: 'attacker@example.com' }],
    ['another message body', { ...EMAIL, message: 'something else' }],
    ['an added voice call', { ...EMAIL, call: '+15551234567' }],
    ['another topic', { ...EMAIL, topic: 'other' }],
    ['another ntfy server', { ...EMAIL, base_url: 'https://other.example.com' }],
  ])('asks again when the record was minted for %s', async (_label, overrides) => {
    const upstream = fakeUpstream();
    const { asked, record } = await askFirst(inputWith(EMAIL));
    const ctx = await roundTwoCtx(asked.requestState, record);

    await expectInputRequired(() => ntfyPublishMessage.handler(inputWith(overrides), ctx));

    expect(upstream).not.toHaveBeenCalled();
  });

  it('asks again on a record minted by ntfy_manage_message', async () => {
    const upstream = fakeUpstream();
    const first = createMockContext({ errors: ntfyManageMessage.errors });
    const asked = await expectInputRequired(() =>
      ntfyManageMessage.handler(
        ntfyManageMessage.input.parse({
          topic: 'alerts',
          sequence_id: 'seq_1',
          operation: 'delete',
        }),
        first,
      ),
    );
    const record = await first.state.get(recordKey(asked.requestState));
    const ctx = await roundTwoCtx(asked.requestState, record);

    await expectInputRequired(() => ntfyPublishMessage.handler(inputWith(EMAIL), ctx));

    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ['another client', { clientId: 'client-b', sub: 'alice', scopes: [] }],
    ['another subject', { clientId: 'client-a', sub: 'mallory', scopes: [] }],
    ['no authenticated caller', undefined],
  ])('asks again when a record minted for one caller is redeemed by %s', async (_label, auth) => {
    const upstream = fakeUpstream();
    const { asked, record } = await askFirst(inputWith(EMAIL), ALICE);
    const ctx = await roundTwoCtx(asked.requestState, record, ACCEPT, auth);

    await expectInputRequired(() => ntfyPublishMessage.handler(inputWith(EMAIL), ctx));

    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ['decline', { action: 'decline' }],
    ['cancel', { action: 'cancel' }],
    ['accept with confirm=false', { action: 'accept', content: { confirm: false } }],
    ['accept with an unparseable payload', { action: 'accept', content: { confirm: 'yes' } }],
    ['accept with no content at all', { action: 'accept' }],
    ['a roots listing instead of an elicitation', { roots: [] }],
  ])(
    'fails with `consent_declined` on %s against its own record, without publishing',
    async (_label, reply) => {
      const upstream = fakeUpstream();

      await expect(
        ntfyPublishMessage.handler(inputWith(EMAIL), await approvedCtx(inputWith(EMAIL), reply)),
      ).rejects.toMatchObject({ data: { reason: 'consent_declined' } });
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it('does not re-ask after a refusal — a declined round is a dead end', async () => {
    fakeUpstream();
    const declined = ntfyPublishMessage.handler(
      inputWith({ call: '+15551234567' }),
      await approvedCtx(inputWith({ call: '+15551234567' }), { action: 'decline' }),
    );
    await expect(declined).rejects.toMatchObject({ data: { reason: 'consent_declined' } });
    await expect(declined).rejects.not.toMatchObject({ isInputRequiredSignal: true });
  });
});
