/**
 * @fileoverview Tests for `NtfyService` — multi-server auth resolution, the
 * request-shape contract for publish/manage/fetch (URL, method, headers,
 * body), NDJSON parsing edge cases and the poll-body validation that fails a
 * damaged body as `upstream_malformed` (or surfaces a mid-stream ntfy error
 * line), the publish and clear/delete reply validation that fails a `200` that
 * is not an ntfy message as `upstream_malformed` without resending it, the
 * `X-Messages-Truncated` replay-cap flag, upstream error propagation including the
 * JSON error body folded into the message and the request URL kept off
 * `error.data`, the module-level init/get/reset
 * accessors, and `base_url` override validation — the always-on absolute
 * http(s) check plus the opt-in private-host guard, its registered-base bypass,
 * and its redirect refusal.
 * @module tests/services/ntfy/ntfy-service
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerConfig } from '@/config/server-config.js';
import {
  getCode as getErrorCode,
  isUpstreamUnreachable,
} from '@/services/ntfy/error-classifier.js';
import {
  CALL_DEADLINE_MS,
  getNtfyService,
  initNtfyService,
  NtfyService,
  resetNtfyService,
} from '@/services/ntfy/ntfy-service.js';

// Passthrough, so a test can hold one `base_url` lookup open.
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});
const { lookup } = await import('node:dns/promises');

const PUBLISH_BODY = { topic: 'alerts', message: 'hi' } as const;

function makeConfig(servers: ServerConfig['servers'], blockPrivateHosts = false): ServerConfig {
  return {
    servers,
    requestTimeoutMs: 1000,
    maxRetries: 0,
    blockPrivateHosts,
  };
}

interface CapturedCall {
  auth: string | undefined;
  body: string | undefined;
  headers: Record<string, string>;
  method: string | undefined;
  redirect: string | undefined;
  /** The composed signal `timedFetch` hands to `fetch` — abort-path tests wait on it. */
  signal: AbortSignal | undefined;
  url: string;
}

function captureFetch(
  responder: (call: CapturedCall) => Response | Promise<Response> = () =>
    new Response(JSON.stringify({ id: 'm1', time: 1, event: 'message', topic: 'alerts' }), {
      status: 200,
    }),
) {
  const calls: CapturedCall[] = [];
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args: unknown[]) => {
    const url = args[0] as string;
    const init = args[1] as RequestInit | undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: CapturedCall = {
      url,
      method: init?.method,
      headers,
      auth: headers.Authorization,
      body: typeof init?.body === 'string' ? init.body : undefined,
      redirect: init?.redirect,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return (await responder(call)) as unknown as Response;
  });
  return { calls, mock };
}

/**
 * A responder that models a real `fetch`: it never settles on its own, and
 * rejects with the composed signal's abort reason once `timedFetch` aborts —
 * whether the timeout timer or the caller's signal fired. Verified against
 * Bun's own `fetch`, which rejects with the reason object it was aborted with
 * (and a generic `AbortError` DOMException when the reason is `undefined`).
 */
function abortAwareResponder(call: CapturedCall): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = call.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

describe('NtfyService multi-server', () => {
  beforeEach(() => {
    // no-op
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the first registered server as the default base', () => {
    const svc = new NtfyService(
      makeConfig([
        { baseUrl: 'https://primary.example.com' },
        { baseUrl: 'https://secondary.example.com', authToken: 'tk_x' },
      ]),
    );
    expect(svc.baseUrl).toBe('https://primary.example.com');
  });

  it('forwards bearer auth when the override matches a registered base', async () => {
    const svc = new NtfyService(
      makeConfig([
        { baseUrl: 'https://primary.example.com' },
        { baseUrl: 'https://secondary.example.com', authToken: 'tk_xyz' },
      ]),
    );
    const { calls } = captureFetch();
    await svc.publish(PUBLISH_BODY, { baseUrl: 'https://secondary.example.com' });
    expect(calls[0]?.auth).toBe('Bearer tk_xyz');
  });

  it('forwards basic auth when the override matches a basic-auth registered base', async () => {
    const svc = new NtfyService(
      makeConfig([
        { baseUrl: 'https://primary.example.com' },
        {
          baseUrl: 'https://corp.example.com',
          authUsername: 'user',
          authPassword: 'pass',
        },
      ]),
    );
    const { calls } = captureFetch();
    await svc.publish(PUBLISH_BODY, { baseUrl: 'https://corp.example.com' });
    const expected = `Basic ${Buffer.from('user:pass', 'utf-8').toString('base64')}`;
    expect(calls[0]?.auth).toBe(expected);
  });

  it('drops auth when the override does not match any registered base', async () => {
    const svc = new NtfyService(
      makeConfig([
        { baseUrl: 'https://primary.example.com', authToken: 'tk_primary' },
        { baseUrl: 'https://secondary.example.com', authToken: 'tk_secondary' },
      ]),
    );
    const { calls } = captureFetch();
    await svc.publish(PUBLISH_BODY, { baseUrl: 'https://stranger.example.com' });
    expect(calls[0]?.url.startsWith('https://stranger.example.com/')).toBe(true);
    expect(calls[0]?.auth).toBeUndefined();
  });

  it('forwards default-server auth when no override is supplied', async () => {
    const svc = new NtfyService(
      makeConfig([{ baseUrl: 'https://primary.example.com', authToken: 'tk_primary' }]),
    );
    const { calls } = captureFetch();
    await svc.publish(PUBLISH_BODY);
    expect(calls[0]?.url.startsWith('https://primary.example.com/')).toBe(true);
    expect(calls[0]?.auth).toBe('Bearer tk_primary');
  });

  it('treats trailing-slashed overrides as equal to a registered base', async () => {
    const svc = new NtfyService(
      makeConfig([
        { baseUrl: 'https://primary.example.com' },
        { baseUrl: 'https://secondary.example.com', authToken: 'tk_xyz' },
      ]),
    );
    const { calls } = captureFetch();
    await svc.publish(PUBLISH_BODY, { baseUrl: 'https://secondary.example.com/' });
    expect(calls[0]?.auth).toBe('Bearer tk_xyz');
  });

  it('throws when the config has no servers', () => {
    expect(
      () => new NtfyService({ servers: [], requestTimeoutMs: 1000, maxRetries: 0 } as never),
    ).toThrow(/at least one entry/i);
  });
});

