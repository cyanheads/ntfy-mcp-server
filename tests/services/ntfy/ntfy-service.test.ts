/**
 * @fileoverview Tests for `NtfyService` — multi-server auth resolution, the
 * request-shape contract for publish/manage/fetch (URL, method, headers,
 * body), NDJSON parsing edge cases and the poll-body validation that fails a
 * damaged body as `upstream_malformed` (or surfaces a mid-stream ntfy error
 * line), the publish and clear/delete reply validation that fails a `200` that
 * is not an ntfy message — or fails partway through being read — as
 * `upstream_malformed` without resending it, the
 * `X-Messages-Truncated` replay-cap flag, ntfy's clock read from the poll's
 * `Date` header, upstream error propagation including the
 * JSON error body folded into the message and the request URL kept off
 * `error.data`, an answer without ntfy's envelope naming only the request host
 * and labelled `not_ntfy_endpoint` (so is ntfy's own 40401), its body's `error`
 * text kept off the message and every topic name masked in its captured body, the module-level
 * init/get/reset accessors, and `base_url` override validation — the always-on absolute
 * http(s) check plus the opt-in private-host guard, its registered-base bypass,
 * and its redirect refusal. `waitForMessage` on a stream the test feeds: the
 * stream's request (query, base, credentials, redirect rule), each way a wait
 * ends, the bound on the line it holds, and the per-process wait cap.
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
  MAX_OPEN_WAITS,
  NtfyService,
  openWaitCount,
  resetNtfyService,
} from '@/services/ntfy/ntfy-service.js';

// Passthrough, so a test can hold one `base_url` lookup open.
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});
const { lookup } = await import('node:dns/promises');

const PUBLISH_BODY = { topic: 'alerts', message: 'hi' } as const;

/** The page example.com answers a poll path and a `POST /` with — no ntfy envelope. */
const EXAMPLE_PAGE =
  '<!doctype html><html lang=en><head><title>Example Domain</title></head><body><p>This domain is for use in documentation examples.</p></body></html>';

function makeConfig(servers: ServerConfig['servers'], blockPrivateHosts = false): ServerConfig {
  return {
    servers,
    requestTimeoutMs: 1000,
    maxRetries: 0,
    blockPrivateHosts,
    clampLimits: true,
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

  /** #58: a probe credential that must never reach the upstream, a message, or `data`. */
  const CREDENTIALED = 'https://probeuser:pwSECRET@ntfy.example.com';

  it.each([
    ['publish', (svc: NtfyService) => svc.publish(PUBLISH_BODY, { baseUrl: CREDENTIALED })],
    [
      'manage',
      (svc: NtfyService) => svc.manage('alerts', 'seq_1', 'clear', { baseUrl: CREDENTIALED }),
    ],
    ['fetch', (svc: NtfyService) => svc.fetch({ topic: 'alerts' }, { baseUrl: CREDENTIALED })],
  ])(
    'refuses a %s override carrying credentials before any request goes out (#58)',
    async (_operation, call) => {
      const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
      const { calls } = captureFetch();
      const err = (await call(svc).catch((e: unknown) => e)) as Error & {
        data?: Record<string, unknown>;
      };
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining('"ntfy.example.com"'),
        data: { baseUrlRejected: true },
      });
      expect(JSON.stringify({ message: err.message, data: err.data })).not.toMatch(
        /probeuser|pwSECRET/,
      );
      expect(calls).toHaveLength(0);
    },
  );
});

/**
 * The error the retry boundary, the logs, and the caller read from a `fetch`
 * rejection carries no request URL, and nothing else about the failure changes.
 */
