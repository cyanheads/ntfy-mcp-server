/**
 * @fileoverview Tests for the `base_url` guard — the always-on absolute
 * `http(s)` check, the advertised pattern (including its empty-string branch
 * for form clients), reserved-range classification across IPv4 / IPv6 /
 * IPv4-mapped forms, and the opt-in host resolution check including its
 * DNS-failure translation.
 * @module tests/services/ntfy/base-url-guard
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertAbsoluteHttpUrl,
  assertPublicHost,
  BASE_URL_PATTERN,
  isReservedAddress,
} from '@/services/ntfy/base-url-guard.js';

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});
const { lookup } = await import('node:dns/promises');

/**
 * `lookup`'s declared return type is the single-address overload; the guard
 * calls it with `{ all: true }`, so the mock resolves the array form.
 */
const resolvesTo = (addresses: Array<{ address: string; family: number }>) =>
  vi
    .mocked(lookup)
    .mockResolvedValueOnce(addresses as unknown as { address: string; family: number });

describe('BASE_URL_PATTERN', () => {
  it.each(['https://ntfy.sh', 'http://ntfy.example.com:8080', 'https://ntfy.sh/', ''])(
    'accepts %j',
    (value) => {
      expect(BASE_URL_PATTERN.test(value)).toBe(true);
    },
  );

  it.each(['ntfy.sh', '/alerts', 'ftp://ntfy.sh', 'file:///etc/passwd', 'https://ntfy sh'])(
    'rejects %j',
    (value) => {
      expect(BASE_URL_PATTERN.test(value)).toBe(false);
    },
  );
});

describe('assertAbsoluteHttpUrl', () => {
  it('returns the parsed URL for an http(s) base', () => {
    expect(assertAbsoluteHttpUrl('https://ntfy.example.com').host).toBe('ntfy.example.com');
    expect(assertAbsoluteHttpUrl('http://ntfy.example.com:8080').port).toBe('8080');
  });

  it('rejects a relative value with a ValidationError', () => {
    expect(() => assertAbsoluteHttpUrl('/alerts')).toThrowError(
      expect.objectContaining({ code: JsonRpcErrorCode.ValidationError }),
    );
  });

  it.each(['ftp://ntfy.example.com', 'file:///etc/passwd', 'ntfy://alerts'])(
    'rejects the %j scheme and names it in the message',
    (value) => {
      expect(() => assertAbsoluteHttpUrl(value)).toThrow(/unsupported scheme/i);
    },
  );
});

describe('isReservedAddress', () => {
  it.each([
    ['127.0.0.1', 'IPv4 loopback'],
    ['10.1.2.3', 'RFC1918 10/8'],
    ['172.16.0.1', 'RFC1918 172.16/12'],
    ['172.31.255.254', 'RFC1918 172.16/12 upper edge'],
    ['192.168.1.1', 'RFC1918 192.168/16'],
    ['169.254.169.254', 'link-local cloud metadata'],
    ['0.0.0.0', 'unspecified IPv4'],
    ['::1', 'IPv6 loopback'],
    ['::', 'unspecified IPv6'],
    ['fe80::1', 'IPv6 link-local'],
    ['fd00::1', 'IPv6 unique-local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback, dotted form'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback, hex form — what URL parsing emits'],
    ['::ffff:a9fe:a9fe', 'IPv4-mapped cloud metadata, hex form'],
    ['::ffff:192.168.0.5', 'IPv4-mapped RFC1918'],
    ['100.64.0.1', 'RFC6598 shared address space, lower edge'],
    ['100.68.34.90', 'RFC6598 — a Tailscale mesh address'],
    ['100.127.255.254', 'RFC6598 upper edge'],
  ])('blocks %s (%s)', (address) => {
    expect(isReservedAddress(address)).toBe(true);
  });

  it.each([
    ['1.1.1.1', 'public IPv4'],
    ['172.32.0.1', 'just past 172.16/12'],
    ['172.15.255.255', 'just below 172.16/12'],
    ['8.8.8.8', 'public resolver'],
    ['2606:4700:4700::1111', 'public IPv6'],
    ['::ffff:1.1.1.1', 'IPv4-mapped public address'],
    ['::ffff:808:808', 'IPv4-mapped public address, hex form'],
    ['100.63.255.255', 'just below 100.64/10'],
    ['100.128.0.1', 'just past 100.64/10'],
  ])('allows %s (%s)', (address) => {
    expect(isReservedAddress(address)).toBe(false);
  });
});

describe('assertPublicHost', () => {
  afterEach(() => {
    vi.mocked(lookup).mockClear();
  });

  it('resolves without throwing for a public address', async () => {
    await expect(assertPublicHost(new URL('https://1.1.1.1'))).resolves.toBeUndefined();
  });

  it('rejects an IPv4 loopback literal and names the address', async () => {
    await expect(assertPublicHost(new URL('http://127.0.0.1:8080'))).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('127.0.0.1'),
    });
  });

  it.each([
    ['http://2130706433', 'decimal'],
    ['http://0177.0.0.1', 'octal'],
    ['http://0x7f.0.0.1', 'hex'],
    ['http://127.1', 'two-part short form'],
    ['http://127.0.0.1.', 'trailing dot'],
    ['http://[::ffff:127.0.0.1]', 'IPv4-mapped literal'],
    ['http://user@public.example@127.0.0.1', 'a public-looking value in the userinfo'],
    ['http://0', 'unspecified shorthand'],
  ])('rejects %j (%s), which URL parsing normalizes into reserved space', async (raw) => {
    await expect(assertPublicHost(assertAbsoluteHttpUrl(raw))).rejects.toThrow(/non-public/i);
  });

  it('strips the brackets from an IPv6 literal before resolving', async () => {
    await expect(assertPublicHost(new URL('http://[::1]:8080'))).rejects.toThrow(/non-public/i);
    expect(vi.mocked(lookup).mock.calls[0]?.[0]).toBe('::1');
  });

  it('rejects when any resolved address is reserved, not just the first', async () => {
    resolvesTo([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.7', family: 4 },
    ]);
    await expect(assertPublicHost(new URL('https://split-horizon.example.com'))).rejects.toThrow(
      /10\.0\.0\.7/,
    );
  });

  it('allows a host whose every resolved address is public', async () => {
    resolvesTo([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
    await expect(
      assertPublicHost(new URL('https://dual-stack.example.com')),
    ).resolves.toBeUndefined();
  });

  it('translates a resolution failure into ServiceUnavailable', async () => {
    vi.mocked(lookup).mockRejectedValueOnce(
      Object.assign(new Error('getaddrinfo ENOTFOUND nope.invalid'), { code: 'ENOTFOUND' }),
    );
    await expect(assertPublicHost(new URL('https://nope.invalid'))).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining('nope.invalid'),
    });
  });
});