describe('NtfyService base_url validation (always on)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['ftp://ntfy.example.com', 'file:///etc/passwd', 'ntfy.example.com', '/alerts'])(
    'rejects the %j override before any request goes out, with the guard off',
    async (baseUrl) => {
      const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
      const { calls } = captureFetch();
      await expect(svc.publish(PUBLISH_BODY, { baseUrl })).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
      });
      expect(calls).toHaveLength(0);
    },
  );

  it('applies the same check on the manage and fetch paths', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    const { calls } = captureFetch();
    await expect(
      svc.manage('alerts', 'seq_1', 'clear', { baseUrl: 'ftp://ntfy.example.com' }),
    ).rejects.toThrow(/unsupported scheme/i);
    await expect(svc.fetch({ topic: 'alerts' }, { baseUrl: 'not-a-url' })).rejects.toThrow(
      /not an absolute URL/i,
    );
    expect(calls).toHaveLength(0);
  });

  it('leaves the configured base untouched when no override is passed', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    const { calls } = captureFetch();
    await svc.publish(PUBLISH_BODY);
    expect(calls[0]?.url).toBe('https://ntfy.test/');
    expect(calls[0]?.redirect).toBeUndefined();
  });
});

describe('NtfyService private-host guard (NTFY_BLOCK_PRIVATE_HOSTS)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a loopback override unchanged while the flag is off', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    const { calls } = captureFetch();
    await svc.publish(PUBLISH_BODY, { baseUrl: 'http://127.0.0.1:8080' });
    expect(calls[0]?.url).toBe('http://127.0.0.1:8080/');
    expect(calls[0]?.redirect).toBeUndefined();
  });

  it.each([
    'http://127.0.0.1:8080',
    'http://169.254.169.254',
    'http://[::1]:8080',
    'http://100.68.34.90:8080',
    'http://2130706433:8080',
  ])('blocks the unregistered %j override while the flag is on', async (baseUrl) => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }], true));
    const { calls } = captureFetch();
    await expect(svc.publish(PUBLISH_BODY, { baseUrl })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('non-public'),
    });
    expect(calls).toHaveLength(0);
  });

  it('allows a private base that the operator registered', async () => {
    const svc = new NtfyService(
      makeConfig([{ baseUrl: 'https://ntfy.test' }, { baseUrl: 'http://192.168.1.10:8080' }], true),
    );
    const { calls } = captureFetch();
    await svc.publish(PUBLISH_BODY, { baseUrl: 'http://192.168.1.10:8080' });
    expect(calls[0]?.url).toBe('http://192.168.1.10:8080/');
  });

  it('covers a registered private base with no credentials of its own', async () => {
    // `authByBase` holds only credentialed entries — the bypass set must not be
    // sourced from it, or a no-auth LAN server would fail its own guard.
    const svc = new NtfyService(
      makeConfig(
        [{ baseUrl: 'https://ntfy.test', authToken: 'tk_primary' }, { baseUrl: 'http://10.0.0.5' }],
        true,
      ),
    );
    const { calls } = captureFetch();
    await svc.publish(PUBLISH_BODY, { baseUrl: 'http://10.0.0.5' });
    expect(calls[0]?.url).toBe('http://10.0.0.5/');
    expect(calls[0]?.auth).toBeUndefined();
  });

  it('allows a private configured default with no override', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'http://192.168.1.10:8080' }], true));
    const { calls } = captureFetch(() => new Response('', { status: 200 }));
    await svc.fetch({ topic: 'alerts' });
    expect(calls[0]?.url.startsWith('http://192.168.1.10:8080/alerts/json')).toBe(true);
    expect(calls[0]?.redirect).toBeUndefined();
  });

  it('refuses redirects on a guarded public override', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }], true));
    const { calls } = captureFetch();
    await svc.publish(PUBLISH_BODY, { baseUrl: 'https://1.1.1.1' });
    expect(calls[0]?.redirect).toBe('error');
  });

  it('names the refused redirect instead of reporting a network fault', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }], true));
    captureFetch(() => {
      // The shape both runtimes produce for `redirect: 'error'`: Node nests
      // "unexpected redirect" under `cause`, Bun words it at the top level.
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    });
    await expect(svc.publish(PUBLISH_BODY, { baseUrl: 'https://1.1.1.1' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('redirects are not followed'),
    });
  });

  it('leaves a genuine transport failure on the guarded path alone', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }], true));
    captureFetch(() => {
      throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
    });
    await expect(svc.publish(PUBLISH_BODY, { baseUrl: 'https://1.1.1.1' })).rejects.toThrow(
      /fetch failed/,
    );
  });

  /**
   * Only `fetch`'s own rejection can be a refused redirect. Once ntfy has
   * answered, its error text is ntfy's to word — "redirect" in it names no hop
   * this server refused.
   */
  describe("leaves ntfy's own answers on the guarded path classified as ntfy said", () => {
    const ntfyError = (status: number, error: string) => () =>
      new Response(JSON.stringify({ code: status * 100 + 1, http: status, error }), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    it('retries a 503 whose body mentions a redirect, ending ServiceUnavailable', async () => {
      const svc = new NtfyService({
        ...makeConfig([{ baseUrl: 'https://ntfy.test' }], true),
        maxRetries: 1,
      });
      const { calls } = captureFetch(ntfyError(503, 'upstream redirect loop, try again later'));
      const err = (await svc
        .publish(PUBLISH_BODY, { baseUrl: 'https://1.1.1.1' })
        .catch((e: unknown) => e)) as Error & { data?: Record<string, unknown> };
      expect(calls).toHaveLength(2);
      expect(calls[0]?.redirect).toBe('error');
      expect(getErrorCode(err)).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data?.status).toBe(503);
      expect(err.message).toContain('upstream redirect loop');
      expect(err.message).toMatch(/\(failed after 2 attempts\)/);
      expect(err.message).not.toContain('redirects are not followed');
      expect(isUpstreamUnreachable(err)).toBe(true);
    });

    it.each([
      ['publish', (svc: NtfyService) => svc.publish(PUBLISH_BODY, { baseUrl: 'https://1.1.1.1' })],
      [
        'manage',
        (svc: NtfyService) =>
          svc.manage('alerts', 'seq_1', 'clear', { baseUrl: 'https://1.1.1.1' }),
      ],
      [
        'fetch',
        (svc: NtfyService) => svc.fetch({ topic: 'alerts' }, { baseUrl: 'https://1.1.1.1' }),
      ],
    ] as const)(
      'surfaces a %s 400 whose ntfy error says "redirect" with its own status and text',
      async (_label, call) => {
        const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }], true));
        const { calls } = captureFetch(
          ntfyError(400, 'invalid request: click URL must not redirect'),
        );
        const err = (await call(svc).catch((e: unknown) => e)) as Error & {
          data?: Record<string, unknown>;
        };
        expect(calls).toHaveLength(1);
        expect(err.data?.status).toBe(400);
        expect(err.message).toContain('ntfy returned HTTP 400');
        expect(err.message).toContain('click URL must not redirect');
        expect(err.message).not.toContain('redirects are not followed');
      },
    );

    it('keeps a malformed 200 reply as `upstream_malformed`', async () => {
      const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }], true));
      captureFetch(() => new Response('<html>Captive portal</html>', { status: 200 }));
      await expect(svc.publish(PUBLISH_BODY, { baseUrl: 'https://1.1.1.1' })).rejects.toMatchObject(
        {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'upstream_malformed', retryable: false },
        },
      );
    });

    it('keeps a per-attempt timeout a transient timeout, retried', async () => {
      const svc = new NtfyService({
        ...makeConfig([{ baseUrl: 'https://ntfy.test' }], true),
        requestTimeoutMs: 20,
        maxRetries: 1,
      });
      const { calls } = captureFetch(abortAwareResponder);
      const err = (await svc
        .fetch({ topic: 'alerts' }, { baseUrl: 'https://1.1.1.1' })
        .catch((e: unknown) => e)) as Error;
      expect(calls).toHaveLength(2);
      expect(err.message).toMatch(/Timeout/);
      expect(getErrorCode(err)).not.toBe(JsonRpcErrorCode.ValidationError);
      expect(isUpstreamUnreachable(err)).toBe(true);
    });
  });
});