describe('NtfyService fetch rejections carry no request URL', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const TOPIC = 'ntfyval-5e1f0c2a9b7d3864';

  /** A `fetch` rejection quoting the request URL in its message, its stack, and a `path` property. */
  function urlQuotingFetchError(code: string, url: string): TypeError {
    return Object.assign(
      new TypeError(
        `${code} fetching "${url}". For more information, pass \`verbose: true\` in the second argument to fetch()`,
      ),
      { code, path: url, errno: 0 },
    );
  }

  /** Every string an error carries — message, stack, each own property — down its whole cause chain. */
  function everythingIn(err: unknown): string {
    const parts: string[] = [];
    for (let e: unknown = err; e instanceof Error; e = e.cause) {
      parts.push(e.message, String(e.stack));
      for (const key of Object.getOwnPropertyNames(e)) {
        const value: unknown = Reflect.get(e, key);
        parts.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
      }
    }
    return parts.join('\n');
  }

  it('retries a URL-quoting poll failure to exhaustion with no topic in the error or the retry log', async () => {
    const { logger } = await import('@cyanheads/mcp-ts-core/utils');
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    vi.useFakeTimers();
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      maxRetries: 2,
    });
    const { calls } = captureFetch((call) => {
      throw urlQuotingFetchError('Malformed_HTTP_Response', call.url);
    });
    const { outcome } = await runOnFakeClock(svc.fetch({ topic: TOPIC, since: '10m' }));
    const { error } = outcome as { error: Error };

    expect(calls).toHaveLength(3);
    expect(new URL(calls[0]?.url ?? '').pathname).toBe(`/${TOPIC}/json`);
    expect(error.message).toBe('Malformed_HTTP_Response (failed after 3 attempts)');
    expect(isUpstreamUnreachable(error)).toBe(true);
    // The transport failure keeps what the retry boundary and the classifiers read.
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(error.cause).toMatchObject({
      name: 'TypeError',
      code: 'Malformed_HTTP_Response',
      message: 'Malformed_HTTP_Response',
    });
    expect(Object.hasOwn(error.cause as Error, 'path')).toBe(false);
    expect((error.cause as Error).cause).toBeUndefined();
    const carried = everythingIn(error);
    expect(carried).not.toContain(TOPIC);
    expect(carried).not.toContain('verbose');

    const retries = debug.mock.calls.filter(([msg]) => String(msg).startsWith('Retry '));
    expect(retries).toHaveLength(2);
    for (const call of retries) {
      expect(String(call[0])).toContain('Malformed_HTTP_Response');
      expect(JSON.stringify(call)).not.toContain(TOPIC);
    }
  });

  it('refuses a URL-quoting redirect rejection on a guarded override, with no topic anywhere in the refusal', async () => {
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }], true),
      maxRetries: 2,
    });
    const { calls } = captureFetch((call) => {
      throw urlQuotingFetchError('UnexpectedRedirect', call.url);
    });
    const err = (await svc
      .fetch({ topic: TOPIC }, { baseUrl: 'https://1.1.1.1' })
      .catch((e: unknown) => e)) as Error & { data?: Record<string, unknown> };

    expect(calls).toHaveLength(1);
    expect(calls[0]?.redirect).toBe('error');
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('redirects are not followed'),
      data: { baseUrlRejected: true },
    });
    expect(err.message).toContain('"1.1.1.1"');
    expect(err.cause).toMatchObject({ code: 'UnexpectedRedirect' });
    expect(everythingIn(err)).not.toContain(TOPIC);
  });

  it('keeps a topic named for a redirect out of the redirect check', async () => {
    const topic = `redirect-${TOPIC}`;
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }], true));
    const { calls } = captureFetch((call) => {
      throw urlQuotingFetchError('Malformed_HTTP_Response', call.url);
    });
    const err = (await svc
      .fetch({ topic }, { baseUrl: 'https://1.1.1.1' })
      .catch((e: unknown) => e)) as Error;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.redirect).toBe('error');
    expect(getErrorCode(err)).not.toBe(JsonRpcErrorCode.ValidationError);
    expect(err.message).toBe('Malformed_HTTP_Response (failed after 1 attempt)');
    expect(isUpstreamUnreachable(err)).toBe(true);
    expect(everythingIn(err)).not.toContain(topic);
  });

  it('keeps a per-attempt timeout the timer’s own abort reason', async () => {
    vi.useFakeTimers();
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    const { calls } = captureFetch(abortAwareResponder);
    const { elapsed, outcome } = await runOnFakeClock(svc.fetch({ topic: TOPIC }));
    const { error } = outcome as { error: Error };

    expect(elapsed).toBe(1000);
    expect(error.message).toBe('Timeout (failed after 1 attempt)');
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause).toBe(calls[0]?.signal?.reason);
    expect(isUpstreamUnreachable(error)).toBe(true);
  });

  it('surfaces the caller’s cancellation as RequestCancelled around its own abort reason', async () => {
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      maxRetries: 3,
    });
    const controller = new AbortController();
    const { calls } = captureFetch((call) => {
      queueMicrotask(() => controller.abort());
      return abortAwareResponder(call);
    });
    const err = (await svc
      .fetch({ topic: TOPIC }, { signal: controller.signal })
      .catch((e: unknown) => e)) as Error;

    expect(calls).toHaveLength(1);
    expect(getErrorCode(err)).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(err.cause).toMatchObject({ name: 'AbortError' });
    expect(err.cause).toBe(controller.signal.reason);
  });

  it('passes a `fetch failed` rejection that quotes no URL through untouched, and retries it', async () => {
    vi.useFakeTimers();
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      maxRetries: 1,
    });
    const fetchFailed = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
        code: 'ECONNREFUSED',
      }),
    });
    const { calls } = captureFetch(() => {
      throw fetchFailed;
    });
    const { outcome } = await runOnFakeClock(svc.fetch({ topic: TOPIC }));
    const { error } = outcome as { error: Error };

    expect(calls).toHaveLength(2);
    expect(error.cause).toBe(fetchFailed);
    expect(fetchFailed.message).toBe('fetch failed');
    expect(error.message).toBe('fetch failed (failed after 2 attempts)');
    expect(isUpstreamUnreachable(error)).toBe(true);
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
    const err = (await svc
      .publish({ topic: 'alerts', message: 'x', delay: '9 fortnights' })
      .catch((e: unknown) => e)) as Error;
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

  it('names the host the request was sent to in the status line for a non-JSON body', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    captureFetch(
      () =>
        new Response('forbidden topic', {
          status: 403,
          statusText: 'Forbidden',
          headers: { 'content-type': 'text/plain' },
        }),
    );
    const err = (await svc.publish(PUBLISH_BODY).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('ntfy.test returned HTTP 403 Forbidden.');
  });

  /**
   * #55: ntfy answers every failure on its own routes with its JSON envelope, so
   * an answer without one came from something else — a `base_url` that is no
   * ntfy root, a proxy, ntfy.sh's docs or static file server.
   */
  describe('an answer without ntfy’s envelope (#55)', () => {
    /** A port and a path on the base; the topic rides the path or body. */
    const OVERRIDE = 'https://proxy.test:8443/ntfy';
    const TOPIC = 'tok_q81zv';
    const page =
      (status: number, statusText: string, body = EXAMPLE_PAGE) =>
      () =>
        new Response(body, { status, statusText, headers: { 'content-type': 'text/html' } });

    it.each([
      [
        'publish',
        (svc: NtfyService) => svc.publish({ topic: TOPIC, message: 'x' }, { baseUrl: OVERRIDE }),
      ],
      ['manage', (svc: NtfyService) => svc.manage(TOPIC, 'seq_1', 'clear', { baseUrl: OVERRIDE })],
      [
        'fetch',
        (svc: NtfyService) => svc.fetch({ topic: TOPIC, since: '1h' }, { baseUrl: OVERRIDE }),
      ],
    ] as const)(
      'fails a %s as `not_ntfy_endpoint`, naming only the request host, with the status-derived code',
      async (_label, call) => {
        const svc = new NtfyService({
          ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
          maxRetries: 2,
        });
        const { calls } = captureFetch(page(404, 'Not Found'));
        const err = (await call(svc).catch((e: unknown) => e)) as Error & {
          code?: unknown;
          data?: Record<string, unknown>;
        };
        expect(calls).toHaveLength(1);
        expect(getErrorCode(err)).toBe(JsonRpcErrorCode.NotFound);
        expect(err.message).toBe('proxy.test:8443 returned HTTP 404 Not Found.');
        expect(err.data).toMatchObject({
          reason: 'not_ntfy_endpoint',
          retryable: false,
          status: 404,
        });
        for (const leak of ['/ntfy', TOPIC, 'poll']) {
          expect(err.message).not.toContain(leak);
        }
      },
    );

    it.each([
      [405, 'Method Not Allowed', EXAMPLE_PAGE, JsonRpcErrorCode.InvalidRequest],
      [501, 'Not Implemented', 'Unsupported method', JsonRpcErrorCode.ServiceUnavailable],
      [401, 'Unauthorized', 'Unauthorized', JsonRpcErrorCode.Unauthorized],
      [403, 'Forbidden', '<html><title>403 Forbidden</title></html>', JsonRpcErrorCode.Forbidden],
    ])('keeps the code a %i maps to, sent once', async (status, statusText, body, code) => {
      const svc = new NtfyService({
        ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
        maxRetries: 2,
      });
      const { calls } = captureFetch(page(status, statusText, body));
      const err = (await svc.publish(PUBLISH_BODY).catch((e: unknown) => e)) as Error & {
        data?: Record<string, unknown>;
      };
      expect(calls).toHaveLength(1);
      expect(getErrorCode(err)).toBe(code);
      expect(err.message).toBe(`ntfy.test returned HTTP ${status} ${statusText}.`);
      expect(err.data).toMatchObject({ reason: 'not_ntfy_endpoint', retryable: false, status });
    });

    it.each([
      [429, 'Too Many Requests', JsonRpcErrorCode.RateLimited],
      [503, 'Service Unavailable', JsonRpcErrorCode.ServiceUnavailable],
    ])(
      'names the host on a %i but leaves it to the reason that claims that status',
      async (status, statusText, code) => {
        const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
        captureFetch(page(status, statusText, ''));
        const err = (await svc
          .fetch({ topic: 'alerts', since: '1h' })
          .catch((e: unknown) => e)) as Error & { data?: Record<string, unknown> };
        expect(getErrorCode(err)).toBe(code);
        expect(err.message).toMatch(
          new RegExp(`^ntfy\\.test returned HTTP ${status} ${statusText}\\.`),
        );
        expect(err.data?.reason).toBeUndefined();
      },
    );

    it("keeps ntfy's words and the `ntfy returned` subject on its own 40401 route miss, stamping the reason", async () => {
      const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
      captureFetch(
        () =>
          new Response('{"code":40401,"http":404,"error":"page not found"}', {
            status: 404,
            statusText: 'Not Found',
            headers: { 'content-type': 'application/json' },
          }),
      );
      const err = (await svc
        .fetch({ topic: 'alerts', since: '1h' })
        .catch((e: unknown) => e)) as Error & { data?: Record<string, unknown> };
      expect(getErrorCode(err)).toBe(JsonRpcErrorCode.NotFound);
      expect(err.message).toBe('ntfy returned HTTP 404 Not Found: page not found');
      expect(err.data).toMatchObject({ reason: 'not_ntfy_endpoint', retryable: false });
    });

    it("leaves ntfy's other envelopes unstamped, with the `ntfy returned` subject", async () => {
      const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
      captureFetch(
        () =>
          new Response('{"code":40301,"http":403,"error":"forbidden"}', {
            status: 403,
            statusText: 'Forbidden',
            headers: { 'content-type': 'application/json' },
          }),
      );
      const err = (await svc.publish(PUBLISH_BODY).catch((e: unknown) => e)) as Error & {
        data?: Record<string, unknown>;
      };
      expect(err.message).toBe('ntfy returned HTTP 403 Forbidden: forbidden');
      expect(err.data).not.toHaveProperty('reason');
      expect(err.data).not.toHaveProperty('retryable');
    });

    it("folds no `error` string from a JSON body without ntfy's envelope into the message", async () => {
      const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
      captureFetch(
        () =>
          new Response(`{"error":"no route for /${TOPIC}/json"}`, {
            status: 404,
            statusText: 'Not Found',
            headers: { 'content-type': 'application/json' },
          }),
      );
      const err = (await svc
        .fetch({ topic: TOPIC, since: '1h' }, { baseUrl: OVERRIDE })
        .catch((e: unknown) => e)) as Error & { data?: Record<string, unknown> };
      expect(err.message).toBe('proxy.test:8443 returned HTTP 404 Not Found.');
      expect(err.data).toMatchObject({ reason: 'not_ntfy_endpoint', status: 404 });
    });
  });

  /**
   * #54: the captured body is server-side, but the failure record logs it, and
   * a page from something that is not ntfy can repeat the request — its path
   * holds the topic. ntfy's own envelope never names the topic, so it stays as
   * captured: the classifiers read its words.
   */
  describe('a captured body without ntfy’s envelope keeps no topic name (#54)', () => {
    const OVERRIDE = 'https://proxy.test/ntfy';
    /** An Express-style miss repeating the request line, and the body a publish sent. */
    const echo =
      (status: number, statusText: string, headers: Record<string, string> = {}) =>
      (call: CapturedCall) =>
        new Response(
          `<pre>Cannot ${call.method} ${new URL(call.url).pathname}${call.body ? ` with ${call.body}` : ''}</pre>`,
          { status, statusText, headers: { 'content-type': 'text/html', ...headers } },
        );

    it.each([
      [
        'publish',
        'tok_p54',
        (svc: NtfyService) =>
          svc.publish({ topic: 'tok_p54', message: 'x' }, { baseUrl: OVERRIDE }),
        '<pre>Cannot POST /ntfy/ with {"topic":"***","message":"x"}</pre>',
      ],
      [
        'manage',
        'tok_m54',
        (svc: NtfyService) => svc.manage('tok_m54', 'seq_1', 'clear', { baseUrl: OVERRIDE }),
        '<pre>Cannot PUT /ntfy/***/seq_1/clear</pre>',
      ],
      [
        'fetch of two topics',
        'tok_f54,tok_g54',
        (svc: NtfyService) =>
          svc.fetch({ topic: 'tok_f54,tok_g54', since: '1h' }, { baseUrl: OVERRIDE }),
        '<pre>Cannot GET /ntfy/***%2C***/json</pre>',
      ],
    ] as const)(
      'masks every topic name a %s page repeats, and changes nothing else about the error',
      async (_label, topic, call, masked) => {
        const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
        captureFetch(echo(404, 'Not Found'));
        const err = (await call(svc).catch((e: unknown) => e)) as Error & {
          code?: unknown;
          data?: Record<string, unknown>;
        };
        expect(err.data?.body).toBe(masked);
        expect(err.data?.responseBody).toBe(masked);
        expect(getErrorCode(err)).toBe(JsonRpcErrorCode.NotFound);
        expect(err.message).toBe('proxy.test returned HTTP 404 Not Found.');
        expect(err.data).toMatchObject({
          reason: 'not_ntfy_endpoint',
          retryable: false,
          status: 404,
          topic,
        });
      },
    );

    it('masks a topic name in a 5xx page the handlers rethrow as the cause of `upstream_unreachable`', async () => {
      const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
      captureFetch(echo(503, 'Service Unavailable', { 'retry-after': '120' }));
      const err = (await svc
        .fetch({ topic: 'tok_r54', since: '1h' }, { baseUrl: OVERRIDE })
        .catch((e: unknown) => e)) as Error & { data?: Record<string, unknown> };
      expect(isUpstreamUnreachable(err)).toBe(true);
      expect(err.data?.body).toBe('<pre>Cannot GET /ntfy/***/json</pre>');
      expect(err.data?.topic).toBe('tok_r54');
    });

    it("leaves ntfy's own envelope as captured, even where its words hold the topic name", async () => {
      const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
      const envelope = '{"code":40301,"http":403,"error":"forbidden"}';
      captureFetch(
        () =>
          new Response(envelope, {
            status: 403,
            statusText: 'Forbidden',
            headers: { 'content-type': 'application/json' },
          }),
      );
      const err = (await svc
        .publish({ topic: 'forbidden', message: 'x' })
        .catch((e: unknown) => e)) as Error & { data?: Record<string, unknown> };
      expect(err.data?.body).toBe(envelope);
      expect(err.message).toBe('ntfy returned HTTP 403 Forbidden: forbidden');
    });
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

describe("NtfyService.fetch reports ntfy's clock (#51)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function pollWithDate(date: string | undefined): () => Response {
    return () =>
      new Response(JSON.stringify({ id: 'a', time: 1, event: 'message', topic: 'alerts' }), {
        status: 200,
        headers: {
          'content-type': 'application/x-ndjson',
          ...(date === undefined ? {} : { date }),
        },
      });
  }

  it("reads the poll response's `Date` header as Unix seconds", async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    // As ntfy.sh sent it on a `scheduled=1` poll.
    captureFetch(pollWithDate('Sat, 14 Nov 2026 06:08:39 GMT'));
    const result = await svc.fetch({ topic: 'alerts', since: 'all', scheduled: true });
    expect(result.ntfyClockSeconds).toBe(1_794_636_519);
  });

  it.each([
    ['missing', undefined],
    ['unparseable', 'not a date'],
    ['empty', ''],
  ])('reports no clock when the header is %s', async (_case, date) => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    captureFetch(pollWithDate(date));
    const result = await svc.fetch({ topic: 'alerts', since: 'all' });
    expect(result.ntfyClockSeconds).toBeUndefined();
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

  it.each([
    [
      "ntfy's 40401 route miss",
      '{"code":40401,"http":404,"error":"page not found"}',
      'ntfy returned HTTP 404: page not found',
    ],
    [
      'a line whose code ntfy never pairs with its status',
      '{"code":40301,"http":404,"error":"forbidden"}',
      'ntfy.test returned HTTP 404.',
    ],
  ])(
    'labels an error line that is %s as `not_ntfy_endpoint`, with the subject its envelope earns (#55)',
    async (_label, line, text) => {
      const { err } = await pollError(bodyResponder([message('a', 1), line].join('\n')));
      expect(getErrorCode(err)).toBe(JsonRpcErrorCode.NotFound);
      expect(err.message).toBe(text);
      expect(err.data).toMatchObject({ reason: 'not_ntfy_endpoint', retryable: false });
    },
  );

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
      await expect(call(svc)).resolves.toEqual({ envelope: JSON.parse(envelope({ expires: 99 })) });
    });

    it.each([
      [
        'both policies',
        {
          'ratelimit-policy': '"requests";q=60;w=300, "messages";q=250;w=86400',
          ratelimit: '"requests";r=58;t=1, "messages";r=246;t=50750',
        },
        {
          messages: { limit: 250, remaining: 246, resetsInSeconds: 50750 },
          requests: { limit: 60, remaining: 58, nextRequestInSeconds: 1 },
        },
      ],
      [
        'only the messages policy',
        { 'ratelimit-policy': '"messages";q=250;w=86400', ratelimit: '"messages";r=246;t=50750' },
        { messages: { limit: 250, remaining: 246, resetsInSeconds: 50750 } },
      ],
      // ntfy before v2.37.0, or an exempt visitor: absent, never zero.
      ['no rate-limit headers', {}, undefined],
    ])(
      'reports the quota a reply with %s carried, beside its envelope (#60)',
      async (_label, headers, quota) => {
        const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
        captureFetch(
          () =>
            new Response(envelope(), {
              status: 200,
              headers: { 'content-type': 'application/json', ...headers },
            }),
        );
        const result = await call(svc);
        expect(result.envelope).toEqual(JSON.parse(envelope()));
        expect(result.quota).toEqual(quota);
      },
    );
  });

  describe('a reply that follows a retried 429 (#60)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it.each(REPLIES)(
      '%s reports the quota of the response that succeeded, not the 429 before it',
      async (_operation, event, call) => {
        const svc = new NtfyService({
          ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
          maxRetries: 1,
        });
        const answers = [
          new Response('{"code":42901,"http":429,"error":"limit reached: too many requests"}', {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'retry-after': '2',
              'ratelimit-policy': '"requests";q=60;w=300, "messages";q=250;w=86400',
              ratelimit: '"requests";r=0;t=2, "messages";r=200;t=40000',
            },
          }),
          new Response(
            JSON.stringify({ id: 'e2', time: 2, event, topic: 'alerts', sequence_id: 'seq_1' }),
            {
              status: 200,
              headers: {
                'content-type': 'application/json',
                'ratelimit-policy': '"requests";q=60;w=300, "messages";q=250;w=86400',
                ratelimit: '"requests";r=0;t=5, "messages";r=199;t=39998',
              },
            },
          ),
        ];
        const { calls } = captureFetch(() => answers.shift() as Response);
        const { outcome } = await runOnFakeClock(call(svc));
        expect(calls).toHaveLength(2);
        expect(outcome).toEqual({
          value: {
            envelope: expect.objectContaining({ id: 'e2' }),
            quota: {
              messages: { limit: 250, remaining: 199, resetsInSeconds: 39998 },
              requests: { limit: 60, remaining: 0, nextRequestInSeconds: 5 },
            },
          },
        });
      },
    );
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
    await expect(svc.publish(PUBLISH_BODY)).resolves.toMatchObject({ envelope: { id: 'm1' } });
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
    const err = (await svc.publish(PUBLISH_BODY).catch((e: unknown) => e)) as Error;
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
    const err = (await svc
      .publish(PUBLISH_BODY, { signal: controller.signal })
      .catch((e: unknown) => e)) as Error;
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

  it.each(ROUND_TRIPS)('%s: times out a body that stalls after the headers', async (op, call) => {
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      requestTimeoutMs: 50,
    });
    captureFetch(stalledBodyResponder);
    const { elapsed, outcome } = await runOnFakeClock(call(svc));
    // Cut off by the 50 ms per-attempt timer, not left for the 50 s call deadline.
    expect(elapsed).toBe(50);
    const { error } = outcome as { error: Error & { data?: Record<string, unknown> } };
    expect(getErrorCode(error)).not.toBe(JsonRpcErrorCode.RequestCancelled);
    if (op === 'fetch') {
      expect(error.message).toMatch(/\(failed after 1 attempt\)/);
      expect(isUpstreamUnreachable(error)).toBe(true);
    } else {
      // ntfy answered 200 — see 'a 200 reply that fails mid-read' below.
      expect(error.data).toMatchObject({ reason: 'upstream_malformed', retryable: false });
      expect(isUpstreamUnreachable(error)).toBe(false);
    }
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
      expect(error.message).toBe('The ntfy request was cancelled by the caller.');
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

