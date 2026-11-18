/**
 * @fileoverview Tests for the `base_url` guard — the always-on absolute
 * `http(s)` check and its refusal of credentials in the URL (naming the host at
 * most, quoting no raw value), the override normalization every tool runs above
 * its consent gate, the advertised pattern (including its empty-string branch
 * for form clients), reserved-range classification across IPv4 / IPv6 /
 * IPv4-mapped forms, and the opt-in host resolution check including its
 * DNS-failure translation.
 * @module tests/services/ntfy/base-url-guard
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertAbsoluteHttpUrl,
  assertPublicHost,
  BASE_URL_PATTERN,
  isReservedAddress,
  normalizeBaseOverride,
  withoutTrailingSlashes,
} from '@/services/ntfy/base-url-guard.js';

/** A probe credential: no rejection may carry either half. */
const USER = 'probeuser';
const PASSWORD = 'pwSECRET';

/** The error `fn` throws synchronously; fails the test when it returns. */
function thrownBy(fn: () => unknown): McpError {
  try {
    fn();
  } catch (err) {
    return err as McpError;
  }
  throw new Error('Expected a throw.');
}

/** What a caller and the failure log see of a rejection: its message and its data. */
const surfaced = (err: McpError) => JSON.stringify({ message: err.message, data: err.data });

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

  it('names only the scheme of a refused non-HTTP URL', () => {
    const err = thrownBy(() =>
      assertAbsoluteHttpUrl(`ftp://${USER}:${PASSWORD}@ntfy.example.com/alerts`),
    );
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { baseUrlRejected: true },
    });
    expect(err.message).toBe('base_url uses an unsupported scheme (ftp:).');
    for (const part of [USER, PASSWORD, 'alerts']) {
      expect(surfaced(err)).not.toContain(part);
    }
  });

  it.each([
    ['an IPv6 literal left open', `http://${USER}:${PASSWORD}@[::1`],
    ['an IPv4 address out of range', `http://${USER}:${PASSWORD}@256.256.256.256`],
    ['a relative path', '/alerts'],
  ])('refuses %s, a value that does not parse, quoting none of it', (_label, raw) => {
    const err = thrownBy(() => assertAbsoluteHttpUrl(raw));
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringMatching(/not an absolute URL/),
      data: { baseUrlRejected: true },
    });
    for (const part of [raw, USER, PASSWORD, 'alerts']) {
      expect(surfaced(err)).not.toContain(part);
    }
  });

  /** #58: credentials never travel in a base URL, in any spelling WHATWG parsing accepts. */
  it.each([
    ['a user and a password', `https://${USER}:${PASSWORD}@ntfy.example.com`],
    ['a user alone', `https://${USER}@ntfy.example.com`],
    ['a password alone', `https://:${PASSWORD}@ntfy.example.com`],
    ['a user with an empty password', `https://${USER}:@ntfy.example.com`],
    ['percent-encoded userinfo', `https://${USER}%40corp:${PASSWORD}%3A@ntfy.example.com`],
    ['an upper-case scheme', `HTTPS://${USER}:${PASSWORD}@ntfy.example.com`],
    ['a port and a path', `http://${USER}:${PASSWORD}@ntfy.example.com:8080/alerts`],
  ])('refuses userinfo with %s, naming the host and nothing else of the URL', (_label, raw) => {
    const err = thrownBy(() => assertAbsoluteHttpUrl(raw));
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { baseUrlRejected: true },
    });
    expect(err.message).toContain('"ntfy.example.com');
    for (const part of [USER, PASSWORD, 'alerts']) {
      expect(surfaced(err)).not.toContain(part);
    }
  });

  it('sends the caller to the operator-registered credentials for that host', () => {
    const err = thrownBy(() =>
      assertAbsoluteHttpUrl(`https://${USER}:${PASSWORD}@ntfy.example.com`),
    );
    const hint = (err.data as { recovery: { hint: string } }).recovery.hint;
    for (const term of ['`NTFY_SERVERS`', '`authToken`', '`authUsername`', '`authPassword`']) {
      expect(hint).toContain(term);
    }
  });

  it.each(['https://@ntfy.example.com', 'https://:@ntfy.example.com'])(
    'accepts the empty userinfo of %j, which carries no credential',
    (raw) => {
      const url = assertAbsoluteHttpUrl(raw);
      expect(url.host).toBe('ntfy.example.com');
      expect(url.username).toBe('');
      expect(url.password).toBe('');
    },
  );
});