describe('NtfyService.publish request shape', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs JSON to the topic root and round-trips body fields', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    const { calls } = captureFetch();
    await svc.publish({
      topic: 'alerts',
      message: 'hi',
      title: 'Heads up',
      priority: 4,
      tags: ['warning'],
    });
    expect(calls[0]?.url).toBe('https://ntfy.test/');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(calls[0]?.body ?? '{}');
    expect(body).toEqual({
      topic: 'alerts',
      message: 'hi',
      title: 'Heads up',
      priority: 4,
      tags: ['warning'],
    });
  });

  it('promotes `cache: false` to the X-Cache header (not a body field)', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    const { calls } = captureFetch();
    await svc.publish({ topic: 'alerts', message: 'hi', cache: false });
    expect(calls[0]?.headers['X-Cache']).toBe('no');
    const body = JSON.parse(calls[0]?.body ?? '{}');
    expect(body.cache).toBeUndefined();
  });

  it('promotes `firebase: false` to the X-Firebase header (not a body field)', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    const { calls } = captureFetch();
    await svc.publish({ topic: 'alerts', message: 'hi', firebase: false });
    expect(calls[0]?.headers['X-Firebase']).toBe('no');
    const body = JSON.parse(calls[0]?.body ?? '{}');
    expect(body.firebase).toBeUndefined();
  });

  it('omits X-Cache / X-Firebase headers when the flags are true or unset', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    const { calls } = captureFetch();
    await svc.publish({ topic: 'alerts', message: 'hi', cache: true, firebase: true });
    expect(calls[0]?.headers['X-Cache']).toBeUndefined();
    expect(calls[0]?.headers['X-Firebase']).toBeUndefined();
  });

  it('throws an McpError carrying the upstream status when the response is not ok', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    captureFetch(
      () =>
        new Response('forbidden topic', {
          status: 403,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    await expect(svc.publish(PUBLISH_BODY)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
    });
  });
});

describe('NtfyService upstream error messages', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function jsonError(status: number, body: Record<string, unknown>): () => Response {
    return () =>
      new Response(JSON.stringify(body), {
        status,
        statusText: status === 400 ? 'Bad Request' : 'Request Entity Too Large',
        headers: { 'content-type': 'application/json' },
      });
  }

  it("folds ntfy's error string and docs link into the publish error message", async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    captureFetch(
      jsonError(400, {
        code: 40004,
        http: 400,
        error: 'invalid delay parameter: unable to parse delay',
        link: 'https://ntfy.sh/docs/publish/#scheduled-delivery',
      }),
    );
    const err = await svc
      .publish({ topic: 'alerts', message: 'x', delay: '9 fortnights' })
      .catch((e: unknown) => e as Error);
    expect(err.message).toContain('invalid delay parameter: unable to parse delay');
    expect(err.message).toContain('https://ntfy.sh/docs/publish/#scheduled-delivery');
  });

  it('keeps the canonical status on data while enriching the message', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    captureFetch(
      jsonError(413, {
        code: 41303,
        http: 413,
        error: 'JSON body too large; increase your limits with a paid plan',
      }),
    );
    await expect(svc.publish(PUBLISH_BODY)).rejects.toMatchObject({
      message: expect.stringContaining('JSON body too large'),
      data: { status: 413 },
    });
  });

  it('enriches fetch errors from the same choke point', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    captureFetch(
      jsonError(400, { code: 40008, http: 400, error: 'invalid since parameter: bad duration' }),
    );
    await expect(svc.fetch({ topic: 'alerts', since: 'tomorrow_maybe' })).rejects.toMatchObject({
      message: expect.stringContaining('invalid since parameter: bad duration'),
    });
  });

  it('enriches manage errors from the same choke point', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    captureFetch(
      jsonError(400, { code: 40015, http: 400, error: 'invalid message id: not a sequence' }),
    );
    await expect(svc.manage('alerts', 'seq_bogus', 'clear')).rejects.toMatchObject({
      message: expect.stringContaining('invalid message id: not a sequence'),
    });
  });

  it('leaves the status-line message untouched for a non-JSON body', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    captureFetch(
      () =>
        new Response('forbidden topic', {
          status: 403,
          statusText: 'Forbidden',
          headers: { 'content-type': 'text/plain' },
        }),
    );
    const err = await svc.publish(PUBLISH_BODY).catch((e: unknown) => e as Error);
    expect(err.message).toBe('ntfy returned HTTP 403 Forbidden.');
  });

  it('keeps the upstream request URL off the client-facing error data', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    captureFetch(({ url }) => {
      const response = new Response('forbidden topic', { status: 403, statusText: 'Forbidden' });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    });
    const rejection = svc.fetch({ topic: 'alerts', since: '1h' });
    await expect(rejection).rejects.toMatchObject({ data: { status: 403 } });
    await expect(rejection).rejects.not.toHaveProperty('data.url');
  });
});

