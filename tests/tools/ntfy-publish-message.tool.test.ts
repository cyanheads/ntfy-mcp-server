/**
 * @fileoverview Tests for `ntfy_publish_message` — happy path with mocked
 * upstream, default-topic resolution, the priority schema's single-node
 * validation and advertised shape, byte-length message validation,
 * format-rendering (including the scheduled delivery-time label), scheduled-flag
 * synthesis, base_url override and its scheme validation, the consent gate
 * (which inputs prompt, which do not, every declining reply, and the
 * proceed-anyway path on clients without elicitation), and the full contract
 * error mapping
 * (forbidden / rate-limit / payload-too-large from a 413 / invalid-attachment /
 * unverified-contact / upstream-unreachable / generic rethrow) with the upstream
 * explanation preserved on the error message.
 * @module tests/tools/ntfy-publish-message.tool
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  forbidden,
  invalidParams,
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetServerConfig } from '@/config/server-config.js';
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
    const input = z.toJSONSchema(ntfyPublishMessage.input, { io: 'input' }) as {
      properties: { priority: Record<string, unknown> };
    };
    const output = z.toJSONSchema(ntfyPublishMessage.output, { io: 'output' }) as {
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
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    const input = ntfyPublishMessage.input.parse({ topic: 'alerts', message: 'x'.repeat(100) });
    await expect(ntfyPublishMessage.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('JSON body too large'),
      data: {
        reason: 'payload_too_large',
        recovery: { hint: expect.stringContaining('Shorten the message') },
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
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    const input = ntfyPublishMessage.input.parse({
      topic: 'alerts',
      message: 'x',
      attach: 'not-a-url',
    });
    const err = (await ntfyPublishMessage.handler(input, ctx).catch((e: unknown) => e)) as McpError;
    expect(err.data).toMatchObject({ reason: 'invalid_attachment' });
    expect(err.message).toContain('attachment URL is invalid');
    const hint = String((err.data as { recovery: { hint: string } }).recovery.hint);
    expect(hint).toContain('absolute URL');
    expect(hint).not.toContain('Shorten the message');
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
    const err = (await ntfyPublishMessage.handler(input, ctx).catch((e: unknown) => e)) as McpError;
    expect(err.message).toContain('invalid delay parameter: unable to parse delay');
    expect(err.data?.reason).toBeUndefined();
  });

  it('maps a 4xx with email/phone-verification hint to `unverified_contact`', async () => {
    const svc = freshService();
    vi.spyOn(svc, 'publish').mockRejectedValue(invalidParams('Phone number is not verified'));
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    const input = ntfyPublishMessage.input.parse({
      topic: 'alerts',
      message: 'x',
      call: '+15555550100',
    });
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
    const err = await ntfyPublishMessage.handler(input, ctx).catch((e: unknown) => e);
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

  function stubbedPublish() {
    return vi.spyOn(freshService(), 'publish').mockResolvedValue({
      id: 'mid_1',
      time: 1700000000,
      topic: 'alerts',
    });
  }

  const HTTP_ACTION = {
    action: 'http',
    label: 'Acknowledge',
    url: 'https://example.com/ack',
    method: 'DELETE',
  } as const;
  const BROADCAST_ACTION = { action: 'broadcast', label: 'Run macro' } as const;

  it.each([
    ['email forwarding', { email: 'ops@example.com' }, 'ops@example.com'],
    ['a voice call', { call: '+15551234567' }, '+15551234567'],
    ['a broadcast action', { actions: [BROADCAST_ACTION] }, 'broadcast intent'],
    ['an http action', { actions: [HTTP_ACTION] }, 'https://example.com/ack'],
  ])('prompts for %s and names the target', async (_label, extra, expected) => {
    const publish = stubbedPublish();
    const elicit = vi.fn().mockResolvedValue({ action: 'accept', content: { confirm: true } });
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors, elicit });

    const input = ntfyPublishMessage.input.parse({ topic: 'alerts', message: 'hi', ...extra });
    await ntfyPublishMessage.handler(input, ctx);

    expect(elicit).toHaveBeenCalledOnce();
    const prompt = elicit.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('alerts');
    expect(prompt).toContain(expected);
    expect(publish).toHaveBeenCalledOnce();
  });

  it('names the method of an http action button', async () => {
    stubbedPublish();
    const elicit = vi.fn().mockResolvedValue({ action: 'accept', content: { confirm: true } });
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors, elicit });
    const input = ntfyPublishMessage.input.parse({
      topic: 'alerts',
      message: 'hi',
      actions: [HTTP_ACTION],
    });
    await ntfyPublishMessage.handler(input, ctx);
    expect(elicit.mock.calls[0]?.[0]).toContain('HTTP DELETE');
  });

  it('lists every side effect when a publish carries more than one', async () => {
    stubbedPublish();
    const elicit = vi.fn().mockResolvedValue({ action: 'accept', content: { confirm: true } });
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors, elicit });
    const input = ntfyPublishMessage.input.parse({
      topic: 'alerts',
      message: 'hi',
      email: 'ops@example.com',
      call: '+15551234567',
      actions: [HTTP_ACTION],
    });
    await ntfyPublishMessage.handler(input, ctx);
    const prompt = elicit.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('ops@example.com');
    expect(prompt).toContain('+15551234567');
    expect(prompt).toContain('https://example.com/ack');
  });

  it.each([
    ['a plain notification', {}],
    ['a title, tags, and a priority', { title: 'Heads up', tags: ['warning'], priority: 5 }],
    ['a click URL', { click: 'https://example.com/dashboard' }],
    ['a view action', { actions: [{ action: 'view', label: 'Open', url: 'https://example.com' }] }],
    ['a copy action', { actions: [{ action: 'copy', label: 'Copy', value: 'token' }] }],
  ])('does not prompt for %s', async (_label, extra) => {
    const publish = stubbedPublish();
    const elicit = vi.fn();
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors, elicit });

    const input = ntfyPublishMessage.input.parse({ topic: 'alerts', message: 'hi', ...extra });
    await ntfyPublishMessage.handler(input, ctx);

    expect(elicit).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
  });

  it.each([
    ['decline', { action: 'decline' }],
    ['cancel', { action: 'cancel' }],
    ['accept with confirm=false', { action: 'accept', content: { confirm: false } }],
    ['accept with an unparseable payload', { action: 'accept', content: { confirm: 'yes' } }],
  ])('fails with `consent_declined` on %s, without publishing', async (_label, reply) => {
    const publish = stubbedPublish();
    const ctx = createMockContext({
      errors: ntfyPublishMessage.errors,
      elicit: vi.fn().mockResolvedValue(reply),
    });

    const input = ntfyPublishMessage.input.parse({
      topic: 'alerts',
      message: 'hi',
      email: 'ops@example.com',
    });
    await expect(ntfyPublishMessage.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'consent_declined' },
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('proceeds when the client does not support elicitation', async () => {
    const publish = stubbedPublish();
    const ctx = createMockContext({ errors: ntfyPublishMessage.errors });
    expect(ctx.elicit).toBeUndefined();

    const input = ntfyPublishMessage.input.parse({
      topic: 'alerts',
      message: 'hi',
      call: '+15551234567',
    });
    await ntfyPublishMessage.handler(input, ctx);
    expect(publish).toHaveBeenCalledOnce();
  });
});