/** Bun's `fetch` body error on a reset connection: the transport code on the error itself. */
const BUN_RESET = () =>
  Object.assign(
    new TypeError(
      'ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
    ),
    { code: 'ECONNRESET' },
  );
/** Node's (undici) body error on a reset connection: a bare `terminated`, the reason on `cause`. */
const NODE_RESET = () =>
  new TypeError('terminated', {
    cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
  });

/**
 * A responder that models a reply cut off mid-body: `200` headers and the
 * first bytes of the message envelope, then the body stream errors with
 * `transportError` — what `fetch` does when the connection resets partway
 * through reading it.
 */
function resetBodyResponder(transportError: () => Error) {
  return (): Response =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":"m1","ti'));
          queueMicrotask(() => controller.error(transportError()));
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
}

/**
 * ntfy writes the `200` to a publish, clear, or delete only after it has
 * dispatched the message or event (#43), so a reply that fails partway through
 * being read is never resent: it fails as `upstream_malformed`, not retryable.
 * A poll is idempotent and keeps retrying the same failure.
 */
describe('NtfyService a 200 reply that fails mid-read', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const ANSWERED = [
    ['publish', (svc: NtfyService) => svc.publish(PUBLISH_BODY)],
    ['clear', (svc: NtfyService) => svc.manage('alerts', 'seq_1', 'clear')],
    ['delete', (svc: NtfyService) => svc.manage('alerts', 'seq_1', 'delete')],
  ] as const;

  function retryingService(requestTimeoutMs: number) {
    return new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      requestTimeoutMs,
      maxRetries: 3,
    });
  }

  type Failure = Error & { cause?: unknown; data?: Record<string, unknown> };

  describe.each(ANSWERED)('%s', (operation, call) => {
    it.each([
      ['Bun', BUN_RESET, 'ECONNRESET: The socket connection was closed unexpectedly'],
      ['Node', NODE_RESET, 'terminated (other side closed)'],
    ] as const)(
      'fails a reply reset mid-body (%s) as `upstream_malformed`, sent once',
      async (_runtime, transportError, cause) => {
        const { calls } = captureFetch(resetBodyResponder(transportError));
        const { outcome } = await runOnFakeClock(call(retryingService(1000)));
        expect(calls).toHaveLength(1);
        const { error } = outcome as { error: Failure };
        expect(getErrorCode(error)).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.data).toMatchObject({ reason: 'upstream_malformed', retryable: false });
        expect(error.message).toContain(
          `The ${operation} was answered with HTTP 200, but reading the reply failed: ${cause}`,
        );
        expect(error.message).not.toMatch(/failed after/);
        // Bun's `pass verbose: true to fetch()` advice is nothing the caller can act on.
        expect(error.message).not.toContain('verbose');
        expect(error.message).toMatch(/\.$/);
        expect(error.cause).toBeInstanceOf(TypeError);
        expect(isUpstreamUnreachable(error)).toBe(false);
      },
    );

    it('names the 2xx status a reply that is not an ntfy message actually came with', async () => {
      const { calls } = captureFetch(() => new Response(null, { status: 204 }));
      const { outcome } = await runOnFakeClock(call(retryingService(1000)));
      expect(calls).toHaveLength(1);
      const { error } = outcome as { error: Failure };
      expect(error.data).toMatchObject({ reason: 'upstream_malformed', retryable: false });
      expect(error.message).toBe(
        `The ${operation} was answered with HTTP 204, but the reply is empty.`,
      );
    });

    it('fails a reply that stalls past the per-attempt timeout as `upstream_malformed`, sent once', async () => {
      const { calls } = captureFetch(stalledBodyResponder);
      const { elapsed, outcome } = await runOnFakeClock(call(retryingService(50)));
      expect(elapsed).toBe(50);
      expect(calls).toHaveLength(1);
      const { error } = outcome as { error: Failure };
      expect(error.data).toMatchObject({ reason: 'upstream_malformed', retryable: false });
      expect(error.message).toBe(
        `The ${operation} was answered with HTTP 200, but reading the reply failed: it did not finish within the 50 ms request timeout (NTFY_REQUEST_TIMEOUT_MS).`,
      );
    });

    it('reports a reply the call deadline cuts off as `upstream_malformed`, sent once', async () => {
      // A per-attempt timeout past the 50 s call deadline, so the deadline is the clock that fires.
      const { calls } = captureFetch(stalledBodyResponder);
      const { elapsed, outcome } = await runOnFakeClock(call(retryingService(60_000)));
      expect(elapsed).toBe(CALL_DEADLINE_MS);
      expect(calls).toHaveLength(1);
      const { error } = outcome as { error: Failure };
      expect(getErrorCode(error)).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({
        reason: 'upstream_malformed',
        retryable: false,
        retryAttempts: 1,
        deadlineMs: CALL_DEADLINE_MS,
      });
      expect(error.message).toBe(
        `The ${operation} was answered with HTTP 200, but reading the reply failed: ntfy ${operation} exceeded its 50000ms retry deadline. (failed after 1 attempt)`,
      );
    });
  });

  it('reports a reply the deadline cuts off after earlier attempts got no answer', async () => {
    // Three 15 s attempts that never see headers, then a 200 whose body stalls into the deadline.
    let attempt = 0;
    const { calls } = captureFetch((captured) => {
      attempt += 1;
      return attempt < 4 ? abortAwareResponder(captured) : stalledBodyResponder(captured);
    });
    const { elapsed, outcome } = await runOnFakeClock(
      retryingService(15_000).publish(PUBLISH_BODY),
    );
    expect(elapsed).toBe(CALL_DEADLINE_MS);
    expect(calls).toHaveLength(4);
    const { error } = outcome as { error: Failure };
    expect(error.data).toMatchObject({ reason: 'upstream_malformed', retryable: false });
    expect(error.message).toMatch(/^The publish was answered with HTTP 200, but reading the reply/);
    expect(error.message).toMatch(/\(failed after 4 attempts\)$/);
  });

  it('keeps a headers-less timeout on a publish retried, as unreachable', async () => {
    // Non-goal of #43: before any status line, ntfy may never have taken the request.
    const { calls } = captureFetch(abortAwareResponder);
    const { outcome } = await runOnFakeClock(retryingService(50).publish(PUBLISH_BODY));
    expect(calls).toHaveLength(4);
    const { error } = outcome as { error: Failure };
    expect(error.message).toMatch(/^Timeout \(failed after 4 attempts\)$/);
    expect(isUpstreamUnreachable(error)).toBe(true);
  });

  it.each([
    ['reset mid-body', resetBodyResponder(NODE_RESET)],
    ['stalled past the per-attempt timeout', stalledBodyResponder],
  ] as const)('keeps retrying a poll whose body is %s', async (_label, responder) => {
    const { calls } = captureFetch(responder);
    const { outcome } = await runOnFakeClock(retryingService(50).fetch({ topic: 'alerts' }));
    expect(calls).toHaveLength(4);
    const { error } = outcome as { error: Failure };
    expect(error.message).toMatch(/\(failed after 4 attempts\)$/);
    expect(error.data?.reason).toBeUndefined();
    expect(isUpstreamUnreachable(error)).toBe(true);
  });
});