/**
 * The override every tool resolves above its consent gate (#58): a refused
 * value fails there, before a prompt can name it or a request can carry it.
 */
describe('normalizeBaseOverride', () => {
  it('reads an absent or empty value — a form client’s untouched field — as no override', () => {
    expect(normalizeBaseOverride(undefined)).toBeUndefined();
    expect(normalizeBaseOverride('')).toBeUndefined();
  });

  it('drops trailing slashes', () => {
    expect(normalizeBaseOverride('https://ntfy.example.com//')).toBe('https://ntfy.example.com');
  });

  it('refuses userinfo, scheme, and parse failures there, through the same guard', () => {
    for (const raw of [
      `https://${USER}:${PASSWORD}@ntfy.example.com/`,
      'ftp://ntfy.example.com',
      'http://[::1',
      /**
       * A second `@` after an empty userinfo: the parser reads the first as
       * the username (`%40`) or the password, so the value carries a
       * credential. Dropping the empty userinfo before the guard reads it
       * would leave `https://@ntfy.example.com` and let it through.
       */
      'https://@@ntfy.example.com',
      'https://:@@ntfy.example.com',
    ]) {
      expect(thrownBy(() => normalizeBaseOverride(raw))).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { baseUrlRejected: true },
      });
    }
  });

  it.each([
    ['https://@ntfy.example.com/', 'https://ntfy.example.com'],
    ['HTTP://:@ntfy.example.com:8080', 'HTTP://ntfy.example.com:8080'],
    ['https:///@ntfy.example.com/', 'https://ntfy.example.com'],
    // The parser reads a backslash after a special scheme as a slash.
    ['https://\\@ntfy.example.com', 'https://ntfy.example.com'],
  ])('drops the empty userinfo of %j, so the base it returns carries no `@`', (raw, base) => {
    expect(normalizeBaseOverride(raw)).toBe(base);
    expect(new URL(base).host).toBe(new URL(raw).host);
  });

  it('keeps an `@` in the path, which is no userinfo', () => {
    expect(normalizeBaseOverride('https://ntfy.example.com/@team')).toBe(
      'https://ntfy.example.com/@team',
    );
  });
});

describe('withoutTrailingSlashes', () => {
  it.each([
    ['', ''],
    ['/', ''],
    ['///', ''],
    ['https://ntfy.example.com', 'https://ntfy.example.com'],
    ['https://ntfy.example.com/', 'https://ntfy.example.com'],
    ['https://ntfy.example.com///', 'https://ntfy.example.com'],
    ['https://ntfy.example.com//team//', 'https://ntfy.example.com//team'],
    ['https://ntfy.example.com/team/\n', 'https://ntfy.example.com/team/\n'],
    ['https://ntfy.example.com/team/ ', 'https://ntfy.example.com/team/ '],
    ['https://ntfy.example.com\\', 'https://ntfy.example.com\\'],
    ['https://ntfy.example.com/é😀//', 'https://ntfy.example.com/é😀'],
  ])('turns %j into %j', (raw, trimmed) => {
    expect(withoutTrailingSlashes(raw)).toBe(trimmed);
  });
});

/**
 * Every scanner a caller's `base_url` meets before any request: the trim, the
 * whole override normalization (trim, WHATWG parse, empty-userinfo rewrite),
 * and the pattern every tool schema tests it against. A `base_url` has no
 * length limit.
 */
