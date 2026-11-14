/**
 * @fileoverview Tests for `ntfy_publish_message` — happy path with mocked
 * upstream, default-topic resolution, the priority schema's single-node
 * validation and advertised shape, byte-length message validation,
 * format-rendering (including the scheduled delivery-time label), scheduled-flag
 * synthesis, `timezone` sent as given (blank unsent), the `icon` echo as a code
 * span or absent, base_url override and its scheme validation, the consent gate
 * across both round trips (which inputs prompt and which publish straight
 * through, the first round's `input_required` result and the consent record
 * it stores, every reply on the round that redeems that record, and every
 * round that must ask again instead of publishing — replay, pre-answer,
 * fabricated or malformed id, a record minted for other content — another
 * `timezone` included — target, tool, or caller), and the full contract error mapping
 * (forbidden only from ntfy's own 401/403 envelope / rate-limit /
 * payload-too-large from a 413, an oversize title or tags, or a refused
 * attachment, each with its own hint / invalid-delay / invalid-timezone from
 * ntfy's 40059 envelope / invalid-attachment /
 * unverified-contact from ntfy's refusal phrases, with a credentials hint for an
 * anonymous sender / upstream-unreachable / not-ntfy-endpoint for an answer
 * without ntfy's envelope or ntfy's 40401 / generic rethrow) with the upstream
 * explanation preserved on the error message, a declined publish's message
 * naming no topic, and a 200 reply that is not an ntfy message failing as
 * `upstream_malformed` without a resend.
 * @module tests/tools/ntfy-publish-message.tool
 */

import { type AuthContext, type InputRequiredResult, z } from '@cyanheads/mcp-ts-core';
import {
  invalidParams,
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  expectInputRequired,
  type MockContextOptions,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { resetServerConfig } from '@/config/server-config.js';
import { ntfyManageMessage } from '@/mcp-server/tools/definitions/ntfy-manage-message.tool.js';
import { ntfyPublishMessage } from '@/mcp-server/tools/definitions/ntfy-publish-message.tool.js';
import { initNtfyService, resetNtfyService } from '@/services/ntfy/ntfy-service.js';
import type { NtfyPublishResponse } from '@/services/ntfy/types.js';
import { readCommonMark } from '../helpers/commonmark.js';

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

/** Answer every `fetch` to `ntfy.test` with `respond()`; a call to any other host fails the test. */
function stubNtfyHttp(respond: () => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).hostname !== 'ntfy.test') throw new Error(`Unmocked fetch: ${url}`);
    return respond();
  });
}