/**
 * ntfy stores the body of a publish carrying `filename` and no `attach` as a
 * file, and from v2.20.0 fails that write for every JSON publish with its own
 * 500 `50001` (#46). That answer is final: sent once, labelled
 * `invalid_attachment`. Every other 500 keeps the retry ladder.
 */
describe('NtfyService a publish ntfy stores as a file (#46)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const retrying = () =>
    new NtfyService({ ...makeConfig([{ baseUrl: 'https://ntfy.test' }]), maxRetries: 3 });

  /** ntfy.sh's answer to a JSON publish carrying `filename` without `attach`. */
  const INTERNAL_ERROR = '{"code":50001,"http":500,"error":"internal server error"}';
  const answer = (status: number, body: string, contentType: string) => () =>
    new Response(body, { status, headers: { 'content-type': contentType } });
  const fileWriteFailure = answer(500, INTERNAL_ERROR, 'application/json');

  type Failure = Error & { data?: Record<string, unknown> };

  it("fails ntfy's 500 `50001` to a `filename` publish without `attach` as `invalid_attachment`, sent once", async () => {
    const { calls } = captureFetch(fileWriteFailure);
    const { outcome } = await runOnFakeClock(
      retrying().publish({ topic: 'alerts', message: 'probe', filename: 'probe.txt' }),
    );
    expect(calls).toHaveLength(1);
    const { error } = outcome as { error: Failure };
    expect(getErrorCode(error)).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      status: 500,
      reason: 'invalid_attachment',
      retryable: false,
    });
    expect(error.message).toContain('HTTP 500');
    expect(error.message).toContain(': internal server error');
    expect(error.message).not.toMatch(/failed after/);
    expect(isUpstreamUnreachable(error)).toBe(false);
  });

  it.each([
    ['a 500 with no ntfy envelope', { filename: 'probe.txt' }, answer(500, 'boom', 'text/plain')],
    ["ntfy's 500 `50001` to a publish with no `filename`", {}, fileWriteFailure],
    [
      "ntfy's 500 `50001` to a `filename` publish that carries `attach`",
      { filename: 'probe.txt', attach: 'https://example.com/probe.txt' },
      fileWriteFailure,
    ],
    [
      'a `50001` envelope on a 502',
      { filename: 'probe.txt' },
      answer(502, INTERNAL_ERROR, 'application/json'),
    ],
  ] as const)('keeps retrying %s, ending unreachable', async (_label, extra, responder) => {
    const { calls } = captureFetch(responder);
    const { outcome } = await runOnFakeClock(
      retrying().publish({ topic: 'alerts', message: 'probe', ...extra }),
    );
    expect(calls).toHaveLength(4);
    const { error } = outcome as { error: Failure };
    expect(error.message).toMatch(/\(failed after 4 attempts\)$/);
    expect(error.data?.reason).toBeUndefined();
    expect(error.data?.retryable).toBeUndefined();
    expect(isUpstreamUnreachable(error)).toBe(true);
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

  it.each([
    ['delta-seconds over the 30 s single-wait cap', () => '40'],
    ['delta-seconds one second over the cap', () => '31'],
    ['an HTTP-date 120 s out', () => new Date(Date.now() + 120_000).toUTCString()],
  ])(
    'fails a first attempt fast on a Retry-After (%s), unmarked but unreachable',
    async (_label, retryAfter) => {
      const svc = new NtfyService({
        ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
        requestTimeoutMs: 15_000,
        maxRetries: 3,
      });
      const header = retryAfter();
      const { calls } = captureFetch(unavailable(header));
      const { elapsed, outcome } = await runOnFakeClock(svc.fetch({ topic: 'alerts' }));
      expect(elapsed).toBe(0);
      expect(calls).toHaveLength(1);
      const { error } = outcome as { error: Error & { data?: Record<string, unknown> } };
      // Nothing was retried, so nothing claims it was.
      expect(error.message).not.toMatch(/failed after/);
      expect(error.data).not.toHaveProperty('retryAttempts');
      expect(error.data?.retryAfter).toBe(header);
      expect(isUpstreamUnreachable(error)).toBe(true);
    },
  );

  it('fails a first answer whose Retry-After outlasts what is left of the deadline, unmarked but unreachable', async () => {
    const svc = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      requestTimeoutMs: 30_000,
      maxRetries: 3,
    });
    // Answered at 25 s with a 30 s wait: under the cap, over the 25 s of budget left.
    const { calls } = captureFetch(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(unavailable('30')()), 25_000);
        }),
    );
    const { elapsed, outcome } = await runOnFakeClock(svc.fetch({ topic: 'alerts' }));
    expect(elapsed).toBe(25_000);
    expect(calls).toHaveLength(1);
    const { error } = outcome as { error: Error & { data?: Record<string, unknown> } };
    expect(error.message).not.toMatch(/failed after/);
    expect(error.data?.retryAfter).toBe('30');
    expect(isUpstreamUnreachable(error)).toBe(true);
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
    const err = (await svc.publish(PUBLISH_BODY).catch((e: unknown) => e)) as Error;
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
    const err = (await svc.publish(PUBLISH_BODY).catch((e: unknown) => e)) as Error;
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