describe('NtfyService.manage request shape', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('PUTs to /<topic>/<id>/clear when operation is `clear`', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    const { calls } = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            id: 'evt',
            time: 1,
            event: 'message_clear',
            topic: 'alerts',
            sequence_id: 'seq_1',
          }),
          { status: 200 },
        ),
    );
    await svc.manage('alerts', 'seq_1', 'clear');
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toBe('https://ntfy.test/alerts/seq_1/clear');
  });

  it('DELETEs /<topic>/<id> when operation is `delete`', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    const { calls } = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            id: 'evt',
            time: 1,
            event: 'message_delete',
            topic: 'alerts',
            sequence_id: 'seq_1',
          }),
          { status: 200 },
        ),
    );
    await svc.manage('alerts', 'seq_1', 'delete');
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe('https://ntfy.test/alerts/seq_1');
  });

  it('URL-encodes topic and sequence_id segments', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    const { calls } = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            id: 'evt',
            time: 1,
            event: 'message_delete',
            topic: 'odd topic',
            sequence_id: 'a b',
          }),
          { status: 200 },
        ),
    );
    // Note: `ntfy_manage_message` validates names before reaching here, but the
    // service must still encode safely if a caller ever bypasses that.
    await svc.manage('odd topic', 'a b', 'delete');
    expect(calls[0]?.url).toBe('https://ntfy.test/odd%20topic/a%20b');
  });

  it('throws on a non-OK upstream', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    captureFetch(
      () =>
        new Response('not found', {
          status: 404,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    await expect(svc.manage('alerts', 'seq_missing', 'delete')).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });
});

