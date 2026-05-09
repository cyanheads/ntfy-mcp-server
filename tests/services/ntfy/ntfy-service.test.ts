/**
 * @fileoverview Tests for `NtfyService` — focused on the multi-server auth
 * resolution: matching a registered base forwards that entry's auth, an
 * unregistered override goes out unauthenticated, and the default base is
 * the first registered server.
 * @module tests/services/ntfy/ntfy-service
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerConfig } from '@/config/server-config.js';
import { NtfyService } from '@/services/ntfy/ntfy-service.js';

const PUBLISH_BODY = { topic: 'alerts', message: 'hi' } as const;

function makeConfig(servers: ServerConfig['servers']): ServerConfig {
  return {
    servers,
    requestTimeoutMs: 1000,
    maxRetries: 0,
  };
}

function captureFetch() {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const mock = vi
    .spyOn(globalThis, 'fetch' as never)
    .mockImplementation(async (...args: unknown[]) => {
      const url = args[0] as string;
      const init = args[1] as RequestInit | undefined;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, auth: headers.Authorization });
      return new Response(JSON.stringify({ id: 'm1', time: 1, topic: 'alerts' }), {
        status: 200,
      }) as unknown as Response;
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
});