const NDJSON = { 'content-type': 'application/x-ndjson; charset=utf-8' };

/**
 * An ntfy JSON stream the test writes to as the wait reads it: `write()` sends
 * raw text as one read, `writeBytes()` raw bytes as one read, `send()` whole
 * lines, `close()` ends the stream as a dropped connection would, and `fail()`
 * errors it as a reset would. Once the request signal aborts, the body errors
 * with its reason — what Bun's and Node's `fetch` both do to a body still being
 * read — and `aborted` records it. `highWaterMark: 0`, so nothing is pulled
 * ahead of the reader.
 */
interface FakeStream {
  aborted: boolean;
  close: () => void;
  fail: (err: Error) => void;
  send: (...lines: string[]) => void;
  write: (text: string) => void;
  writeBytes: (bytes: Uint8Array) => void;
}

function fakeStream(signal: AbortSignal | undefined): { response: Response; stream: FakeStream } {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream: FakeStream = {
    aborted: false,
    writeBytes: (bytes) => controller.enqueue(bytes),
    write: (text) => stream.writeBytes(encoder.encode(text)),
    send: (...lines) => stream.write(lines.map((l) => `${l}\n`).join('')),
    close: () => controller.close(),
    fail: (err) => controller.error(err),
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
        signal?.addEventListener(
          'abort',
          () => {
            stream.aborted = true;
            c.error(signal.reason);
          },
          { once: true },
        );
      },
    },
    { highWaterMark: 0 },
  );
  return { response: new Response(body, { status: 200, headers: NDJSON }), stream };
}

/**
 * Answers a poll of `ntfy.test` with an empty window, and every other request —
 * the wait's stream — with a fresh {@link fakeStream}, collected in `streams`.
 */
function streamUpstream() {
  const streams: FakeStream[] = [];
  const captured = captureFetch((call) => {
    if (new URL(call.url).searchParams.has('poll')) {
      return new Response('', { status: 200, headers: NDJSON });
    }
    const { response, stream } = fakeStream(call.signal);
    streams.push(stream);
    return response;
  });
  return { ...captured, streams };
}

/** Records when, in fake ms, `promise` settled and with what, without awaiting it. */
function track<T>(promise: Promise<T>) {
  const startedAt = Date.now();
  const state: { error?: unknown; settledAfterMs?: number; value?: T } = {};
  promise.then(
    (value) => {
      state.settledAfterMs = Date.now() - startedAt;
      state.value = value;
    },
    (error: unknown) => {
      state.settledAfterMs = Date.now() - startedAt;
      state.error = error;
    },
  );
  return state;
}

const WAIT_PARAMS = { topic: 'alerts,backups', since: '10m' };
/** ntfy's `open` line for a stream of `alerts,backups`, at ntfy's Unix second `time`. */
const openLine = (time: number) =>
  JSON.stringify({ id: 'opn0000000ab', time, event: 'open', topic: 'alerts,backups' });
const rowLine = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id,
    time: 1_794_000_010,
    event: 'message',
    topic: 'alerts',
    message: `body ${id}`,
    ...extra,
  });
/** A message line of exactly `length` characters, its `message` padded with `x`. */
const rowLineOf = (length: number) =>
  rowLine('m1', { message: 'x'.repeat(length - rowLine('m1', { message: '' }).length) });

/** Write `text` to `stream` in reads of 64 KiB, so a long line is assembled from many reads. */
function writeInReads(stream: FakeStream, text: string) {
  for (let at = 0; at < text.length; at += 65_536) stream.write(text.slice(at, at + 65_536));
}