/** The JSON body of the `n`th outbound request `upstream` saw. */
function sentBody(upstream: MockInstance<typeof fetch>, n = 0): Record<string, unknown> {
  return JSON.parse(String((upstream.mock.calls[n]?.[1] as RequestInit | undefined)?.body));
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

  /**
   * `forbidden_topic` through the real service: ntfy (or whatever answers in its
   * place) replies to every publish with `respond()`.
   */
  describe("forbidden_topic only on ntfy's own auth envelope (#45)", () => {
    function answer(respond: () => Response) {
      freshService();
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (new URL(url).hostname !== 'ntfy.test') throw new Error(`Unmocked fetch: ${url}`);
        return respond();
      });
    }
    const envelope = (status: number, code: number, error: string) => () =>
      new Response(
        JSON.stringify({
          code,
          http: status,
          error,
          link: 'https://ntfy.sh/docs/publish/#authentication',
        }),
        { status, headers: { 'content-type': 'application/json' } },
      );
    const HINT = ntfyPublishMessage.errors?.find((e) => e.reason === 'forbidden_topic')
      ?.recovery as string;

    async function failed() {
      const result = await runToolContract(ntfyPublishMessage, { topic: 'alerts', message: 'x' });
      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as {
        error: { code: number; message: string; data: Record<string, unknown> };
      };
      const text = readCommonMark(
        result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
      );
      return { error, text };
    }

    it.each([
      [401, 40101, 'unauthorized'],
      [403, 40301, 'forbidden'],
    ])(
      "maps ntfy's %i envelope (%i) to `forbidden_topic` on both surfaces",
      async (status, code, text) => {
        answer(envelope(status, code, text));
        const { error, text: rendered } = await failed();
        expect(error.code).toBe(JsonRpcErrorCode.Forbidden);
        expect(error.data.reason).toBe('forbidden_topic');
        expect(error.data.recovery).toEqual({ hint: HINT });
        expect(error.message).toContain(`HTTP ${status}`);
        expect(error.message).toContain(
          `: ${text} (see https://ntfy.sh/docs/publish/#authentication)`,
        );
        expect(rendered).toContain(`Recovery: ${HINT}`);
        expect(rendered).toContain('reason forbidden_topic');
      },
    );

    it("fails a proxy's HTML 403 without `forbidden_topic`, keeping the status in the message", async () => {
      answer(
        () =>
          new Response(
            '<html>\n<head><title>403 Forbidden</title></head>\n<body>\n<center><h1>403 Forbidden</h1></center>\n<hr><center>nginx</center>\n</body>\n</html>\n',
            { status: 403, headers: { 'content-type': 'text/html' } },
          ),
      );
      const { error, text } = await failed();
      expect(error.code).toBe(JsonRpcErrorCode.Forbidden);
      // Something other than ntfy answered (#55): its own reason, never the auth one.
      expect(error.data.reason).toBe('not_ntfy_endpoint');
      expect(error.data.recovery).toEqual({
        hint: ntfyPublishMessage.errors?.find((e) => e.reason === 'not_ntfy_endpoint')?.recovery,
      });
      expect(error.message).toContain('HTTP 403');
      expect(text).toContain('HTTP 403');
      expect(text).not.toContain('forbidden_topic');
      expect(text).not.toContain('NTFY_AUTH_TOKEN');
    });

    it('falls back to a message without the topic when ntfy gave no explanation', async () => {
      const svc = freshService();
      vi.spyOn(svc, 'publish').mockRejectedValue(
        new McpError(JsonRpcErrorCode.Forbidden, '', {
          status: 403,
          body: '{"code":40301,"http":403,"error":"forbidden"}',
        }),
      );
      const result = await runToolContract(ntfyPublishMessage, { topic: '_secret_', message: 'x' });
      const { error } = result.structuredContent as {
        error: { message: string; data: { reason?: string } };
      };
      expect(error).toMatchObject({
        message: 'ntfy refused access to the topic.',
        data: { reason: 'forbidden_topic' },
      });
      const text = readCommonMark(
        result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
      );
      expect(text).toContain('Error: ntfy refused access to the topic.');
    });
  });

  /**
   * #55 through the real service, with retries allowed so the single request
   * shows none was resent: example.com's 405 to `POST /`, Python
   * `http.server`'s 501, and ntfy's own 40401 for a base URL with a path.
   */
  describe('not_ntfy_endpoint (#55)', () => {
    const HINT = ntfyPublishMessage.errors?.find((e) => e.reason === 'not_ntfy_endpoint')
      ?.recovery as string;

    it.each([
      [
        'an HTML 405',
        405,
        'Method Not Allowed',
        '<!doctype html><html lang="en"><head><title>Example Domain</title></head><body><h1>Example Domain</h1></body></html>',
        JsonRpcErrorCode.InvalidRequest,
        'ntfy.test returned HTTP 405 Method Not Allowed.',
      ],
      [
        'an HTML 501',
        501,
        "Unsupported method ('POST')",
        "<!DOCTYPE HTML><html><head><title>Error response</title></head><body><p>Error code: 501</p><p>Message: Unsupported method ('POST').</p></body></html>",
        JsonRpcErrorCode.ServiceUnavailable,
        "ntfy.test returned HTTP 501 Unsupported method ('POST').",
      ],
      [
        "ntfy's own 40401",
        404,
        'Not Found',
        '{"code":40401,"http":404,"error":"page not found"}',
        JsonRpcErrorCode.NotFound,
        'ntfy returned HTTP 404 Not Found: page not found',
      ],
    ])(
      'fails %s once, with its status-derived code and declared recovery on both surfaces',
      async (_label, status, statusText, body, code, message) => {
        initNtfyService({
          servers: [{ baseUrl: 'https://ntfy.test' }],
          requestTimeoutMs: 1000,
          maxRetries: 3,
        } as never);
        const upstream = stubNtfyHttp(
          () =>
            new Response(body, { status, statusText, headers: { 'content-type': 'text/html' } }),
        );
        const result = await runToolContract(ntfyPublishMessage, { topic: 'alerts', message: 'x' });
        expect(upstream).toHaveBeenCalledTimes(1);
        expect(result.isError).toBe(true);
        const { error } = result.structuredContent as {
          error: { code: number; message: string; data: Record<string, unknown> };
        };
        expect(error.code).toBe(code);
        expect(error.message).toBe(message);
        expect(error.data).toMatchObject({
          reason: 'not_ntfy_endpoint',
          retryable: false,
          recovery: { hint: HINT },
        });
        for (const term of ['`base_url`', '`NTFY_BASE_URL`', 'proxy']) {
          expect(HINT).toContain(term);
        }
        const text = readCommonMark(
          result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
        );
        expect(text).toContain(`Error: ${message}`);
        expect(text).toContain(`Recovery: ${HINT}`);
        expect(text).toContain('(reason not_ntfy_endpoint · not retryable)');
        expect(JSON.stringify(result)).not.toContain('<title>');
      },
    );
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
          body: '{"code":40013,"http":400,"error":"invalid request: attachment URL is invalid"}',
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
        'ntfy returned HTTP 400 Bad Request: cannot disable cache for delayed message',
        {
          status: 400,
          body: '{"code":40002,"http":400,"error":"cannot disable cache for delayed message"}',
        },
      ),
    );
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    const input = ntfyPublishMessage.input.parse({
      topic: 'alerts',
      message: 'x',
      delay: '30m',
      cache: false,
    });
    const err = (await Promise.resolve(ntfyPublishMessage.handler(input, ctx)).catch(
      (e: unknown) => e,
    )) as McpError;
    expect(err.message).toContain('cannot disable cache for delayed message');
    expect(err.data?.reason).toBeUndefined();
  });

  describe('ntfy 400 rejections read through the contract', () => {
    /** An ntfy 400 as `httpErrorFromResponse` raises it: status-line message plus the JSON body. */
    function ntfy400(code: number, error: string, link?: string) {
      return new McpError(
        JsonRpcErrorCode.InvalidParams,
        `ntfy returned HTTP 400 Bad Request: ${error}${link ? ` (see ${link})` : ''}`,
        {
          status: 400,
          body: JSON.stringify({ code, http: 400, error, ...(link ? { link } : {}) }),
        },
      );
    }

    /**
     * The contract envelope of one failed publish: the JSON error and the
     * `content[]` text as a CommonMark parse reads it (the framework escapes
     * Markdown punctuation in error text, so the raw bytes carry backslashes).
     */
    async function failedPublish(rejection: McpError, input: Record<string, unknown>) {
      const svc = freshService();
      vi.spyOn(svc, 'publish').mockRejectedValue(rejection);
      const result = await runToolContract(ntfyPublishMessage, { topic: 'alerts', ...input });
      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as {
        error: {
          code: number;
          message: string;
          data: { reason?: string; recovery?: { hint: string } };
        };
      };
      const text = readCommonMark(
        result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
      );
      return { error, text };
    }

    const DELAY_DOCS = 'https://ntfy.sh/docs/publish/#scheduled-delivery';
    const DELAY_HINT = ntfyPublishMessage.errors?.find((e) => e.reason === 'invalid_delay')
      ?.recovery as string;

    it.each([
      [40004, 'invalid delay parameter: unable to parse delay', '9 fortnights'],
      [40005, 'invalid delay parameter: too small, please refer to the docs', '1s'],
      [40006, 'invalid delay parameter: too large, please refer to the docs', '4d'],
    ])(
      'maps %i to `invalid_delay` with its hint on both surfaces',
      async (code, upstream, delay) => {
        const { error, text } = await failedPublish(ntfy400(code, upstream, DELAY_DOCS), {
          message: 'x',
          delay,
        });
        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.data.reason).toBe('invalid_delay');
        expect(error.data.recovery?.hint).toBe(DELAY_HINT);
        // The upstream explanation and its docs link stay in the message.
        expect(error.message).toContain(upstream);
        expect(error.message).toContain(DELAY_DOCS);
        expect(text).toContain(`Recovery: ${DELAY_HINT}`);
        expect(text).toContain('reason invalid_delay');
      },
    );

    it('declares a delay hint that names the accepted forms and both bounds', () => {
      expect(DELAY_HINT).toContain('`1d`');
      expect(DELAY_HINT).toContain('10 seconds');
      expect(DELAY_HINT).toContain('3 days');
      expect(DELAY_HINT).not.toContain('Shorten the message');
    });

    it.each([
      [40002, 'cannot disable cache for delayed message', { delay: '30m', cache: false }],
      [40003, 'delayed e-mail notifications are not supported', { delay: '30m' }],
      [
        40015,
        'invalid request: attachment expiry before delayed delivery date',
        { delay: '30m', attach: 'https://example.com/a.jpg' },
      ],
      [40037, 'invalid request: delayed call notifications are not supported', { delay: '30m' }],
    ])(
      'never maps %i to `invalid_delay` — it reaches the caller as ntfy worded it',
      async (code, upstream, input) => {
        const { error, text } = await failedPublish(ntfy400(code, upstream, DELAY_DOCS), {
          message: 'x',
          ...input,
        });
        // Unclassified: ntfy's own 400, with no contract reason or hint borrowed
        // from another entry.
        expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(error.data.reason).toBeUndefined();
        expect(error.data.recovery).toBeUndefined();
        expect(error.message).toContain(upstream);
        expect(text).toContain(upstream);
      },
    );

    const LIMITS_DOCS = 'https://ntfy.sh/docs/publish/#limitations';

    it('names the title, not the message body, when ntfy rejects the title as too large (40057)', async () => {
      const { error, text } = await failedPublish(
        ntfy400(40057, 'invalid request: title is too large', LIMITS_DOCS),
        { message: 'x', title: 'T'.repeat(5000) },
      );
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('payload_too_large');
      expect(error.message).toContain('title is too large');
      const hint = error.data.recovery?.hint ?? '';
      expect(hint).toContain('`title`');
      expect(hint).not.toContain('`tags`');
      expect(hint).not.toContain('Shorten the message');
      expect(hint).not.toContain('`attach`');
      expect(text).toContain(`Recovery: ${hint}`);
    });

    it('names the tags, not the message body, when ntfy rejects the tags as too large (40058)', async () => {
      const { error, text } = await failedPublish(
        ntfy400(40058, 'invalid request: tags are too large', LIMITS_DOCS),
        { message: 'x', tags: Array.from({ length: 10 }, () => 'a'.repeat(200)) },
      );
      expect(error.data.reason).toBe('payload_too_large');
      expect(error.message).toContain('tags are too large');
      const hint = error.data.recovery?.hint ?? '';
      expect(hint).toContain('`tags`');
      expect(hint).not.toContain('`title`');
      expect(hint).not.toContain('Shorten the message');
      expect(hint).not.toContain('`attach`');
      expect(text).toContain(`Recovery: ${hint}`);
    });

    it('keeps the message-body hint on a 413, on both surfaces', async () => {
      const { error, text } = await failedPublish(
        new McpError(
          JsonRpcErrorCode.InvalidRequest,
          'ntfy returned HTTP 413 Request Entity Too Large: JSON body too large',
          { status: 413, body: '{"code":41303,"http":413,"error":"JSON body too large"}' },
        ),
        { message: 'x' },
      );
      const bodyHint =
        'Shorten the message (≤4096 bytes plain) or host the long content as an external URL via `attach`.';
      expect(error.data.reason).toBe('payload_too_large');
      expect(error.data.recovery?.hint).toBe(bodyHint);
      expect(text).toContain(`Recovery: ${bodyHint}`);
    });

    it('declares a `payload_too_large` entry that covers the body, the title, the tags, and an attachment', () => {
      const entry = ntfyPublishMessage.errors?.find((e) => e.reason === 'payload_too_large');
      for (const field of ['title', 'tags']) {
        expect(entry?.when).toContain(`\`${field}\``);
        expect(entry?.recovery).toContain(`\`${field}\``);
      }
      expect(entry?.recovery).toContain('`attach`');
      expect(entry?.when).toContain('bandwidth quota');
      expect(entry?.recovery).toContain('`filename`');
      expect(entry?.recovery).toContain('24 hours');
    });
  });

  /**
   * ntfy's refusals of an `email`, a `call`, or an attachment, through the real
   * service against ntfy's real `{ code, http, error, link }` envelopes. The
   * label is read from ntfy's answer, so most cases leave `email`/`call` off and
   * run the contract in one round; the gated round is pinned at the end.
   */
  describe('e-mail, call, and attachment refusals (#40)', () => {
    function refuse(status: number, code: number, error: string, link?: string) {
      freshService();
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (new URL(url).hostname !== 'ntfy.test') throw new Error(`Unmocked fetch: ${url}`);
        return new Response(
          JSON.stringify({ code, http: status, error, ...(link ? { link } : {}) }),
          { status, headers: { 'content-type': 'application/json' } },
        );
      });
    }

    async function failed(input: Record<string, unknown> = {}) {
      const result = await runToolContract(ntfyPublishMessage, {
        topic: 'alerts',
        message: 'x',
        ...input,
      });
      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as {
        error: {
          code: number;
          message: string;
          data: { reason?: string; recovery?: { hint: string } };
        };
      };
      const text = readCommonMark(
        result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
      );
      return { error, text };
    }

    const PHONE_DOCS = 'https://ntfy.sh/docs/publish/#phone-calls';
    const EMAIL_DOCS = 'https://ntfy.sh/docs/publish/#e-mail-notifications';
    const DECLARED = ntfyPublishMessage.errors?.find((e) => e.reason === 'unverified_contact')
      ?.recovery as string;

    it.each([
      [40032, 'invalid request: calling is disabled', 'https://ntfy.sh/docs/config/#phone-calls'],
      [40033, 'invalid request: phone number invalid', PHONE_DOCS],
      [
        40001,
        'e-mail notifications are not enabled',
        'https://ntfy.sh/docs/config/#e-mail-notifications',
      ],
      [40050, 'invalid request: invalid e-mail address', EMAIL_DOCS],
    ])(
      "fails %i with no reason, in ntfy's own words and link, on both surfaces",
      async (code, upstream, link) => {
        refuse(400, code, upstream, link);
        const { error, text } = await failed();
        expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(error.data.reason).toBeUndefined();
        expect(error.data.recovery).toBeUndefined();
        expect(error.message).toContain(`${upstream} (see ${link})`);
        expect(text).toContain(`${upstream} (see ${link})`);
        expect(text).not.toContain('Recovery:');
      },
    );

    it.each([
      [
        40034,
        'invalid request: phone number not verified, or no matching verified numbers found',
        PHONE_DOCS,
      ],
      [40052, 'invalid request: email address not verified', EMAIL_DOCS],
    ])(
      'maps %i to `unverified_contact` with the declared recovery',
      async (code, upstream, link) => {
        refuse(400, code, upstream, link);
        const { error, text } = await failed();
        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.data.reason).toBe('unverified_contact');
        expect(error.data.recovery?.hint).toBe(DECLARED);
        expect(error.message).toContain(upstream);
        expect(text).toContain(`Recovery: ${DECLARED}`);
      },
    );

    it.each([
      [40035, 'invalid request: anonymous phone calls are not allowed', PHONE_DOCS],
      [40053, 'invalid request: anonymous email sending is not allowed', EMAIL_DOCS],
    ])(
      'maps %i to `unverified_contact` with a hint naming ntfy credentials, on both surfaces',
      async (code, upstream, link) => {
        refuse(400, code, upstream, link);
        const { error, text } = await failed();
        expect(error.data.reason).toBe('unverified_contact');
        const hint = error.data.recovery?.hint ?? '';
        expect(hint).toContain('NTFY_AUTH_TOKEN');
        expect(hint).toContain('NTFY_SERVERS');
        expect(hint).not.toBe(DECLARED);
        expect(hint).not.toContain('verify');
        expect(error.message).toContain(upstream);
        expect(text).toContain(`Recovery: ${hint}`);
      },
    );

    it('maps 41301 to `payload_too_large` with the attachment hint, not the body hint', async () => {
      refuse(
        413,
        41301,
        'attachment too large, or bandwidth limit reached',
        'https://ntfy.sh/docs/publish/#limitations',
      );
      const { error, text } = await failed({ filename: 'a.txt' });
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('payload_too_large');
      expect(error.message).toContain('attachment too large, or bandwidth limit reached');
      const hint = error.data.recovery?.hint ?? '';
      expect(hint).toContain('`filename`');
      expect(hint).toContain('`attach`');
      expect(hint).toContain('24 hours');
      expect(hint).not.toContain('Shorten the message');
      expect(text).toContain(`Recovery: ${hint}`);
    });

    it.each([
      [41302, 'Matrix request is larger than the max allowed length'],
      [41303, 'JSON body too large'],
    ])('keeps the message-body hint on the 413 %i', async (code, upstream) => {
      refuse(413, code, upstream);
      const { error, text } = await failed();
      expect(error.data.reason).toBe('payload_too_large');
      expect(error.data.recovery?.hint).toBe(
        'Shorten the message (≤4096 bytes plain) or host the long content as an external URL via `attach`.',
      );
      expect(text).toContain('Recovery: Shorten the message');
    });

    it.each([
      [
        40034,
        'invalid request: phone number not verified, or no matching verified numbers found',
        'unverified_contact',
      ],
      [40033, 'invalid request: phone number invalid', undefined],
    ])(
      'labels %i the same on the approved round of a gated `call`',
      async (code, upstream, reason) => {
        const upstreamFetch = refuse(400, code, upstream, PHONE_DOCS);
        const input = ntfyPublishMessage.input.parse({
          topic: 'alerts',
          message: 'x',
          call: '+15555550100',
        });
        const err = (await Promise.resolve(
          ntfyPublishMessage.handler(input, await approvedCtx(input)),
        ).catch((e: unknown) => e)) as McpError;
        expect(upstreamFetch).toHaveBeenCalledTimes(1);
        expect(err.message).toContain(upstream);
        expect(err.data?.reason).toBe(reason);
      },
    );
  });

  /**
   * A publish carrying `filename` without `attach`, which ntfy stores as a file
   * and from v2.20.0 fails writing with its own 500 `50001` (#46). Only the
   * network is stubbed, so the service's resend decision runs: the request
   * count is how many publishes went out.
   */
  describe('`filename` without `attach` (#46)', () => {
    function answer(respond: () => Response, maxRetries = 3) {
      initNtfyService({
        servers: [{ baseUrl: 'https://ntfy.test' }],
        requestTimeoutMs: 1000,
        maxRetries,
      } as never);
      return stubNtfyHttp(respond);
    }

    /** ntfy.sh's answer to a JSON publish carrying `filename` without `attach`. */
    const fileWriteFailure = () =>
      new Response('{"code":50001,"http":500,"error":"internal server error"}', {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });

    async function failed(input: Record<string, unknown>) {
      const result = await runToolContract(ntfyPublishMessage, {
        topic: 'alerts',
        message: 'probe',
        ...input,
      });
      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as {
        error: {
          code: number;
          message: string;
          data: { reason?: string; recovery?: { hint: string } };
        };
      };
      const text = readCommonMark(
        result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
      );
      return { error, text };
    }

    /** `invalid_attachment`'s recovery as it read before #46, for a malformed `attach` URL. */
    const URL_HINT =
      'Pass `attach` an absolute URL (`https://host/path/file.jpg`) to an already-hosted file — the recipient device fetches it, so a local path will not work, and shortening the message will not help.';

    it.each([
      ['no `attach`', {}],
      ['an empty `attach`', { attach: '' }],
      ['a whitespace-only `attach`', { attach: '   ' }],
    ])(
      "fails ntfy's 500 `50001` with %s as `invalid_attachment` after one request, on both surfaces",
      async (_label, extra) => {
        const upstream = answer(fileWriteFailure);
        const { error, text } = await failed({ filename: 'probe.txt', ...extra });
        expect(upstream).toHaveBeenCalledTimes(1);
        // A blank `attach` is never sent.
        expect(sentBody(upstream)).toEqual({
          topic: 'alerts',
          message: 'probe',
          filename: 'probe.txt',
        });
        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.data.reason).toBe('invalid_attachment');
        expect(error.message).toContain('internal server error');
        const hint = error.data.recovery?.hint ?? '';
        expect(hint).toContain("the hosted file's URL as `attach` alongside `filename`");
        expect(hint).toContain('drop `filename`');
        expect(hint).toContain('v2.20.0');
        expect(hint).not.toBe(URL_HINT);
        expect(hint).not.toContain('Shorten the message');
        expect(text).toContain(`Recovery: ${hint}`);
        expect(text).toContain('reason invalid_attachment');
        expect(text).not.toContain('upstream_unreachable');
      },
    );

    it("keeps a 500 without ntfy's envelope on `upstream_unreachable`", async () => {
      const upstream = answer(
        () => new Response('boom', { status: 500, headers: { 'content-type': 'text/plain' } }),
        0,
      );
      const { error } = await failed({ filename: 'probe.txt' });
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data.reason).toBe('upstream_unreachable');
    });

    it('keeps the malformed-URL hint on 40013, without the `filename` advice', async () => {
      answer(
        () =>
          new Response(
            '{"code":40013,"http":400,"error":"invalid request: attachment URL is invalid"}',
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
      );
      const { error, text } = await failed({ attach: 'not-a-url', filename: 'a.jpg' });
      expect(error.data.reason).toBe('invalid_attachment');
      expect(error.data.recovery?.hint).toBe(URL_HINT);
      expect(text).toContain(`Recovery: ${URL_HINT}`);
    });

    it('returns the hosted file when the ntfy server stores the publish', async () => {
      // ntfy v2.19.2 and earlier store the message as a file and answer 200.
      const attachment = {
        name: 'probe.txt',
        type: 'text/plain; charset=utf-8',
        size: 5,
        expires: 1_794_647_316,
        url: 'https://ntfy.test/file/rtonOynHg48f.txt',
      };
      const upstream = answer(() =>
        Response.json({
          id: 'rtonOynHg48f',
          time: 1_794_636_516,
          expires: 1_794_679_716,
          event: 'message',
          topic: 'alerts',
          message: 'You received a file: probe.txt',
          attachment,
        }),
      );
      const result = await runToolContract(ntfyPublishMessage, {
        topic: 'alerts',
        message: 'probe',
        filename: 'probe.txt',
      });
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        id: 'rtonOynHg48f',
        message: 'You received a file: probe.txt',
        attachment,
      });
    });

    it.each([
      ['an empty', ''],
      ['a whitespace-only', '   '],
    ])(
      'publishes %s `filename` as a plain message, without the field',
      async (_label, filename) => {
        const upstream = answer(() =>
          Response.json({ id: 'mid_1', time: 1_700_000_000, event: 'message', topic: 'alerts' }),
        );
        const result = await runToolContract(ntfyPublishMessage, {
          topic: 'alerts',
          message: 'probe',
          filename,
        });
        expect(result.isError).toBeFalsy();
        expect(upstream).toHaveBeenCalledTimes(1);
        expect(sentBody(upstream)).toEqual({ topic: 'alerts', message: 'probe' });
      },
    );

    it('declares `invalid_attachment` for a malformed `attach` URL and for `filename` without `attach`', () => {
      const entry = ntfyPublishMessage.errors?.find((e) => e.reason === 'invalid_attachment');
      expect(entry?.when).toContain('`attach` URL');
      expect(entry?.when).toContain('`filename`');
      expect(entry?.recovery).toContain('absolute URL');
      expect(entry?.recovery).toContain('drop `filename`');
    });

    it('describes what `filename` does without `attach`, and which ntfy versions fail it', () => {
      const description = ntfyPublishMessage.input.shape.filename.description ?? '';
      expect(description).toContain('Without `attach`, ntfy stores the message body');
      expect(description).toContain('v2.20.0');
    });
  });

  /**
   * `timezone`, the zone ntfy reads a natural-language `delay` in (#50). Only
   * the network is stubbed, so the JSON body is what the service sends and the
   * error is what `ntfyHttpError` raises from ntfy's envelope.
   */
  describe('`timezone` for a natural-language `delay` (#50)', () => {
    function answer(respond: () => Response) {
      freshService();
      return stubNtfyHttp(respond);
    }

    /** ntfy.sh's reply to `delay: "tomorrow, 10am"` with `timezone: "Asia/Tokyo"`: 01:00 UTC. */
    const tokyoReply = () =>
      Response.json({
        id: 't0g8p5U1GEHh',
        time: 1_794_704_400,
        expires: 1_794_747_600,
        event: 'message',
        topic: 'alerts',
        message: 'tz tokyo',
      });

    const DELAY = 'tomorrow, 10am';

    it('sends `timezone` beside `delay` and relays the delivery time ntfy computed, on both surfaces', async () => {
      const upstream = answer(tokyoReply);
      const result = await runToolContract(ntfyPublishMessage, {
        topic: 'alerts',
        message: 'tz tokyo',
        delay: DELAY,
        timezone: 'Asia/Tokyo',
      });
      expect(result.isError).toBeFalsy();
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(sentBody(upstream)).toEqual({
        topic: 'alerts',
        message: 'tz tokyo',
        delay: DELAY,
        timezone: 'Asia/Tokyo',
      });
      expect(result.structuredContent).toMatchObject({
        time: '2026-11-15T01:00:00.000Z',
        scheduled: true,
      });
      const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      expect(text).toContain('Delivers: 2026-11-15T01:00:00.000Z');
    });

    it.each([
      ['a lowercase name', 'america/los_angeles'],
      ['`Local`', 'Local'],
      ['a space-padded name', '  America/Los_Angeles  '],
      ['a legacy alias', 'US/Pacific'],
    ])('sends %s exactly as given, leaving the check to ntfy', async (_label, timezone) => {
      const upstream = answer(tokyoReply);
      const result = await runToolContract(ntfyPublishMessage, {
        topic: 'alerts',
        message: 'x',
        delay: DELAY,
        timezone,
      });
      expect(result.isError).toBeFalsy();
      expect(sentBody(upstream)).toEqual({ topic: 'alerts', message: 'x', delay: DELAY, timezone });
    });

    it.each([
      ['an empty', ''],
      ['a whitespace-only', '   '],
    ])('publishes %s `timezone` as if unset, without the field', async (_label, timezone) => {
      const upstream = answer(tokyoReply);
      const result = await runToolContract(ntfyPublishMessage, {
        topic: 'alerts',
        message: 'x',
        delay: DELAY,
        timezone,
      });
      expect(result.isError).toBeFalsy();
      expect(sentBody(upstream)).toEqual({ topic: 'alerts', message: 'x', delay: DELAY });
    });

    /** The recovery #50 specifies for `invalid_timezone`. */
    const TIMEZONE_HINT =
      "Pass `timezone` as an IANA zone name spelled as the tz database spells it (`America/New_York`, `Asia/Tokyo`, `UTC`; ntfy matches case-sensitively), or drop it to read `delay` in the ntfy server's own timezone.";

    it("fails ntfy's 40059 as `invalid_timezone`, its recovery on both surfaces", async () => {
      const upstream = answer(
        () =>
          new Response(
            '{"code":40059,"http":400,"error":"invalid request: invalid timezone","link":"https://ntfy.sh/docs/publish/#scheduled-delivery"}',
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
      );
      const result = await runToolContract(ntfyPublishMessage, {
        topic: 'alerts',
        message: 'x',
        delay: DELAY,
        timezone: 'america/los_angeles',
      });
      expect(result.isError).toBe(true);
      expect(upstream).toHaveBeenCalledTimes(1);
      const { error } = result.structuredContent as {
        error: {
          code: number;
          message: string;
          data: { reason?: string; recovery?: { hint: string } };
        };
      };
      const text = readCommonMark(
        result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
      );
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('invalid_timezone');
      expect(error.data.recovery?.hint).toBe(TIMEZONE_HINT);
      // ntfy's own explanation and docs link stay in the message.
      expect(error.message).toContain(
        'invalid request: invalid timezone (see https://ntfy.sh/docs/publish/#scheduled-delivery)',
      );
      expect(text).toContain('invalid request: invalid timezone');
      expect(text).toContain(`Recovery: ${TIMEZONE_HINT}`);
      expect(text).toContain('reason invalid_timezone');
      // The topic name works as an access token, so the failure never carries it.
      expect(JSON.stringify(error)).not.toContain('alerts');
      expect(text).not.toContain('alerts');
    });

    it('names RFC 3339 with its required offset in the `delay` description and the `invalid_delay` recovery', () => {
      const description = ntfyPublishMessage.input.shape.delay.description ?? '';
      const recovery = ntfyPublishMessage.errors?.find((e) => e.reason === 'invalid_delay')
        ?.recovery as string;
      for (const text of [description, recovery]) {
        expect(text).toContain('RFC 3339');
        expect(text).toContain('`Z`');
        expect(text).toContain('`±hh:mm`');
      }
      expect(description).toContain('`timezone`');
    });
  });

  /** ntfy's `icon` on the publish reply (#49), through the real service with only the network stubbed. */
  describe('`icon` on the publish output (#49)', () => {
    function reply(echo: Record<string, unknown>) {
      freshService();
      stubNtfyHttp(() =>
        Response.json({
          id: 'Z4MeYFR5eSYs',
          time: 1_794_636_448,
          expires: 1_794_679_648,
          event: 'message',
          topic: 'alerts',
          ...echo,
        }),
      );
    }

    async function published(input: Record<string, unknown>) {
      const result = await runToolContract(ntfyPublishMessage, { topic: 'alerts', ...input });
      expect(result.isError).toBeFalsy();
      const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      return { structured: result.structuredContent as Record<string, unknown>, text };
    }

    it('echoes the icon ntfy returned, as a code span on the line after the click URL', async () => {
      // ntfy.sh's reply to a publish setting both, fields as captured.
      reply({
        message: 'icon probe raw',
        click: 'https://example.com/click',
        icon: 'https://example.com/icon.png',
      });
      const { structured, text } = await published({
        message: 'icon probe raw',
        click: 'https://example.com/click',
        icon: 'https://example.com/icon.png',
      });
      expect(structured.icon).toBe('https://example.com/icon.png');
      const lines = text.split('\n');
      const click = lines.indexOf('Click action: `https://example.com/click`');
      expect(click).toBeGreaterThan(-1);
      expect(lines[click + 1]).toBe('Icon: `https://example.com/icon.png`');
    });

    it('renders the icon after the message body when no click URL was set', async () => {
      reply({ message: 'no click', icon: 'https://example.com/icon.png' });
      const { structured, text } = await published({
        message: 'no click',
        icon: 'https://example.com/icon.png',
      });
      expect(structured.icon).toBe('https://example.com/icon.png');
      expect(text).not.toContain('Click action:');
      expect(text.endsWith('\n\nIcon: `https://example.com/icon.png`')).toBe(true);
    });

    it.each([
      [
        'Markdown image syntax',
        '![pwn](https://evil.example/p.png)',
        '`![pwn](https://evil.example/p.png)`',
      ],
      ['a backtick', 'https://e.x/`a`.png', '``https://e.x/`a`.png``'],
    ])(
      'keeps an icon carrying %s a literal code span, never an image or link',
      async (_label, icon, span) => {
        reply({ message: 'x', icon });
        const { structured, text } = await published({ message: 'x', icon });
        expect(structured.icon).toBe(icon);
        expect(text).toContain(`Icon: ${span}`);
      },
    );

    it('omits `icon` from both surfaces when ntfy returns none', async () => {
      reply({ message: 'plain', click: 'https://example.com/click' });
      const { structured, text } = await published({
        message: 'plain',
        click: 'https://example.com/click',
      });
      expect(structured.icon).toBeUndefined();
      // What reaches the client: the serialized result carries no `icon` key.
      expect(JSON.parse(JSON.stringify(structured))).not.toHaveProperty('icon');
      expect(text).not.toContain('Icon:');
    });

    it('relays the icon ntfy returned, not the one the input sent', async () => {
      reply({ message: 'x', icon: 'https://example.com/stored.png' });
      const { structured, text } = await published({
        message: 'x',
        icon: 'https://example.com/sent.png',
      });
      expect(structured.icon).toBe('https://example.com/stored.png');
      expect(text).toContain('Icon: `https://example.com/stored.png`');
      expect(text).not.toContain('sent.png');
    });

    it('omits `icon` from both surfaces when ntfy returns none, even though the input set one', async () => {
      reply({ message: 'x' });
      const { structured, text } = await published({
        message: 'x',
        icon: 'https://example.com/sent.png',
      });
      expect(JSON.parse(JSON.stringify(structured))).not.toHaveProperty('icon');
      expect(text).not.toContain('Icon:');
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
      icon: 'https://example.com/icon.png',
      attachment: {
        name: 'flower.jpg',
        url: 'https://example.com/flower.jpg',
        type: 'image/jpeg',
        size: 1024,
        expires: 1700002000,
      },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Icon: `https://example.com/icon.png`');
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

  it('sends a blank `delay` as unset and reports no schedule', async () => {
    const svc = freshService();
    const publish = vi.spyOn(svc, 'publish').mockResolvedValue({
      id: 'mid_44',
      time: 1700000000,
      topic: 'alerts',
    });
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    const input = ntfyPublishMessage.input.parse({ topic: 'alerts', message: 'now', delay: '   ' });
    const result = await ntfyPublishMessage.handler(input, ctx);
    expect(publish.mock.calls[0]?.[0].delay).toBeUndefined();
    expect(result.scheduled).toBeUndefined();
    const blocks = ntfyPublishMessage.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Time: 2023-11-14T22:13:20.000Z');
    expect(text).not.toContain('Delivers:');
  });

  it('omits `scheduled` from the output when no delay is set', async () => {
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

  it('describes `base_url` credential forwarding as keyed on every registered server', () => {
    const description = ntfyPublishMessage.input.shape.base_url.description ?? '';
    expect(description).toContain('only when the override matches a registered server');
    expect(description).toContain('`NTFY_SERVERS` entry');
    expect(description).not.toContain('differs from the configured base URL');
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

  it('maps a call that ran out of its deadline to `upstream_unreachable`', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'publish').mockRejectedValue(
      timeout('ntfy publish exceeded its 50000ms retry deadline after 4 attempts.', {
        reason: 'retry_deadline_exceeded',
      }),
    );
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    const input = ntfyPublishMessage.input.parse({ topic: 'alerts', message: 'x' });
    await expect(ntfyPublishMessage.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'upstream_unreachable' },
    });
  });

  /**
   * A `200` whose body is not ntfy's reply (#39). Only the network is stubbed, so
   * the service's reply parse and its retry boundary run; `NTFY_MAX_RETRIES` is
   * 3, and the request count is how many notifications went out.
   */
  describe('a 200 reply that is not an ntfy message (#39)', () => {
    function stubReply(text: string, contentType?: string) {
      initNtfyService({
        servers: [{ baseUrl: 'https://ntfy.test' }],
        requestTimeoutMs: 1000,
        maxRetries: 3,
      } as never);
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (new URL(url).hostname !== 'ntfy.test') throw new Error(`Unmocked fetch: ${url}`);
        return new Response(text, {
          status: 200,
          ...(contentType ? { headers: { 'content-type': contentType } } : {}),
        });
      });
    }

    const HINT = ntfyPublishMessage.errors?.find((e) => e.reason === 'upstream_malformed')
      ?.recovery as string;

    it.each([
      ['an empty body', '', undefined],
      ['an HTML page', '<!doctype html><html>Captive portal</html>', 'text/html'],
      ['JSON `null`', 'null', 'application/json'],
      ['JSON without the message fields', '{"ok":true}', 'application/json'],
    ])(
      'fails %s with `upstream_malformed` on both surfaces and publishes once',
      async (_label, text, contentType) => {
        const upstream = stubReply(text, contentType);
        const result = await runToolContract(ntfyPublishMessage, { topic: 'alerts', message: 'x' });
        expect(upstream).toHaveBeenCalledTimes(1);
        expect(result.isError).toBe(true);
        const { error } = result.structuredContent as {
          error: {
            code: number;
            message: string;
            data: { reason?: string; retryable?: boolean; recovery?: { hint: string } };
          };
        };
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.data.reason).toBe('upstream_malformed');
        expect(error.data.retryable).toBe(false);
        expect(error.data.recovery?.hint).toBe(HINT);
        expect(error.message).toContain('publish was answered with HTTP 200');
        const textOut = readCommonMark(
          result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
        );
        expect(textOut).toContain('publish was answered with HTTP 200');
        expect(textOut).toContain(`Recovery: ${HINT}`);
        expect(textOut).toContain('reason upstream_malformed');
        expect(textOut).toContain('not retryable');
      },
    );

    it('declares the reason as not retryable, pointing at `ntfy_fetch_messages` before a resend', () => {
      expect(
        ntfyPublishMessage.errors?.find((e) => e.reason === 'upstream_malformed'),
      ).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable, retryable: false });
      expect(HINT).toContain('`ntfy_fetch_messages`');
      expect(HINT).toContain('before resending');
    });

    it('names the fetch levers a delayed or `base_url` publish needs to be found', () => {
      // A delayed publish is invisible to a poll without `scheduled: true`, and
      // one sent through an override exists only on that server.
      expect(HINT).toContain('`scheduled: true`');
      expect(HINT).toContain('`delay`');
      expect(HINT).toContain('same `base_url`');
    });

    it('keeps `upstream_malformed` when the call deadline landed on the malformed reply', async () => {
      const svc = freshService();
      vi.spyOn(svc, 'publish').mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'The publish was answered with HTTP 200, but the reply is not an ntfy message: the body is empty. (failed after 1 attempt)',
          { reason: 'upstream_malformed', retryable: false, retryAttempts: 1, deadlineMs: 50_000 },
        ),
      );
      const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
      const input = ntfyPublishMessage.input.parse({ topic: 'alerts', message: 'x' });
      await expect(ntfyPublishMessage.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'upstream_malformed', retryable: false },
      });
    });

    /** `200` headers and the first bytes of the reply, then the body stream errors. */
    function stubCutOffReply(onRead?: () => void) {
      initNtfyService({
        servers: [{ baseUrl: 'https://ntfy.test' }],
        requestTimeoutMs: 1000,
        maxRetries: 3,
      } as never);
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (new URL(url).hostname !== 'ntfy.test') throw new Error(`Unmocked fetch: ${url}`);
        const signal = init?.signal as AbortSignal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"id":"m1","ti'));
            signal.addEventListener('abort', () => controller.error(signal.reason), {
              once: true,
            });
            if (onRead) onRead();
            else {
              queueMicrotask(() =>
                controller.error(
                  new TypeError('terminated', { cause: new Error('other side closed') }),
                ),
              );
            }
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
    }

    it('fails a reply reset mid-body with `upstream_malformed` on both surfaces and publishes once (#43)', async () => {
      const upstream = stubCutOffReply();
      const result = await runToolContract(ntfyPublishMessage, { topic: 'alerts', message: 'x' });
      expect(upstream).toHaveBeenCalledTimes(1);
      const { error } = result.structuredContent as {
        error: { code: number; message: string; data: Record<string, unknown> };
      };
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toBe(
        'The publish was answered with HTTP 200, but reading the reply failed: terminated (other side closed).',
      );
      expect(error.data).toMatchObject({
        reason: 'upstream_malformed',
        retryable: false,
        recovery: { hint: HINT },
      });
      const textOut = readCommonMark(
        result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
      );
      expect(textOut).toContain('but reading the reply failed: terminated (other side closed).');
      expect(textOut).toContain(`Recovery: ${HINT}`);
      expect(textOut).toContain('not retryable');
    });

    it('settles a caller cancel mid-reply as RequestCancelled, publishing once (#43)', async () => {
      const caller = new AbortController();
      const upstream = stubCutOffReply(() => queueMicrotask(() => caller.abort()));
      const result = await runToolContract(
        ntfyPublishMessage,
        { topic: 'alerts', message: 'x' },
        { context: { signal: caller.signal } },
      );
      expect(upstream).toHaveBeenCalledTimes(1);
      const { error } = result.structuredContent as {
        error: { code: number; message: string; data?: Record<string, unknown> };
      };
      expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(error.message).toBe('The ntfy request was cancelled by the caller.');
      expect(error.data?.reason).toBeUndefined();
      const textOut = readCommonMark(
        result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
      );
      expect(textOut).toContain('The ntfy request was cancelled by the caller.');
      expect(textOut).not.toContain('upstream_malformed');
    });
  });

  it('fails a 503 whose Retry-After outlasts the call as `upstream_unreachable`, sent once, naming the wait (#42)', async () => {
    initNtfyService({
      servers: [{ baseUrl: 'https://ntfy.test' }],
      requestTimeoutMs: 1000,
      maxRetries: 3,
    } as never);
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).hostname !== 'ntfy.test') throw new Error(`Unmocked fetch: ${url}`);
      return new Response('{"code":50301,"http":503,"error":"service unavailable"}', {
        status: 503,
        headers: { 'content-type': 'application/json', 'retry-after': '120' },
      });
    });
    const result = await runToolContract(ntfyPublishMessage, { topic: 'alerts', message: 'x' });
    expect(upstream).toHaveBeenCalledTimes(1);
    const { error } = result.structuredContent as {
      error: { code: number; message: string; data: Record<string, unknown> };
    };
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).not.toMatch(/failed after/);
    expect(error.data).toMatchObject({
      reason: 'upstream_unreachable',
      retryAfter: '120',
      recovery: {
        hint: 'The ntfy server answered but asked to wait (Retry-After: 120); resend the publish once that wait has passed.',
      },
    });
    expect(error.data).not.toHaveProperty('retryAttempts');
    const textOut = readCommonMark(
      result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
    );
    expect(textOut).toContain('Retry-After: 120); resend the publish once that wait has passed.');
    expect(textOut).toContain('reason upstream_unreachable');
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

  /**
   * The publish echo reaches `content[]` as code spans and fences, never as live
   * Markdown, while `structuredContent` keeps every value as ntfy echoed it (#28).
   * Only the network is stubbed, so the service's response parse runs.
   */
  describe('upstream text renders as literal Markdown (#28)', () => {
    /** Answers `ntfy.test` with `echo` as the publish response; any other host rejects. */
    function stubPublish(echo: Record<string, unknown>) {
      freshService();
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (new URL(url).hostname !== 'ntfy.test') throw new Error(`Unmocked fetch: ${url}`);
        return new Response(
          JSON.stringify({ id: 'mid_1', time: 1_700_000_000, event: 'message', ...echo }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      });
    }
    const domainText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      (result.content[0] as { text: string }).text;

    const PLAIN = {
      title: 'Review <title> *literal*',
      message: '*literal* <admin@example.com> [text](https://example.invalid) `code`',
      click: 'https://example.invalid/a)b',
    };
    const ATTACHMENT = { name: 'report](x) (draft).txt', url: 'https://example.invalid/file.txt' };

    it('renders every value of a plain publish as a code span or a `text` fence, exact lines', async () => {
      stubPublish({ topic: 'alerts', ...PLAIN, attachment: ATTACHMENT });
      const result = await runToolContract(ntfyPublishMessage, {
        topic: 'alerts',
        ...PLAIN,
        attach: ATTACHMENT.url,
        filename: ATTACHMENT.name,
      });
      expect(domainText(result)).toBe(
        [
          '**Sent** — ntfy accepted message `mid_1` on `alerts`',
          'URL: `https://ntfy.test/alerts`',
          'Time: 2023-11-14T22:13:20.000Z',
          'Title: `Review <title> *literal*`',
          '',
          '```text',
          '*literal* <admin@example.com> [text](https://example.invalid) `code`',
          '```',
          '',
          'Click action: `https://example.invalid/a)b`',
          '',
          'Attachment: `report](x) (draft).txt` — `https://example.invalid/file.txt`',
        ].join('\n'),
      );
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ ...PLAIN, attachment: ATTACHMENT });
      expect(structured.markdown).toBeUndefined();
      expect(JSON.parse(JSON.stringify(structured))).not.toHaveProperty('markdown');
    });

    it('renders each action button as its own JSON code span and tags as sized spans', async () => {
      const actions = [
        { action: 'view' as const, label: 'Open `now`', url: 'https://example.com' },
        { action: 'copy' as const, label: 'Copy', value: 'x' },
      ];
      stubPublish({
        topic: 'alerts',
        message: 'body',
        sequence_id: 'seq`1',
        tags: ['warning', 'a`b'],
        actions,
      });
      const result = await runToolContract(ntfyPublishMessage, {
        topic: 'alerts',
        message: 'body',
        tags: ['warning', 'a`b'],
        actions,
      });
      expect(domainText(result)).toBe(
        [
          '**Sent** — ntfy accepted message `mid_1` on `alerts`',
          'URL: `https://ntfy.test/alerts`',
          'Time: 2023-11-14T22:13:20.000Z',
          'Sequence ID: ``seq`1``',
          'Tags: `warning` · ``a`b``',
          '',
          '```text',
          'body',
          '```',
          '',
          'Actions:',
          '- ``{"action":"view","label":"Open `now`","url":"https://example.com"}``',
          '- `{"action":"copy","label":"Copy","value":"x"}`',
        ].join('\n'),
      );
      expect((result.structuredContent as { actions?: unknown }).actions).toEqual(actions);
    });

    it('marks a `text/markdown` echo on both surfaces and fences its source unescaped', async () => {
      stubPublish({
        topic: 'alerts',
        message: '**bold** md',
        content_type: 'text/markdown',
      });
      const result = await runToolContract(ntfyPublishMessage, {
        topic: 'alerts',
        message: '**bold** md',
        markdown: true,
      });
      expect(result.structuredContent).toMatchObject({ message: '**bold** md', markdown: true });
      expect(domainText(result)).toContain('\n```markdown\n**bold** md\n```');
    });

    it('moves a title or tag with a line break into its own `text` fence', async () => {
      stubPublish({
        topic: 'alerts',
        title: 'a\r\n# Forged heading',
        tags: ['ok', 'two\nlines'],
        message: 'body',
      });
      const result = await runToolContract(ntfyPublishMessage, {
        topic: 'alerts',
        title: 'a\r\n# Forged heading',
        tags: ['ok', 'two\nlines'],
        message: 'body',
      });
      const text = domainText(result);
      expect(text).toContain('Title: \n```text\na\r\n# Forged heading\n```\n');
      expect(text).toContain('Tags: `ok` · \n```text\ntwo\nlines\n```\n');
    });
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
        Response.json({ id: 'mid_1', time: 1700000000, event: 'message', topic: 'alerts' }),
      );
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
    expect(message).toContain('HTTP `DELETE`');
  });

  it('renders every caller-supplied target in the prompt as a code span, never as Markdown', async () => {
    fakeUpstream();
    const { message } = confirmRequest(
      await firstRound({
        email: '[safe](https://evil)',
        call: '*+1555*',
        actions: [
          { action: 'http', label: 'Go', url: 'https://e.x/`a`', method: '<b>PATCH</b>' },
          { action: 'broadcast', label: 'Run', intent: '_io.custom_' },
          { action: 'broadcast', label: 'Default' },
        ],
      }),
    );

    expect(message).toBe(
      'Publish to ntfy topic `alerts` with an email forward to `[safe](https://evil)` and a voice call to `*+1555*` and an HTTP `<b>PATCH</b>` button targeting `` https://e.x/`a` `` and an Android broadcast intent (`_io.custom_`) and an Android broadcast intent (default intent)?',
    );
  });

  it('moves a target with a line break into its own `text` fence in the prompt', async () => {
    fakeUpstream();
    const { message } = confirmRequest(await firstRound({ email: 'ops@example.com\n# forged' }));
    expect(message).toContain('an email forward to \n```text\nops@example.com\n# forged\n```\n?');
  });

  it('leaves the topic out of the message when the user declines', async () => {
    fakeUpstream();
    const err = (await Promise.resolve(
      ntfyPublishMessage.handler(
        inputWith(EMAIL),
        await approvedCtx(inputWith(EMAIL), { action: 'decline' }),
      ),
    ).catch((e: unknown) => e)) as McpError;
    expect(err).toMatchObject({
      message: 'The publish was not confirmed, so nothing was sent to ntfy.',
      data: { reason: 'consent_declined' },
    });
    // `content[]` is the message as the framework escapes it; a parse reads it back exactly.
    expect(readCommonMark(`Error: ${escapeMarkdownInline(err.message)}`)).toBe(
      'Error: The publish was not confirmed, so nothing was sent to ntfy.',
    );
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

  describe('a scheduled gated publish and its `timezone` (#50)', () => {
    const scheduled = (timezone: string) =>
      inputWith({ actions: [HTTP_ACTION], delay: 'tomorrow, 10am', timezone });

    it('publishes with the `timezone` its record was approved for', async () => {
      const upstream = fakeUpstream();

      await ntfyPublishMessage.handler(
        scheduled('Asia/Tokyo'),
        await approvedCtx(scheduled('Asia/Tokyo')),
      );

      expect(upstream).toHaveBeenCalledOnce();
      expect(sentBody(upstream)).toMatchObject({
        delay: 'tomorrow, 10am',
        timezone: 'Asia/Tokyo',
      });
    });

    it('asks again when a record approved for one `timezone` is redeemed with another', async () => {
      const upstream = fakeUpstream();
      const { asked, record } = await askFirst(scheduled('Asia/Tokyo'));
      const ctx = await roundTwoCtx(asked.requestState, record);

      await expectInputRequired(() =>
        ntfyPublishMessage.handler(scheduled('America/Los_Angeles'), ctx),
      );

      expect(upstream).not.toHaveBeenCalled();
    });
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

describe('ntfyPublishMessage pointers at ntfy_search_emoji_tags', () => {
  /** Both strings as shipped before NTFY_ENABLE_EMOJI_TAGS existed. */
  const DESCRIPTION =
    'Send or update a push notification on an ntfy topic. Topics are created on first publish — treat the topic name as a secret because anyone who knows it can publish or subscribe. Set `sequence_id` to update a previously-published message; otherwise the call creates a new one. Use `ntfy_search_emoji_tags` to look up emoji short codes for `tags`. A publish carrying `email`, `call`, or a `broadcast`/`http` action button reaches beyond the notification drawer, so that call always asks the user to confirm the specific target first and comes back requesting that input rather than a result; reissue the same call with the answer attached to send it. Declining fails the call with `consent_declined`. A plain notification publishes on the first call.';
  const TAGS =
    'Up to 10 tags. Strings matching ntfy emoji short codes render as emojis prepended to the title; others render as a tag list. Use `ntfy_search_emoji_tags` to discover short codes.';

  /** Re-evaluate the definition module, since the flag is read when it loads. */
  async function loadWith(value: string | undefined) {
    if (value !== undefined) vi.stubEnv('NTFY_ENABLE_EMOJI_TAGS', value);
    vi.resetModules();
    const mod = await import('@/mcp-server/tools/definitions/ntfy-publish-message.tool.js');
    return mod.ntfyPublishMessage;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([undefined, '', 'true'])(
    'keeps the description and `tags` text unchanged when the flag is %j',
    async (value) => {
      const def = await loadWith(value);
      expect(def.description).toBe(DESCRIPTION);
      expect(def.input.shape.tags.description).toBe(TAGS);
    },
  );

  it('drops both pointer sentences, and nothing else, when the flag is false', async () => {
    const def = await loadWith('false');
    expect(def.description).toBe(
      DESCRIPTION.replace(
        ' Use `ntfy_search_emoji_tags` to look up emoji short codes for `tags`.',
        '',
      ),
    );
    expect(def.input.shape.tags.description).toBe(
      TAGS.replace(' Use `ntfy_search_emoji_tags` to discover short codes.', ''),
    );
    expect(JSON.stringify(z.toJSONSchema(def.input))).not.toContain('ntfy_search_emoji_tags');
    expect(JSON.stringify(z.toJSONSchema(def.output))).not.toContain('ntfy_search_emoji_tags');
  });
});