describe('NtfyService.fetch request shape', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function ndjsonResponder(text: string): () => Response {
    return () =>
      new Response(text, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  }

  it('GETs /<topic>/json?poll=1 with no extra params by default', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    const { calls } = captureFetch(ndjsonResponder(''));
    await svc.fetch({ topic: 'alerts' });
    expect(calls[0]?.method).toBe('GET');
    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/alerts/json');
    expect(url.searchParams.get('poll')).toBe('1');
    expect(url.searchParams.get('since')).toBeNull();
    expect(url.searchParams.get('scheduled')).toBeNull();
  });

  it('encodes every filter into the query string', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    const { calls } = captureFetch(ndjsonResponder(''));
    await svc.fetch({
      topic: 'alerts',
      since: '2h',
      scheduled: true,
      priority: [4, 5],
      tags: ['warning', 'cd'],
      id: 'msg_id',
      title: 'Backup failed',
      message: 'disk full',
    });
    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('since')).toBe('2h');
    expect(url.searchParams.get('scheduled')).toBe('1');
    expect(url.searchParams.get('priority')).toBe('4,5');
    expect(url.searchParams.get('tags')).toBe('warning,cd');
    expect(url.searchParams.get('id')).toBe('msg_id');
    expect(url.searchParams.get('title')).toBe('Backup failed');
    expect(url.searchParams.get('message')).toBe('disk full');
  });

  it('URL-encodes the topic segment for comma-separated lists', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    const { calls } = captureFetch(ndjsonResponder(''));
    await svc.fetch({ topic: 'alerts,backups' });
    expect(calls[0]?.url).toContain('/alerts%2Cbackups/json');
  });

  it('returns an empty array for an empty body', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    captureFetch(ndjsonResponder(''));
    const result = await svc.fetch({ topic: 'alerts' });
    expect(result).toEqual({ messages: [], upstreamTruncated: false });
  });

  it('throws on a non-OK upstream', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    captureFetch(
      () =>
        new Response('bad since', {
          status: 400,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    await expect(svc.fetch({ topic: 'alerts', since: 'tomorrow_maybe' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
  });

  it("reports ntfy's X-Messages-Truncated replay cap alongside the messages", async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    const lines = ['a', 'b', 'c'].map((id, i) =>
      JSON.stringify({ id, time: i + 1, event: 'message', topic: 'alerts' }),
    );
    captureFetch(
      () =>
        new Response(lines.join('\n'), {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson', 'x-messages-truncated': '1' },
        }),
    );
    const result = await svc.fetch({ topic: 'alerts', since: 'all' });
    expect(result.upstreamTruncated).toBe(true);
    expect(result.messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('reports no replay cap when ntfy sends no X-Messages-Truncated header', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    captureFetch(
      ndjsonResponder(JSON.stringify({ id: 'a', time: 1, event: 'message', topic: 'alerts' })),
    );
    const result = await svc.fetch({ topic: 'alerts', since: 'all' });
    expect(result.upstreamTruncated).toBe(false);
    expect(result.messages).toHaveLength(1);
  });
});

describe('NtfyService.fetch poll-body validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const message = (id: string, time: number) =>
    JSON.stringify({ id, time, event: 'message', topic: 'alerts', message: `body ${id}` });

  function bodyResponder(
    text: string,
    contentType = 'application/x-ndjson; charset=utf-8',
  ): () => Response {
    return () => new Response(text, { status: 200, headers: { 'content-type': contentType } });
  }

  async function pollError(
    responder: () => Response,
    maxRetries = 0,
  ): Promise<{
    calls: CapturedCall[];
    err: Error & { code?: unknown; data?: Record<string, unknown> };
  }> {
    const svc = new NtfyService({ ...makeConfig([{ baseUrl: 'https://ntfy.test' }]), maxRetries });
    const { calls } = captureFetch(responder);
    const err = await svc
      .fetch({ topic: 'alerts', since: 'all' })
      .then(() => {
        throw new Error('expected the poll to fail');
      })
      .catch((e: unknown) => e as Error & { code?: unknown; data?: Record<string, unknown> });
    return { calls, err };
  }

  it('fails an unparseable line instead of dropping it, retrying the round trip first', async () => {
    const body = [message('a', 1), '{ this is not json', message('b', 2)].join('\n');
    const { calls, err } = await pollError(bodyResponder(body), 2);
    expect(calls).toHaveLength(3);
    expect(getErrorCode(err)).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data?.reason).toBe('upstream_malformed');
    expect(err.message).toContain('line 2');
    expect(err.message).toContain('not valid JSON');
    expect(err.message).toMatch(/\(failed after 3 attempts\)$/);
  });

  it('fails a 200 HTML page rather than reporting an empty topic', async () => {
    const page = '<!doctype html>\n<html><body>Sign in to continue</body></html>';
    const { err } = await pollError(bodyResponder(page, 'text/html'));
    expect(getErrorCode(err)).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data?.reason).toBe('upstream_malformed');
    expect(err.message).toContain('text/html');
    expect(err.message).toContain('line 1');
  });

  it('fails a final message line cut off partway', async () => {
    const cut = message('b', 2).slice(0, 25);
    const { err } = await pollError(bodyResponder([message('a', 1), cut].join('\n')));
    expect(err.data?.reason).toBe('upstream_malformed');
    expect(err.message).toContain('line 2');
  });

  it.each([
    ['an object with no envelope fields', '{"foo":1}'],
    ['an array', '[1,2,3]'],
    ['a bare string', '"hello"'],
    ['a string `time`', '{"id":"a","event":"message","time":"1","topic":"alerts"}'],
    ['a missing `event`', '{"id":"a","time":1,"topic":"alerts"}'],
    ['a missing `topic`', '{"id":"a","time":1,"event":"message"}'],
  ])('fails a JSON line that is not a message envelope: %s', async (_label, line) => {
    const { err } = await pollError(bodyResponder([message('a', 1), line].join('\n')));
    expect(err.data?.reason).toBe('upstream_malformed');
    expect(err.message).toContain('line 2');
    expect(err.message).toContain('not an ntfy message');
  });

  it('surfaces an ntfy error envelope written onto a started 200 as that upstream error', async () => {
    const body = [
      message('a', 1),
      message('b', 2),
      '{"code":42905,"http":429,"error":"limit reached: daily bandwidth reached"}',
    ].join('\n');
    const { calls, err } = await pollError(bodyResponder(body));
    expect(calls).toHaveLength(1);
    expect(getErrorCode(err)).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.data?.status).toBe(429);
    expect(err.data?.reason).toBeUndefined();
    expect(err.message).toContain('ntfy returned HTTP 429');
    expect(err.message).toContain('limit reached: daily bandwidth');
    expect(err.message).not.toContain('Invalid Date');
  });

  it('does not retry an error envelope whose status is not transient', async () => {
    const body = [
      message('a', 1),
      '{"code":40301,"http":403,"error":"forbidden","link":"https://ntfy.sh/docs/config/#access-control"}',
    ].join('\n');
    const { calls, err } = await pollError(bodyResponder(body), 2);
    expect(calls).toHaveLength(1);
    expect(getErrorCode(err)).toBe(JsonRpcErrorCode.Forbidden);
    expect(err.message).toContain('forbidden (see https://ntfy.sh/docs/config/#access-control)');
  });

  it('returns the body a retry delivers after a malformed attempt', async () => {
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      maxRetries: 2,
    });
    let attempt = 0;
    const { calls } = captureFetch(() => {
      attempt += 1;
      return attempt === 1
        ? new Response('<html>gateway hiccup</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
        : new Response([message('a', 1), message('b', 2)].join('\n'), { status: 200 });
    });
    const result = await svc.fetch({ topic: 'alerts', since: 'all' });
    expect(calls).toHaveLength(2);
    expect(result.messages.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('accepts blank lines, \\r\\n separators, and open/keepalive frames without complaint', async () => {
    const body = [
      JSON.stringify({ id: 'o', time: 1, event: 'open', topic: 'alerts' }),
      '',
      message('a', 2),
      '   ',
      JSON.stringify({ id: 'k', time: 3, event: 'keepalive', topic: 'alerts' }),
      '',
    ].join('\r\n');
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    captureFetch(bodyResponder(body));
    const result = await svc.fetch({ topic: 'alerts', since: 'all' });
    expect(result.messages.map((m) => m.id)).toEqual(['o', 'a', 'k']);
  });
});

/**
 * A `200` to a publish or a clear/delete may already have taken effect upstream,
 * so a reply that is not ntfy's message envelope fails on the first attempt —
 * `NTFY_MAX_RETRIES` is 3 here, and the request count is how many notifications
 * or events went out.
 */
describe('NtfyService publish and manage reply validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const REPLIES = [
    ['publish', 'message', (svc: NtfyService) => svc.publish(PUBLISH_BODY)],
    ['clear', 'message_clear', (svc: NtfyService) => svc.manage('alerts', 'seq_1', 'clear')],
    ['delete', 'message_delete', (svc: NtfyService) => svc.manage('alerts', 'seq_1', 'delete')],
  ] as const;

  const reply = (text: string, contentType?: string) => () =>
    new Response(text, {
      status: 200,
      ...(contentType ? { headers: { 'content-type': contentType } } : {}),
    });

  async function replyError(
    responder: () => Response,
    call: (svc: NtfyService) => Promise<unknown>,
  ): Promise<{
    calls: CapturedCall[];
    err: Error & { code?: unknown; data?: Record<string, unknown> };
  }> {
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      maxRetries: 3,
    });
    const { calls } = captureFetch(responder);
    const err = await call(svc).then(
      () => {
        throw new Error('expected the call to fail');
      },
      (e: unknown) => e as Error & { code?: unknown; data?: Record<string, unknown> },
    );
    return { calls, err };
  }

  describe.each(REPLIES)('%s', (operation, event, call) => {
    const envelope = (fields: Record<string, unknown> = {}) =>
      JSON.stringify({
        id: 'e1',
        time: 1,
        event,
        topic: 'alerts',
        sequence_id: 'seq_1',
        ...fields,
      });

    it.each([
      // Not 'reply is empty': a runtime may give `new Response('')` a default
      // content-type, which the message names between those two words.
      ['an empty body', '', undefined, 'is empty'],
      [
        'an HTML page',
        '<!doctype html><html>Captive portal</html>',
        'text/html',
        'is not valid JSON',
      ],
      ['JSON `null`', 'null', 'application/json', 'is not an ntfy message'],
      ['a JSON array', '[]', 'application/json', 'is not an ntfy message'],
      [
        'an object with no envelope fields',
        '{"ok":true}',
        'application/json',
        'is not an ntfy message',
      ],
    ])(
      'fails %s as `upstream_malformed` without sending it again',
      async (_label, text, contentType, problem) => {
        const { calls, err } = await replyError(reply(text, contentType), call);
        expect(calls).toHaveLength(1);
        expect(getErrorCode(err)).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(err.data).toMatchObject({ reason: 'upstream_malformed', retryable: false });
        expect(err.message).toContain(`${operation} was answered with HTTP 200`);
        expect(err.message).toContain(problem);
        if (contentType) expect(err.message).toContain(`content-type ${contentType}`);
        expect(err.message).not.toMatch(/failed after/);
        expect(isUpstreamUnreachable(err)).toBe(false);
      },
    );

    it.each([
      ['a string `time`', { time: '1' }],
      ['a missing `id`', { id: undefined }],
      ['a missing `event`', { event: undefined }],
      ['a missing `topic`', { topic: undefined }],
    ])('fails a reply with %s as `upstream_malformed`', async (_label, fields) => {
      const { calls, err } = await replyError(reply(envelope(fields), 'application/json'), call);
      expect(calls).toHaveLength(1);
      expect(err.data).toMatchObject({ reason: 'upstream_malformed', retryable: false });
      expect(err.message).toContain('not an ntfy message');
    });

    it("returns ntfy's reply unchanged", async () => {
      const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
      captureFetch(reply(envelope({ expires: 99 }), 'application/json'));
      await expect(call(svc)).resolves.toEqual(JSON.parse(envelope({ expires: 99 })));
    });
  });

  it('fails a clear or delete reply that names no `sequence_id`', async () => {
    const body = JSON.stringify({ id: 'e1', time: 1, event: 'message_clear', topic: 'alerts' });
    const { calls, err } = await replyError(reply(body, 'application/json'), (svc) =>
      svc.manage('alerts', 'seq_1', 'clear'),
    );
    expect(calls).toHaveLength(1);
    expect(err.data).toMatchObject({ reason: 'upstream_malformed', retryable: false });
    expect(err.message).toContain('names no `sequence_id`');
  });

  it('accepts a publish reply with no `sequence_id`, which ntfy omits when none was set', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    captureFetch(
      reply(
        JSON.stringify({ id: 'm1', time: 1, event: 'message', topic: 'alerts' }),
        'application/json',
      ),
    );
    await expect(svc.publish(PUBLISH_BODY)).resolves.toMatchObject({ id: 'm1' });
  });
});