describe('NtfyService.waitForMessage (#61)', () => {
  const svc = () =>
    new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      requestTimeoutMs: 15_000,
    });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    // Every path ends with its timers cleared and its wait slot given back.
    expect(vi.getTimerCount()).toBe(0);
    expect(openWaitCount()).toBe(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens the stream with the poll's own query, minus `poll`", async () => {
    const service = svc();
    const { calls, streams } = streamUpstream();
    const params = {
      topic: 'alerts,backups',
      since: 'AbCdEf123456',
      scheduled: true,
      priority: [4, 5] as Array<4 | 5>,
      tags: ['a', 'b'],
      title: 'Hit',
      message: 'exact body',
    };
    await service.fetch(params);
    const waited = service.waitForMessage(params, { holdMs: 5_000 });
    await vi.advanceTimersByTimeAsync(0);
    streams[0]?.send(openLine(1_794_000_000), rowLine('m1'));
    await waited;

    expect(calls).toHaveLength(2);
    const poll = new URL(calls[0]!.url);
    const stream = new URL(calls[1]!.url);
    expect(stream.searchParams.has('poll')).toBe(false);
    poll.searchParams.delete('poll');
    expect(stream.href).toBe(poll.href);
    expect(stream.pathname).toBe('/alerts%2Cbackups/json');
    expect(Object.fromEntries(stream.searchParams)).toEqual({
      since: 'AbCdEf123456',
      scheduled: '1',
      priority: '4,5',
      tags: 'a,b',
      title: 'Hit',
      message: 'exact body',
    });
    expect(calls[1]?.method).toBe('GET');
  });

  /**
   * The stream goes where the poll before it went, and as the poll went: to the
   * call's `baseUrl`, with the credentials registered for that base (none for an
   * unregistered one), refusing redirects on an override the private-host guard
   * checked.
   */
  describe('opens the stream where the poll went, as the poll went', () => {
    /** Poll, then wait, on `service` with `baseUrl`; returns the two requests. */
    async function pollThenWait(service: NtfyService, baseUrl?: string) {
      const { calls, streams } = streamUpstream();
      const opts = baseUrl === undefined ? {} : { baseUrl };
      await service.fetch(WAIT_PARAMS, opts);
      const waited = service.waitForMessage(WAIT_PARAMS, { ...opts, holdMs: 5_000 });
      await vi.advanceTimersByTimeAsync(0);
      streams[0]?.send(openLine(1_794_000_000), rowLine('m1'));
      await expect(waited).resolves.toMatchObject({ outcome: 'arrived', message: { id: 'm1' } });
      expect(calls).toHaveLength(2);
      return { poll: calls[0]!, stream: calls[1]! };
    }

    it('to the `baseUrl` override, not the default server', async () => {
      const { poll, stream } = await pollThenWait(svc(), 'https://other.example.com/ntfy/');
      for (const call of [poll, stream]) {
        const url = new URL(call.url);
        expect(url.origin).toBe('https://other.example.com');
        expect(url.pathname).toBe('/ntfy/alerts%2Cbackups/json');
      }
    });

    it.each([
      [
        "the default server's credentials to the default server",
        undefined,
        'https://ntfy.test',
        'Bearer tk_default',
      ],
      [
        "a registered override's own credentials to that override",
        'https://corp.example.com',
        'https://corp.example.com',
        `Basic ${Buffer.from('user:pass', 'utf-8').toString('base64')}`,
      ],
      [
        'no credentials to an unregistered override',
        'https://stranger.example.com',
        'https://stranger.example.com',
        undefined,
      ],
    ])('sends %s', async (_case, baseUrl, origin, auth) => {
      const service = new NtfyService({
        ...makeConfig([
          { baseUrl: 'https://ntfy.test', authToken: 'tk_default' },
          { baseUrl: 'https://corp.example.com', authUsername: 'user', authPassword: 'pass' },
        ]),
        requestTimeoutMs: 15_000,
      });
      const { poll, stream } = await pollThenWait(service, baseUrl);
      expect(new URL(stream.url).origin).toBe(origin);
      expect(stream.auth).toBe(auth);
      expect(poll.auth).toBe(auth);
    });

    const guarded = () =>
      new NtfyService({
        ...makeConfig([{ baseUrl: 'https://ntfy.test' }], true),
        requestTimeoutMs: 15_000,
      });

    it('refuses redirects on an override the private-host guard checked', async () => {
      // A public address, for the poll's lookup and then the wait's.
      const answer = [{ address: '93.184.215.14', family: 4 }] as never;
      vi.mocked(lookup).mockResolvedValueOnce(answer).mockResolvedValueOnce(answer);
      const { poll, stream } = await pollThenWait(guarded(), 'https://public.example.org');
      expect(new URL(stream.url).origin).toBe('https://public.example.org');
      expect(stream.redirect).toBe('error');
      expect(poll.redirect).toBe('error');
    });

    it('leaves redirects to `fetch` on the default server, which the guard never checks', async () => {
      const { poll, stream } = await pollThenWait(guarded());
      expect(stream.redirect).toBeUndefined();
      expect(poll.redirect).toBeUndefined();
    });
  });

  it('returns the first row after `open` and `keepalive`, then aborts the request', async () => {
    const { calls, streams } = streamUpstream();
    const waited = track(svc().waitForMessage(WAIT_PARAMS, { holdMs: 30_000 }));
    await vi.advanceTimersByTimeAsync(0);
    streams[0]?.send(
      openLine(1_794_000_000),
      JSON.stringify({
        id: 'kpa0000000ab',
        time: 1_794_000_001,
        event: 'keepalive',
        topic: 'alerts',
      }),
    );
    await vi.advanceTimersByTimeAsync(2_500);
    expect(waited.settledAfterMs).toBeUndefined();
    streams[0]?.send(rowLine('m1'));
    await vi.advanceTimersByTimeAsync(0);

    expect(waited.value).toEqual({
      outcome: 'arrived',
      message: JSON.parse(rowLine('m1')),
      // The `open` second plus one, plus the 2.5 s since that line arrived.
      ntfyClockSeconds: 1_794_000_003.5,
      waitedMs: 2_500,
    });
    expect(streams[0]?.aborted).toBe(true);
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it("falls back to this server's clock for a row that arrives with no `open` line before it", async () => {
    vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
    const { streams } = streamUpstream();
    const waited = svc().waitForMessage(WAIT_PARAMS, { holdMs: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    streams[0]?.send(rowLine('m1'));
    await expect(waited).resolves.toMatchObject({
      outcome: 'arrived',
      ntfyClockSeconds: Date.parse('2026-11-17T12:00:00Z') / 1000,
    });
  });

  it('ends at the first row: a message ntfy delivers twice (replay, then re-delivery) comes back once', async () => {
    const { streams } = streamUpstream();
    const waited = svc().waitForMessage(WAIT_PARAMS, { holdMs: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    streams[0]?.send(openLine(1_794_000_000), rowLine('m1'), rowLine('m1'), rowLine('m2'));
    await expect(waited).resolves.toMatchObject({
      outcome: 'arrived',
      message: { id: 'm1' },
    });
    expect(streams[0]?.aborted).toBe(true);
  });

  it.each(['message_clear', 'message_delete'])(
    'ends on a `%s` event like any row',
    async (event) => {
      const { streams } = streamUpstream();
      const waited = svc().waitForMessage(WAIT_PARAMS, { holdMs: 30_000 });
      await vi.advanceTimersByTimeAsync(0);
      const line = JSON.stringify({
        id: 'clr0000000ab',
        time: 1_794_000_010,
        event,
        topic: 'alerts',
        sequence_id: 'backup-42',
      });
      streams[0]?.send(openLine(1_794_000_000), line);
      await expect(waited).resolves.toMatchObject({
        outcome: 'arrived',
        message: { event, sequence_id: 'backup-42' },
      });
    },
  );

  it('reads a line that arrives in pieces, and CRLF line ends', async () => {
    const { streams } = streamUpstream();
    const waited = svc().waitForMessage(WAIT_PARAMS, { holdMs: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    const line = rowLine('m1');
    streams[0]?.write(`${openLine(1_794_000_000)}\r\n${line.slice(0, 7)}`);
    await vi.advanceTimersByTimeAsync(0);
    streams[0]?.write(line.slice(7, 20));
    await vi.advanceTimersByTimeAsync(0);
    streams[0]?.write(`${line.slice(20)}\r\n`);
    await expect(waited).resolves.toMatchObject({ outcome: 'arrived', message: { id: 'm1' } });
  });

  it('reads a character whose UTF-8 bytes arrive in two reads', async () => {
    const { streams } = streamUpstream();
    const waited = svc().waitForMessage(WAIT_PARAMS, { holdMs: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    const bytes = new TextEncoder().encode(
      `${openLine(1_794_000_000)}\n${rowLine('m1', { message: 'café' })}\n`,
    );
    // `é` is the two bytes C3 A9: the first read ends between them.
    const split = bytes.lastIndexOf(0xc3) + 1;
    streams[0]?.writeBytes(bytes.subarray(0, split));
    await vi.advanceTimersByTimeAsync(0);
    streams[0]?.writeBytes(bytes.subarray(split));
    await expect(waited).resolves.toMatchObject({
      outcome: 'arrived',
      message: { id: 'm1', message: 'café' },
    });
  });

  it.each([
    // The open line shifts the long one across the reads, so its last read carries its break.
    ['in the read that ends it', (line: string) => [`${openLine(1_794_000_000)}\n${line}\n`]],
    // The long line fills whole reads, so all of it is held before the break comes.
    ['in a read of its own', (line: string) => [line, '\n']],
  ])(
    'reads a line of exactly 1048576 characters, the most it holds, its break %s',
    async (_layout, layout) => {
      const { streams } = streamUpstream();
      const waited = svc().waitForMessage(WAIT_PARAMS, { holdMs: 30_000 });
      await vi.advanceTimersByTimeAsync(0);
      const line = rowLineOf(1_048_576);
      for (const text of layout(line)) writeInReads(streams[0]!, text);
      await expect(waited).resolves.toMatchObject({
        outcome: 'arrived',
        message: JSON.parse(line),
      });
    },
  );

  it('times out when the hold passes, and aborts the request', async () => {
    const { calls, streams } = streamUpstream();
    const waited = track(svc().waitForMessage(WAIT_PARAMS, { holdMs: 5_000 }));
    await vi.advanceTimersByTimeAsync(0);
    streams[0]?.send(openLine(1_794_000_000));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(waited.settledAfterMs).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(waited).toEqual({
      settledAfterMs: 5_000,
      value: { outcome: 'timedOut', waitedMs: 5_000 },
    });
    expect(streams[0]?.aborted).toBe(true);
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it('times out at a hold shorter than the request timeout, even with no `open` line yet', async () => {
    const { streams } = streamUpstream();
    const waited = track(svc().waitForMessage(WAIT_PARAMS, { holdMs: 3_000 }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(waited.value).toEqual({ outcome: 'timedOut', waitedMs: 3_000 });
    expect(streams[0]?.aborted).toBe(true);
  });

  /**
   * ntfy re-sends a message it has just written to every stream that subscribed
   * after the message went out, applying the stream's filters but not its
   * `since`, so a stream can deliver a row the poll before it could not return.
   */
  describe('skips a row from before `windowStart` and goes on waiting', () => {
    it.each([
      ['a 12-character message ID', 'AbCdEf123456'],
      // The later row is timed far below the digits' value: an ID is never compared as a time.
      ['a 12-digit message ID', '123456789012'],
    ])('the marker message itself, under %s', async (_label, marker) => {
      const { streams } = streamUpstream();
      const waited = track(
        svc().waitForMessage(
          { ...WAIT_PARAMS, since: marker },
          { holdMs: 30_000, windowStart: { kind: 'id', id: marker } },
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      streams[0]?.send(openLine(1_794_000_000), rowLine(marker));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(waited.settledAfterMs).toBeUndefined();
      // Sparse, as ntfy writes a message with no optional field set.
      const later = { id: 'm2', time: 1_794_000_001, event: 'message', topic: 'alerts' };
      streams[0]?.send(JSON.stringify(later));
      await vi.advanceTimersByTimeAsync(0);

      expect(waited.value).toEqual({
        outcome: 'arrived',
        message: later,
        ntfyClockSeconds: 1_794_000_002,
        waitedMs: 1_000,
      });
      expect(streams[0]?.aborted).toBe(true);
    });

    it('a row timed before a Unix-seconds start; a row timed at that second arrives', async () => {
      const start = 1_794_000_010;
      const { streams } = streamUpstream();
      const waited = track(
        svc().waitForMessage(
          { ...WAIT_PARAMS, since: String(start) },
          { holdMs: 30_000, windowStart: { kind: 'time', seconds: start } },
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      streams[0]?.send(openLine(start + 1), rowLine('old', { time: start - 1 }));
      await vi.advanceTimersByTimeAsync(500);
      expect(waited.settledAfterMs).toBeUndefined();
      streams[0]?.send(rowLine('m2', { time: start }));
      await vi.advanceTimersByTimeAsync(0);

      expect(waited.value).toMatchObject({
        outcome: 'arrived',
        message: { id: 'm2', time: start },
        waitedMs: 500,
      });
    });

    it('times out at the hold when the marker is all that arrives, and aborts the request', async () => {
      const { calls, streams } = streamUpstream();
      const waited = track(
        svc().waitForMessage(
          { ...WAIT_PARAMS, since: 'AbCdEf123456' },
          { holdMs: 4_000, windowStart: { kind: 'id', id: 'AbCdEf123456' } },
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      streams[0]?.send(openLine(1_794_000_000), rowLine('AbCdEf123456'));
      await vi.advanceTimersByTimeAsync(3_999);
      expect(waited.settledAfterMs).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);

      expect(waited).toEqual({
        settledAfterMs: 4_000,
        value: { outcome: 'timedOut', waitedMs: 4_000 },
      });
      expect(streams[0]?.aborted).toBe(true);
      expect(calls[0]?.signal?.aborted).toBe(true);
    });
  });

  describe('fails, with a cause that names no topic, when the stream never opens', () => {
    const TIMEOUT_CAUSE =
      'ntfy did not confirm the stream within the 1000 ms request timeout (NTFY_REQUEST_TIMEOUT_MS)';
    const quick = () =>
      new NtfyService({
        ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
        requestTimeoutMs: 1_000,
      });

    it('on headers with no `open` line within NTFY_REQUEST_TIMEOUT_MS', async () => {
      const { streams } = streamUpstream();
      const waited = track(quick().waitForMessage(WAIT_PARAMS, { holdMs: 30_000 }));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(waited).toEqual({
        settledAfterMs: 1_000,
        value: { outcome: 'failed', cause: TIMEOUT_CAUSE, waitedMs: 0 },
      });
      expect(streams[0]?.aborted).toBe(true);
    });

    it('on no headers within NTFY_REQUEST_TIMEOUT_MS', async () => {
      const { calls } = captureFetch(abortAwareResponder);
      const waited = track(quick().waitForMessage(WAIT_PARAMS, { holdMs: 30_000 }));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(waited).toEqual({
        settledAfterMs: 1_000,
        value: { outcome: 'failed', cause: TIMEOUT_CAUSE, waitedMs: 0 },
      });
      expect(calls[0]?.signal?.aborted).toBe(true);
    });

    it('on a guarded `baseUrl` lookup that does not answer within NTFY_REQUEST_TIMEOUT_MS, before any request', async () => {
      vi.mocked(lookup).mockImplementationOnce(() => new Promise(() => {}) as never);
      const { calls } = captureFetch();
      const guarded = new NtfyService({
        ...makeConfig([{ baseUrl: 'https://ntfy.test' }], true),
        requestTimeoutMs: 1_000,
      });
      const waited = track(
        guarded.waitForMessage(WAIT_PARAMS, {
          holdMs: 30_000,
          baseUrl: 'https://slow-dns.example',
        }),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(waited).toEqual({
        settledAfterMs: 1_000,
        value: { outcome: 'failed', cause: TIMEOUT_CAUSE, waitedMs: 0 },
      });
      expect(calls).toHaveLength(0);
    });

    it.each([
      [
        "ntfy's subscription limit (42903)",
        429,
        '{"code":42903,"http":429,"error":"limit reached: too many active subscriptions","link":"https://ntfy.sh/docs/publish/#limitations"}',
        'application/json',
        'ntfy returned HTTP 429: limit reached: too many active subscriptions (see https://ntfy.sh/docs/publish/#limitations)',
      ],
      [
        "ntfy's auth refusal",
        403,
        '{"code":40301,"http":403,"error":"forbidden"}',
        'application/json',
        'ntfy returned HTTP 403: forbidden',
      ],
      [
        'a proxy page that repeats the request path',
        404,
        '<html><body>No route for /alerts,backups/json</body></html>',
        'text/html',
        'ntfy.test returned HTTP 404',
      ],
    ])('on %s, after one request', async (_case, status, body, type, cause) => {
      const { calls } = captureFetch(
        () => new Response(body, { status, headers: { 'content-type': type } }),
      );
      const waited = await svc().waitForMessage(WAIT_PARAMS, { holdMs: 30_000 });
      expect(waited).toEqual({ outcome: 'failed', cause, waitedMs: 0 });
      expect(calls).toHaveLength(1);
    });

    it('on a connection that fails before any answer', async () => {
      captureFetch(() => {
        throw new TypeError('fetch failed', {
          cause: new Error('connect ECONNREFUSED 127.0.0.1:443'),
        });
      });
      await expect(svc().waitForMessage(WAIT_PARAMS, { holdMs: 30_000 })).resolves.toEqual({
        outcome: 'failed',
        cause: 'fetch failed (connect ECONNREFUSED 127.0.0.1:443)',
        waitedMs: 0,
      });
    });
  });

  describe('fails, naming the cause and the time waited, when the stream breaks after it opened', () => {
    /** Open a wait, let ntfy confirm it, and wait 2 s before `breakIt` runs. */
    async function brokenAfterTwoSeconds(breakIt: (stream: FakeStream) => void) {
      const { streams } = streamUpstream();
      const waited = track(svc().waitForMessage(WAIT_PARAMS, { holdMs: 30_000 }));
      await vi.advanceTimersByTimeAsync(0);
      streams[0]?.send(openLine(1_794_000_000));
      await vi.advanceTimersByTimeAsync(2_000);
      breakIt(streams[0]!);
      await vi.advanceTimersByTimeAsync(0);
      return { waited, stream: streams[0]! };
    }

    it('on ntfy closing the stream', async () => {
      const { waited } = await brokenAfterTwoSeconds((s) => s.close());
      expect(waited.value).toEqual({
        outcome: 'failed',
        cause: 'the stream closed before any message arrived',
        waitedMs: 2_000,
      });
    });

    it.each([
      ['Bun', BUN_RESET, 'ECONNRESET: The socket connection was closed unexpectedly'],
      ['Node', NODE_RESET, 'terminated (other side closed)'],
    ])('on a reset connection, as %s reports it', async (_runtime, reset, cause) => {
      const { waited } = await brokenAfterTwoSeconds((s) => s.fail(reset()));
      expect(waited.value).toEqual({ outcome: 'failed', cause, waitedMs: 2_000 });
    });

    it.each([
      ['a line that is not JSON', '<html>', 'line 2 is not valid JSON'],
      [
        'JSON that is not an ntfy message',
        '{"hello":"world"}',
        'line 2 is not an ntfy message (string `id`, `event`, and `topic`, numeric `time`)',
      ],
    ])('on %s, without reading on', async (_case, line, problem) => {
      const { waited, stream } = await brokenAfterTwoSeconds((s) => s.send(line, rowLine('m1')));
      expect(waited.value).toEqual({
        outcome: 'failed',
        cause: `the stream is not ntfy's JSON message stream (content-type application/x-ndjson; charset=utf-8): ${problem}`,
        waitedMs: 2_000,
      });
      expect(stream.aborted).toBe(true);
    });

    it("on ntfy's error line, with ntfy's own text", async () => {
      const { waited } = await brokenAfterTwoSeconds((s) =>
        s.send('{"code":42905,"http":429,"error":"limit reached: daily bandwidth reached"}'),
      );
      expect(waited.value).toEqual({
        outcome: 'failed',
        cause: 'ntfy returned HTTP 429: limit reached: daily bandwidth reached',
        waitedMs: 2_000,
      });
    });

    /**
     * A per-call `base_url` can point the wait at any host, and a line in
     * progress is held until its break arrives: past the bound the read ends,
     * where ntfy's own lines run to a few kilobytes.
     */
    it.each([
      ['more than 1048576 characters with no line break', 'x'.repeat(1_048_577)],
      [
        'a message line that passes 1048576 characters before its break arrives',
        `${rowLineOf(1_048_577)}\n`,
      ],
    ])('on %s, without reading on', async (_case, text) => {
      const { waited, stream } = await brokenAfterTwoSeconds((s) => writeInReads(s, text));
      expect(waited.value).toEqual({
        outcome: 'failed',
        cause:
          "the stream is not ntfy's JSON message stream (content-type application/x-ndjson; charset=utf-8): line 2 is longer than 1048576 characters",
        waitedMs: 2_000,
      });
      expect(stream.aborted).toBe(true);
      expect(openWaitCount()).toBe(0);
    });
  });

  describe("the caller's cancellation", () => {
    it('fails as RequestCancelled with the caller’s abort as its cause, and aborts the stream', async () => {
      const { calls, streams } = streamUpstream();
      const caller = new AbortController();
      const reason = new Error('client went away');
      const waited = track(
        svc().waitForMessage(WAIT_PARAMS, { holdMs: 30_000, signal: caller.signal }),
      );
      await vi.advanceTimersByTimeAsync(0);
      streams[0]?.send(openLine(1_794_000_000));
      await vi.advanceTimersByTimeAsync(2_000);
      caller.abort(reason);
      await vi.advanceTimersByTimeAsync(0);

      expect(waited.settledAfterMs).toBe(2_000);
      const err = waited.error as Error & { code?: number };
      expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(err.message).toBe('The ntfy request was cancelled by the caller.');
      expect(err.cause).toBe(reason);
      expect(streams[0]?.aborted).toBe(true);
      expect(calls[0]?.signal?.reason).toBe(reason);
    });

    it('fails as RequestCancelled when it lands before ntfy answered', async () => {
      const { calls } = captureFetch(abortAwareResponder);
      const caller = new AbortController();
      const waited = track(
        svc().waitForMessage(WAIT_PARAMS, { holdMs: 30_000, signal: caller.signal }),
      );
      await vi.advanceTimersByTimeAsync(500);
      caller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(waited.settledAfterMs).toBe(500);
      expect((waited.error as { code?: number }).code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(calls[0]?.signal?.aborted).toBe(true);
    });
  });

  it(`holds at most ${MAX_OPEN_WAITS} waits open, and a slot a cancelled wait frees is reused`, async () => {
    const service = svc();
    const { calls, streams } = streamUpstream();
    const held = Array.from({ length: MAX_OPEN_WAITS }, () => {
      const caller = new AbortController();
      return {
        caller,
        waited: track(
          service.waitForMessage(WAIT_PARAMS, { holdMs: 30_000, signal: caller.signal }),
        ),
      };
    });
    await vi.advanceTimersByTimeAsync(0);
    for (const stream of streams) stream.send(openLine(1_794_000_000));
    expect(calls).toHaveLength(MAX_OPEN_WAITS);
    expect(openWaitCount()).toBe(MAX_OPEN_WAITS);

    // The eleventh returns at once, without asking ntfy for a stream.
    await expect(service.waitForMessage(WAIT_PARAMS, { holdMs: 30_000 })).resolves.toEqual({
      outcome: 'busy',
    });
    expect(calls).toHaveLength(MAX_OPEN_WAITS);

    const [cancelled] = held;
    cancelled?.caller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled?.waited.error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(openWaitCount()).toBe(MAX_OPEN_WAITS - 1);

    const reused = track(service.waitForMessage(WAIT_PARAMS, { holdMs: 30_000 }));
    await vi.advanceTimersByTimeAsync(0);
    streams.at(-1)?.send(openLine(1_794_000_000));
    expect(calls).toHaveLength(MAX_OPEN_WAITS + 1);
    expect(openWaitCount()).toBe(MAX_OPEN_WAITS);

    await vi.advanceTimersByTimeAsync(30_000);
    for (const { waited } of held.slice(1)) {
      expect(waited.value).toMatchObject({ outcome: 'timedOut' });
    }
    expect(reused.value).toMatchObject({ outcome: 'timedOut' });
  });
});

describe('NtfyService.waitForMessage on a caller-sized stream', () => {
  /** Per-call CPU budget at every size; a run past it already fails, so the remaining runs are skipped. */
  const CPU_LIMIT_MS = 50;
  /**
   * The size a stream arrives in, so a long line is assembled from many reads.
   * Small enough that a scanner rescanning the pending line on every read
   * grows several hundred times over the span, where a linear one grows about
   * 25×.
   */
  const CHUNK = 256;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Answers every request with `text` as a 200 stream, `CHUNK` characters per read, then closes. */
  function answerWith(text: string) {
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < text.length; i += CHUNK) {
      chunks.push(encoder.encode(text.slice(i, i + CHUNK)));
    }
    captureFetch(() => {
      let next = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            const chunk = chunks[next++];
            if (chunk) controller.enqueue(chunk);
            else controller.close();
          },
        }),
        { status: 200, headers: NDJSON },
      );
    });
  }

  /** Thread CPU milliseconds for one wait over `text`: the least of three calls. */
  async function cpuMs(text: string): Promise<number> {
    answerWith(text);
    const service = new NtfyService({
      ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
      requestTimeoutMs: 60_000,
    });
    let least = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const start = process.threadCpuUsage();
      await service.waitForMessage(WAIT_PARAMS, { holdMs: 60_000 });
      const { user, system } = process.threadCpuUsage(start);
      least = Math.min(least, (user + system) / 1000);
      if (least > CPU_LIMIT_MS) break;
    }
    return least;
  }

  /**
   * Each shape doubles from 5k to 320k characters (64×), checking the budget at
   * each size before the next and re-timing the 5k baseline beside it; the
   * assertion is on the least growth of three full-span pairs. A linear scan
   * grows about 64×, one that rescans the pending line on every read about 4096×.
   */
  it.each([
    [
      'one long line ending in a break',
      (n: number) => `${'§1 x'.repeat(n / 4)}\ny`,
      "the stream is not ntfy's JSON message stream (content-type application/x-ndjson; charset=utf-8): line 1 is not valid JSON",
    ],
    [
      'line breaks throughout',
      (n: number) => '  \r\n'.repeat(n / 4),
      'the stream closed before any message arrived',
    ],
  ])('reads %s in time linear in its length', { timeout: 0 }, async (_shape, make, cause) => {
    const small = 5_000;
    answerWith(make(small));
    await expect(
      new NtfyService({
        ...makeConfig([{ baseUrl: 'https://ntfy.test' }]),
        requestTimeoutMs: 60_000,
      }).waitForMessage(WAIT_PARAMS, { holdMs: 60_000 }),
    ).resolves.toEqual({ outcome: 'failed', cause, waitedMs: 0 });
    const pair = async (n: number) => {
      const largeMs = await cpuMs(make(n));
      expect(largeMs).toBeLessThan(CPU_LIMIT_MS);
      return largeMs / (await cpuMs(make(small)));
    };
    for (let n = small * 2; n < small * 64; n *= 2) await pair(n);
    const growth = Math.min(await pair(small * 64), await pair(small * 64), await pair(small * 64));
    expect(growth).toBeLessThan(256);
    expect(openWaitCount()).toBe(0);
  });
});
