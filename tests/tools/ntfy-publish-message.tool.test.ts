/**
 * @fileoverview Tests for `ntfy_publish_message` — happy path with mocked
 * upstream, default-topic resolution, byte-length message validation,
 * format-rendering (including the scheduled delivery-time label), scheduled-flag
 * synthesis, base_url override, and the full contract error mapping
 * (forbidden / rate-limit / payload-too-large from a 413 / invalid-attachment /
 * unverified-contact / upstream-unreachable / generic rethrow) with the upstream
 * explanation preserved on the error message.
 * @module tests/tools/ntfy-publish-message.tool
 */

import {
  forbidden,
  invalidParams,
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
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