describe('NtfyService cancellation vs timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('surfaces a request-deadline abort as a timeout, never a cancellation', async () => {
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      requestTimeoutMs: 20,
    });
    captureFetch(abortAwareResponder);
    const err = await svc.publish(PUBLISH_BODY).catch((e: unknown) => e as Error);
    expect(getErrorCode(err)).not.toBe(JsonRpcErrorCode.RequestCancelled);
    expect(err.message).toContain('Timeout');
    // Retry-exhausted, so the network classifier still claims it.
    expect(err.message).toMatch(/\(failed after 1 attempt\)/);
    expect(isUpstreamUnreachable(err)).toBe(true);
  });

  it('surfaces a caller disconnect as RequestCancelled', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    const controller = new AbortController();
    captureFetch((call) => {
      queueMicrotask(() => controller.abort());
      return abortAwareResponder(call);
    });
    const err = await svc
      .publish(PUBLISH_BODY, { signal: controller.signal })
      .catch((e: unknown) => e as Error);
    expect(getErrorCode(err)).toBe(JsonRpcErrorCode.RequestCancelled);
  });

  it('surfaces an already-aborted caller signal as RequestCancelled', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    const controller = new AbortController();
    controller.abort();
    captureFetch(abortAwareResponder);
    const err = await svc
      .fetch({ topic: 'alerts' }, { signal: controller.signal })
      .catch((e: unknown) => e as Error);
    expect(getErrorCode(err)).toBe(JsonRpcErrorCode.RequestCancelled);
  });

  it('does not treat a cancellation as unreachable, and does not retry it', async () => {
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      maxRetries: 3,
    });
    const controller = new AbortController();
    const { calls } = captureFetch((call) => {
      queueMicrotask(() => controller.abort());
      return abortAwareResponder(call);
    });
    const err = await svc
      .manage('alerts', 'seq_1', 'clear', { signal: controller.signal })
      .catch((e: unknown) => e as Error);
    expect(getErrorCode(err)).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(isUpstreamUnreachable(err)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('classifies a disconnect that lands on a later retry attempt', async () => {
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      maxRetries: 2,
    });
    const controller = new AbortController();
    let attempt = 0;
    const { calls } = captureFetch((call) => {
      attempt += 1;
      if (attempt === 1) {
        return new Response('upstream hiccup', {
          status: 503,
          headers: { 'content-type': 'text/plain' },
        });
      }
      queueMicrotask(() => controller.abort());
      return abortAwareResponder(call);
    });
    const err = await svc
      .publish(PUBLISH_BODY, { signal: controller.signal })
      .catch((e: unknown) => e as Error);
    expect(calls).toHaveLength(2);
    expect(getErrorCode(err)).toBe(JsonRpcErrorCode.RequestCancelled);
    // The retry budget was not spent re-issuing a request nobody is waiting for.
    expect(err.message).not.toMatch(/failed after/);
  });

  it('surfaces a disconnect that lands during a retry backoff as RequestCancelled', async () => {
    vi.useFakeTimers();
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      maxRetries: 2,
    });
    const controller = new AbortController();
    const { calls } = captureFetch(() => {
      // The first attempt answers 503 at t=0; the caller leaves at t=20 ms,
      // inside the first backoff (never under 375 ms).
      setTimeout(() => controller.abort(), 20);
      return new Response('upstream hiccup', {
        status: 503,
        headers: { 'content-type': 'text/plain' },
      });
    });
    const { elapsed, outcome } = await runOnFakeClock(
      svc.fetch({ topic: 'alerts' }, { signal: controller.signal }),
    );
    // Settled when the caller left, not when the backoff would have ended.
    expect(elapsed).toBe(20);
    expect(calls).toHaveLength(1);
    const { error } = outcome as { error: Error };
    expect(getErrorCode(error)).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(isUpstreamUnreachable(error)).toBe(false);
  });
});

/**
 * A responder that models a real `fetch` whose upstream sent headers and one
 * line, then stalled: the body stays open until the request signal aborts,
 * and then errors with the abort reason — what Bun's and Node's `fetch` both
 * do to a body still being read when the signal fires.
 */
function stalledBodyResponder(call: CapturedCall): Response {
  const signal = call.signal;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode('{"id":"a","time":1,"event":"open","topic":"alerts"}\n'),
      );
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