describe('base_url scanners on caller-sized input', () => {
  /** Per-call CPU budget at every size; a run past it already fails, so the remaining runs are skipped. */
  const CPU_LIMIT_MS = 20;
  /**
   * The least thread CPU a batch of calls is read over. Readings come in whole
   * microseconds, and several rows are O(1) for their scanner (the trim stops
   * at the first character that is not a slash), whose fixed-size batches read
   * as zero often enough to turn the growth ratio into `NaN` or `Infinity`.
   */
  const MIN_BATCH_MS = 1;
  const SMALL = 5_000;

  /**
   * Thread CPU milliseconds per call of `scan` on `value`: the least of three
   * batches, each doubling its call count until it reads {@link MIN_BATCH_MS}
   * or its calls average past the budget, which ends the reading at once.
   */
  function cpuMsPerCall(scan: (value: string) => unknown, value: string): number {
    let least = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      for (let calls = 1; ; calls *= 2) {
        const start = process.threadCpuUsage();
        for (let i = 0; i < calls; i++) scan(value);
        const { user, system } = process.threadCpuUsage(start);
        const batchMs = (user + system) / 1000;
        if (batchMs >= MIN_BATCH_MS || batchMs / calls > CPU_LIMIT_MS) {
          least = Math.min(least, batchMs / calls);
          break;
        }
      }
      if (least > CPU_LIMIT_MS) break;
    }
    return least;
  }

  /**
   * Shapes of `n` characters after a short prefix, each one parsing on both
   * runtimes: slashes in the path, at its end, and after the scheme (where the
   * empty-userinfo rewrite and the WHATWG parser read them), a host with no
   * break, two line-break shapes, and a digit run.
   */
  const SHAPES = [
    ['slashes through the path', (n: number) => `https://h/${'/'.repeat(n)}x`],
    ['slashes ending the path', (n: number) => `https://h${'/'.repeat(n)}`],
    [
      'slashes after the scheme, then an empty userinfo',
      (n: number) => `https://${'/'.repeat(n)}@x`,
    ],
    ['slashes after the scheme, then a host', (n: number) => `https://${'/'.repeat(n)}x`],
    ['a long host, then a space', (n: number) => `https://${'x'.repeat(n)} `],
    ['one long line ending in a break', (n: number) => `https://h/${'§1 x'.repeat(n / 4)}\ny`],
    ['line breaks throughout', (n: number) => `https://h/${'  \r\n'.repeat(n / 4)}`],
    ['one long digit run', (n: number) => `https://h/${'9'.repeat(n)}`],
  ] as const;

  /**
   * Each shape doubles from 5k to 320k characters, checking the per-call budget
   * at each size before the next and re-timing the 5k baseline beside it; the
   * full span is timed as three such pairs and the assertion is on their least
   * growth, which stays under 256 only for a scan linear in its input: about
   * 64× for one that reads it all, about 1× for one that stops early.
   */
  describe.each([
    ['withoutTrailingSlashes', withoutTrailingSlashes],
    ['normalizeBaseOverride', normalizeBaseOverride],
    ['BASE_URL_PATTERN', (value: string) => BASE_URL_PATTERN.test(value)],
  ] as const)('%s', (_name, scan) => {
    it.each(SHAPES)('scans %s in time linear in its length', { timeout: 0 }, (_shape, make) => {
      expect(() => scan(make(SMALL))).not.toThrow();
      const pair = (n: number) => {
        const largeMs = cpuMsPerCall(scan, make(n));
        expect(largeMs).toBeLessThan(CPU_LIMIT_MS);
        return largeMs / cpuMsPerCall(scan, make(SMALL));
      };
      for (let n = SMALL * 2; n < SMALL * 64; n *= 2) pair(n);
      const growth = Math.min(pair(SMALL * 64), pair(SMALL * 64), pair(SMALL * 64));
      expect(growth).toBeLessThan(256);
    });
  });
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
    ['http://0', 'unspecified shorthand'],
  ])('rejects %j (%s), which URL parsing normalizes into reserved space', async (raw) => {
    await expect(assertPublicHost(assertAbsoluteHttpUrl(raw))).rejects.toThrow(/non-public/i);
  });

  it('never resolves a host hidden behind a public-looking userinfo: the credentials refusal comes first', () => {
    const err = thrownBy(() => assertAbsoluteHttpUrl('http://user@public.example@127.0.0.1'));
    expect(err.message).toContain('credentials');
    expect(err.message).toContain('"127.0.0.1"');
    expect(err.message).not.toContain('public.example');
    expect(vi.mocked(lookup)).not.toHaveBeenCalled();
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
