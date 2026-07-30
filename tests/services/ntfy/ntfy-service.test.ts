/**
 * @fileoverview Tests for `NtfyService` — multi-server auth resolution, the
 * request-shape contract for publish/manage/fetch (URL, method, headers,
 * body), NDJSON parsing edge cases, upstream error propagation including the
 * JSON error body folded into the message, the module-level init/get/reset
 * accessors, and `base_url` override validation — the always-on absolute
 * http(s) check plus the opt-in private-host guard, its registered-base bypass,
 * and its redirect refusal.
 * @module tests/services/ntfy/ntfy-service
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerConfig } from '@/config/server-config.js';
import {
  getNtfyService,
  initNtfyService,
  NtfyService,
  resetNtfyService,
} from '@/services/ntfy/ntfy-service.js';

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
  url: string;
}

function captureFetch(
  responder: (call: CapturedCall) => Response = () =>
    new Response(JSON.stringify({ id: 'm1', time: 1, topic: 'alerts' }), { status: 200 }),
) {
  const calls: CapturedCall[] = [];
  const mock = vi
    .spyOn(globalThis, 'fetch' as never)
    .mockImplementation(async (...args: unknown[]) => {
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
      };
      calls.push(call);
      return responder(call) as unknown as Response;
    });
  return { calls, mock };
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
    const { calls } = captureFetch();
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

  it('parses NDJSON line-by-line, skipping malformed and blank lines', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    const lines = [
      JSON.stringify({ id: 'a', time: 1, event: 'open', topic: 'alerts' }),
      '',
      JSON.stringify({ id: 'b', time: 2, event: 'message', topic: 'alerts', message: 'hi' }),
      '{ this is not valid json',
      JSON.stringify({ id: 'c', time: 3, event: 'keepalive', topic: 'alerts' }),
    ].join('\n');
    captureFetch(ndjsonResponder(lines));
    const result = await svc.fetch({ topic: 'alerts' });
    expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('handles \\r\\n line separators', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    const lines = [
      JSON.stringify({ id: 'a', time: 1, event: 'message', topic: 'alerts' }),
      JSON.stringify({ id: 'b', time: 2, event: 'message', topic: 'alerts' }),
    ].join('\r\n');
    captureFetch(ndjsonResponder(lines));
    const result = await svc.fetch({ topic: 'alerts' });
    expect(result).toHaveLength(2);
  });

  it('returns an empty array for an empty body', async () => {
    const svc = new NtfyService(makeConfig([{ baseUrl: 'https://ntfy.test' }]));
    captureFetch(ndjsonResponder(''));
    const result = await svc.fetch({ topic: 'alerts' });
    expect(result).toEqual([]);
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