type Outcome = { error: Error & { data?: Record<string, unknown> } } | { value: unknown };

/**
 * Run `promise` on the fake clock (`vi.useFakeTimers()` must be on before the
 * call starts) and report when, in fake ms, it settled — `elapsed` stays
 * `undefined` for a call still pending after 120 s.
 */
async function runOnFakeClock(promise: Promise<unknown>) {
  const startedAt = Date.now();
  let settledAt: number | undefined;
  let outcome: Outcome | undefined;
  promise.then(
    (value) => {
      settledAt = Date.now();
      outcome = { value };
    },
    (error: unknown) => {
      settledAt = Date.now();
      outcome = { error: error as Error & { data?: Record<string, unknown> } };
    },
  );
  await vi.advanceTimersByTimeAsync(120_000);
  return { elapsed: settledAt === undefined ? undefined : settledAt - startedAt, outcome };
}

const ROUND_TRIPS = [
  ['fetch', (svc: NtfyService, signal?: AbortSignal) => svc.fetch({ topic: 'alerts' }, { signal })],
  ['publish', (svc: NtfyService, signal?: AbortSignal) => svc.publish(PUBLISH_BODY, { signal })],
  [
    'manage',
    (svc: NtfyService, signal?: AbortSignal) => svc.manage('alerts', 'seq_1', 'clear', { signal }),
  ],
] as const;

describe('NtfyService body reads stay inside the request deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(ROUND_TRIPS)('%s: times out a body that stalls after the headers', async (_op, call) => {
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      requestTimeoutMs: 50,
    });
    captureFetch(stalledBodyResponder);
    const { elapsed, outcome } = await runOnFakeClock(call(svc));
    // Cut off by the 50 ms per-attempt timer, not left for the 50 s call deadline.
    expect(elapsed).toBe(50);
    const { error } = outcome as { error: Error };
    expect(getErrorCode(error)).not.toBe(JsonRpcErrorCode.RequestCancelled);
    expect(error.message).toMatch(/\(failed after 1 attempt\)/);
    expect(isUpstreamUnreachable(error)).toBe(true);
  });

  it.each(ROUND_TRIPS)(
    '%s: aborts a stalled body when the caller cancels, without retrying',
    async (_op, call) => {
      const svc = new NtfyService({
        ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
        requestTimeoutMs: 60_000,
        maxRetries: 3,
      });
      const controller = new AbortController();
      const { calls } = captureFetch((captured) => {
        // Headers are back and the body is being read when the caller leaves.
        setTimeout(() => controller.abort(), 20);
        return stalledBodyResponder(captured);
      });
      const { elapsed, outcome } = await runOnFakeClock(call(svc, controller.signal));
      expect(elapsed).toBe(20);
      const { error } = outcome as { error: Error };
      expect(getErrorCode(error)).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(calls).toHaveLength(1);
    },
  );

  it('settles a cancel that lands during the `base_url` DNS lookup as RequestCancelled', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }], true));
    vi.mocked(lookup).mockImplementationOnce(() => new Promise(() => {}) as never);
    const { calls } = captureFetch();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const { elapsed, outcome } = await runOnFakeClock(
      svc.fetch(
        { topic: 'alerts' },
        { baseUrl: 'https://slow-dns.example', signal: controller.signal },
      ),
    );
    // The lookup never settles; the cancel alone ends the call.
    expect(elapsed).toBe(20);
    const { error } = outcome as { error: Error };
    expect(getErrorCode(error)).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(calls).toHaveLength(0);
  });
});

describe('NtfyService call deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ['headers that never arrive', abortAwareResponder],
    ['a body that stalls after the headers', stalledBodyResponder],
  ] as const)('bounds four 15 s attempts against %s by the deadline', async (_label, responder) => {
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      requestTimeoutMs: 15_000,
      maxRetries: 3,
    });
    captureFetch(responder);
    const { elapsed, outcome } = await runOnFakeClock(svc.fetch({ topic: 'alerts' }));
    // The ladder was cut short: without the deadline all four attempts run (~64 s).
    // The bound that matters to the caller is the 60 s MCP client request timeout.
    expect(elapsed).toBeDefined();
    expect(elapsed).toBeLessThan(60_000);
    const { error } = outcome as { error: Error & { data?: Record<string, unknown> } };
    expect(getErrorCode(error)).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data?.reason).toBe('retry_deadline_exceeded');
    expect(isUpstreamUnreachable(error)).toBe(true);
  });

  const LABELLED_CALLS = [
    ['ntfy poll', (svc: NtfyService) => svc.fetch({ topic: 'alerts' })],
    ['ntfy publish', (svc: NtfyService) => svc.publish(PUBLISH_BODY)],
    ['ntfy clear', (svc: NtfyService) => svc.manage('alerts', 'seq_1', 'clear')],
    ['ntfy delete', (svc: NtfyService) => svc.manage('alerts', 'seq_1', 'delete')],
  ] as const;

  it.each(LABELLED_CALLS)(
    'names the round trip as %j, not a class method, when the deadline ends it',
    async (label, call) => {
      const svc = new NtfyService({
        ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
        requestTimeoutMs: 60_000,
      });
      captureFetch(abortAwareResponder);
      const { outcome } = await runOnFakeClock(call(svc));
      const { error } = outcome as { error: Error & { data?: Record<string, unknown> } };
      expect(error.data?.reason).toBe('retry_deadline_exceeded');
      expect(error.message).toBe(`${label} exceeded its 50000ms retry deadline after 1 attempt.`);
    },
  );

  it.each(LABELLED_CALLS)(
    'names the round trip as %j on an error that ran out of retries',
    async (label, call) => {
      const svc = new NtfyService({
        ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
        maxRetries: 1,
      });
      captureFetch(() => new Response('down', { status: 503 }));
      const { outcome } = await runOnFakeClock(call(svc));
      const { error } = outcome as { error: Error & { data?: Record<string, unknown> } };
      expect(error.message).toContain('(failed after 2 attempts)');
      expect(error.data?.operation).toBe(label);
    },
  );

  it('settles a call the caller cancels mid-ladder as RequestCancelled, not as a deadline expiry', async () => {
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      requestTimeoutMs: 15_000,
      maxRetries: 3,
    });
    const controller = new AbortController();
    const { calls } = captureFetch(abortAwareResponder);
    setTimeout(() => controller.abort(), 20_000);
    const { elapsed, outcome } = await runOnFakeClock(
      svc.fetch({ topic: 'alerts' }, { signal: controller.signal }),
    );
    expect(elapsed).toBe(20_000);
    expect(calls).toHaveLength(2);
    const { error } = outcome as { error: Error & { data?: Record<string, unknown> } };
    expect(getErrorCode(error)).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(error.data?.reason).toBeUndefined();
  });

  /**
   * Each attempt takes 16 s to answer, so the third answer lands with under a
   * second of budget left — less than the next backoff — and the deadline ends
   * the ladder on an attempt ntfy actually answered.
   */
  function slowAnswer(response: () => Response) {
    return () =>
      new Promise<Response>((resolve) => {
        setTimeout(() => resolve(response()), 16_000);
      });
  }

  it('reports the 429 that ended a deadline-cut ladder as RateLimited, not unreachable', async () => {
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      requestTimeoutMs: 20_000,
      maxRetries: 3,
    });
    const { calls } = captureFetch(
      slowAnswer(
        () =>
          new Response('{"code":42901,"http":429,"error":"limit reached"}', {
            status: 429,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const { elapsed, outcome } = await runOnFakeClock(svc.fetch({ topic: 'alerts' }));
    expect(elapsed).toBeLessThanOrEqual(CALL_DEADLINE_MS);
    expect(calls).toHaveLength(3);
    const { error } = outcome as { error: Error & { data?: Record<string, unknown> } };
    expect(getErrorCode(error)).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.message).toContain('limit reached');
    expect(error.message).toMatch(/\(failed after 3 attempts\)$/);
    expect(error.data?.status).toBe(429);
    expect(isUpstreamUnreachable(error)).toBe(false);
  });

  it('keeps `upstream_malformed` on a malformed body that ended a deadline-cut ladder', async () => {
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      requestTimeoutMs: 20_000,
      maxRetries: 3,
    });
    const { calls } = captureFetch(
      slowAnswer(
        () =>
          new Response('<html>captive portal</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );
    const { outcome } = await runOnFakeClock(svc.fetch({ topic: 'alerts' }));
    expect(calls).toHaveLength(3);
    const { error } = outcome as { error: Error & { data?: Record<string, unknown> } };
    expect(getErrorCode(error)).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBe('upstream_malformed');
    expect(error.message).toMatch(/\(failed after 3 attempts\)$/);
  });

  const unavailable = (retryAfter: string) => () =>
    new Response('{"code":50301,"http":503,"error":"service unavailable"}', {
      status: 503,
      headers: { 'content-type': 'application/json', 'retry-after': retryAfter },
    });

  it('marks a Retry-After ladder the deadline cuts short as exhausted, so a 503 stays unreachable', async () => {
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      requestTimeoutMs: 15_000,
      maxRetries: 3,
    });
    // Waits of 20 s: attempts at 0, 20, and 40 s, then a wait that outlasts the budget.
    const { calls } = captureFetch(unavailable('20'));
    const { elapsed, outcome } = await runOnFakeClock(svc.fetch({ topic: 'alerts' }));
    expect(elapsed).toBeLessThanOrEqual(CALL_DEADLINE_MS);
    expect(calls).toHaveLength(3);
    const { error } = outcome as { error: Error & { data?: Record<string, unknown> } };
    expect(getErrorCode(error)).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toMatch(/\(failed after 3 attempts\)$/);
    expect(error.data?.retryAfter).toBe('20');
    expect(isUpstreamUnreachable(error)).toBe(true);
  });

  it('leaves a Retry-After that fails the first attempt fast untouched', async () => {
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      requestTimeoutMs: 15_000,
      maxRetries: 3,
    });
    const { calls } = captureFetch(unavailable('40'));
    const { outcome } = await runOnFakeClock(svc.fetch({ topic: 'alerts' }));
    expect(calls).toHaveLength(1);
    const { error } = outcome as { error: Error & { data?: Record<string, unknown> } };
    expect(error.message).not.toMatch(/failed after/);
    expect(isUpstreamUnreachable(error)).toBe(false);
  });
});

describe('NtfyService retry exhaustion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries an upstream 5xx to exhaustion and lands on `upstream_unreachable` territory', async () => {
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      maxRetries: 2,
    });
    const { calls } = captureFetch(
      () => new Response('bad gateway', { status: 502, headers: { 'content-type': 'text/plain' } }),
    );
    const err = await svc.publish(PUBLISH_BODY).catch((e: unknown) => e as Error);
    expect(calls).toHaveLength(3);
    expect(getErrorCode(err)).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toMatch(/\(failed after 3 attempts\)/);
    expect(isUpstreamUnreachable(err)).toBe(true);
  });

  it('retries a 500 the same way — no status maps to InternalError any more', async () => {
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      maxRetries: 1,
    });
    const { calls } = captureFetch(
      () => new Response('boom', { status: 500, headers: { 'content-type': 'text/plain' } }),
    );
    const err = await svc.fetch({ topic: 'alerts' }).catch((e: unknown) => e as Error);
    expect(calls).toHaveLength(2);
    expect(getErrorCode(err)).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(isUpstreamUnreachable(err)).toBe(true);
  });

  it('does not fold a retried-out 429 into unreachable', async () => {
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      maxRetries: 1,
    });
    const { calls } = captureFetch(
      () => new Response('slow down', { status: 429, headers: { 'content-type': 'text/plain' } }),
    );
    const err = await svc.publish(PUBLISH_BODY).catch((e: unknown) => e as Error);
    expect(calls).toHaveLength(2);
    expect(getErrorCode(err)).toBe(JsonRpcErrorCode.RateLimited);
    expect(isUpstreamUnreachable(err)).toBe(false);
  });
});

describe('NtfyService module-level accessors', () => {
  beforeEach(() => {
    resetNtfyService();
  });
  afterEach(() => {
    resetNtfyService();
    vi.restoreAllMocks();
  });

  it('getNtfyService throws when called before init', () => {
    expect(() => getNtfyService()).toThrow(/not initialized/i);
  });

  it('initNtfyService returns the same instance that getNtfyService later resolves', () => {
    const svc = initNtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    expect(getNtfyService()).toBe(svc);
  });

  it('resetNtfyService unblocks fresh init across suites', () => {
    initNtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    resetNtfyService();
    expect(() => getNtfyService()).toThrow(/not initialized/i);
  });
});
