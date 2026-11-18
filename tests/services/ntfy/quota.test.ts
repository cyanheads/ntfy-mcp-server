/**
 * @fileoverview Tests for `parseQuota` — reading ntfy's `RateLimit-Policy` and
 * `RateLimit` response headers into a quota. Covers the header values ntfy.sh
 * and ntfy 2.38.1 send (as separate lines and as the `, `-joined value both
 * runtimes hand back), a response carrying one policy or none, a policy left
 * out when any of its three numbers is missing or not a non-negative integer,
 * members the parser cannot read or does not know beside ones it can, RFC 9651
 * quoting (a name holding `,` or `;`, an unterminated quote), name and header
 * casing, generated header text, and the time the scan takes on long values.
 * @module tests/services/ntfy/quota
 */

import { describe, expect, it } from 'vitest';

import { parseQuota } from '@/services/ntfy/quota.js';

/** ntfy.sh's headers on a publish, as each runtime joins the repeated lines. */
const NTFY_SH_POLICY = '"requests";q=60;w=300, "messages";q=250;w=86400';
const NTFY_SH_LIMIT = '"requests";r=58;t=1, "messages";r=246;t=50750';

const REQUESTS = { limit: 60, remaining: 58, nextRequestInSeconds: 1 };
const MESSAGES = { limit: 250, remaining: 246, resetsInSeconds: 50750 };
const NTFY_SH_QUOTA = { requests: REQUESTS, messages: MESSAGES };

/** A response's headers with the given `RateLimit-Policy` and `RateLimit` values; `undefined` leaves that header out. */
function rateLimitHeaders(policy: string | undefined, limit: string | undefined): Headers {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (policy !== undefined) headers.set('ratelimit-policy', policy);
  if (limit !== undefined) headers.set('ratelimit', limit);
  return headers;
}

/** ntfy.sh's `requests` members beside the given `messages` members, one per header. */
function besideRequests(policyMembers: string, limitMembers: string): Headers {
  return rateLimitHeaders(
    `"requests";q=60;w=300, ${policyMembers}`,
    `"requests";r=58;t=1, ${limitMembers}`,
  );
}

describe('parseQuota', () => {
  it('reads both policies from the separate lines ntfy.sh sends', () => {
    const headers = new Headers();
    headers.append('ratelimit', '"requests";r=58;t=1');
    headers.append('ratelimit', '"messages";r=246;t=50750');
    headers.append('ratelimit-policy', '"requests";q=60;w=300');
    headers.append('ratelimit-policy', '"messages";q=250;w=86400');
    expect(parseQuota(headers)).toStrictEqual(NTFY_SH_QUOTA);
  });

  it('reads the joined value fetch returns for ntfy 2.38.1 at its default limits', () => {
    const headers = rateLimitHeaders(
      '"requests";q=60;w=300, "messages";q=17280;w=86400',
      '"requests";r=59;t=5, "messages";r=17233;t=26393',
    );
    expect(parseQuota(headers)).toStrictEqual({
      requests: { limit: 60, remaining: 59, nextRequestInSeconds: 5 },
      messages: { limit: 17280, remaining: 17233, resetsInSeconds: 26393 },
    });
  });

  it('reports only the policy a response carries (a 42901 refusal)', () => {
    const headers = rateLimitHeaders('"requests";q=6;w=120', '"requests";r=0;t=20');
    expect(parseQuota(headers)).toStrictEqual({
      requests: { limit: 6, remaining: 0, nextRequestInSeconds: 20 },
    });
  });

  it('reports a remaining of 0 as 0', () => {
    const headers = rateLimitHeaders(
      '"requests";q=6;w=120, "messages";q=4;w=86400',
      '"requests";r=2;t=20, "messages";r=0;t=26839',
    );
    expect(parseQuota(headers)).toStrictEqual({
      requests: { limit: 6, remaining: 2, nextRequestInSeconds: 20 },
      messages: { limit: 4, remaining: 0, resetsInSeconds: 26839 },
    });
  });

  it('reads leading zeros, and `-0` as 0', () => {
    const headers = besideRequests('"messages";q=0250', '"messages";r=-0;t=007');
    expect(parseQuota(headers)).toStrictEqual({
      requests: REQUESTS,
      messages: { limit: 250, remaining: 0, resetsInSeconds: 7 },
    });
  });

  it('returns undefined when neither header is present', () => {
    const headers = new Headers({ 'content-type': 'application/x-ndjson; charset=utf-8' });
    expect(parseQuota(headers)).toBeUndefined();
  });

  it.each([
    ['RateLimit-Policy alone', NTFY_SH_POLICY, undefined],
    ['RateLimit alone', undefined, NTFY_SH_LIMIT],
    ['both empty', '', ''],
    ['both whitespace', '  \t ', ' '],
  ])('returns undefined for %s', (_label, policy, limit) => {
    expect(parseQuota(rateLimitHeaders(policy, limit))).toBeUndefined();
  });

  it('leaves out a policy named in only one of the two headers', () => {
    const requestsState = rateLimitHeaders(NTFY_SH_POLICY, '"requests";r=58;t=1');
    expect(parseQuota(requestsState)).toStrictEqual({ requests: REQUESTS });
    const messagesPolicy = rateLimitHeaders('"messages";q=250;w=86400', NTFY_SH_LIMIT);
    expect(parseQuota(messagesPolicy)).toStrictEqual({ messages: MESSAGES });
  });

  it.each([
    ['q missing', '"messages";w=86400', '"messages";r=246;t=50750'],
    ['r missing', '"messages";q=250;w=86400', '"messages";t=50750'],
    ['t missing', '"messages";q=250;w=86400', '"messages";r=246'],
    ['r a decimal', '"messages";q=250;w=86400', '"messages";r=246.5;t=50750'],
    ['q a decimal of a whole number', '"messages";q=250.0;w=86400', '"messages";r=246;t=50750'],
    ['r negative', '"messages";q=250;w=86400', '"messages";r=-1;t=50750'],
    ['t negative', '"messages";q=250;w=86400', '"messages";r=246;t=-50750'],
    ['r a token', '"messages";q=250;w=86400', '"messages";r=many;t=50750'],
    ['r a string', '"messages";q=250;w=86400', '"messages";r="246";t=50750'],
    ['r a bare key (Boolean true)', '"messages";q=250;w=86400', '"messages";r;t=50750'],
    ['r a Boolean', '"messages";q=250;w=86400', '"messages";r=?1;t=50750'],
    ['r past 15 digits', '"messages";q=250;w=86400', '"messages";r=1234567890123456;t=50750'],
    ['r repeated, the last a token', '"messages";q=250;w=86400', '"messages";r=246;r=x;t=50750'],
    ['the name in title case', '"Messages";q=250;w=86400', '"Messages";r=246;t=50750'],
    ['the name in upper case', '"MESSAGES";q=250;w=86400', '"MESSAGES";r=246;t=50750'],
    ['the name a Token, not a String', 'messages;q=250;w=86400', 'messages;r=246;t=50750'],
    ['the name twice in a header', '"messages";q=250, "messages";q=5', '"messages";r=246;t=50750'],
    ['text after the member', '"messages";q=250;w=86400', '"messages";r=246;t=50750 x'],
    ['a space before `;`', '"messages";q=250;w=86400', '"messages" ;r=246;t=50750'],
    ['a tab after `;`', '"messages";q=250;w=86400', '"messages";\tr=246;t=50750'],
    ['an unterminated quote', '"messages";q=250;w=86400', '"messages;r=246;t=50750'],
    ['an unterminated quote in the policy', '"messages;q=250;w=86400', '"messages";r=246;t=50750'],
  ])('leaves out messages, and keeps requests, with %s', (_label, policyMember, limitMember) => {
    const headers = besideRequests(policyMember, limitMember);
    expect(parseQuota(headers)).toStrictEqual({ requests: REQUESTS });
  });

  it.each([
    ['=oops'],
    ['"bad"x'],
    ['"a";=1'],
    ['"a";R=1'],
    ['('],
    ['"a" "b"'],
    ['"a";r=1.'],
    ['"a";r=1.2345'],
    ['"a";r=-'],
    ['?2'],
    [':not base64!:'],
    ['@1.5'],
    ['%"%E9"'],
    ['"tab\tinside"'],
    ['"bad\\escape"'],
    ['§'],
    [''],
  ])('reads the members on both sides of the unreadable member %j', (bad) => {
    const headers = rateLimitHeaders(
      `"requests";q=60;w=300, ${bad}, "messages";q=250;w=86400`,
      `"requests";r=58;t=1, ${bad}, "messages";r=246;t=50750`,
    );
    expect(parseQuota(headers)).toStrictEqual(NTFY_SH_QUOTA);
  });

  it('ignores policy names other than messages and requests', () => {
    const headers = rateLimitHeaders(
      '"emails";q=16;w=86400, "requests";q=60;w=300, "calls";q=5;w=86400, "bandwidth";q=209715200;w=86400',
      '"emails";r=0;t=3600, "requests";r=58;t=1, "calls";r=5;t=3600, "bandwidth";r=1;t=2',
    );
    expect(parseQuota(headers)).toStrictEqual({ requests: REQUESTS });
  });

  it('reads parameters in any order, other parameters of any type ignored', () => {
    const headers = rateLimitHeaders(
      '"requests";w=300;q=60, "messages";qu="requests";w=86400;pk=:cHJvamVjdA==:;q=250',
      '"requests";t=1;r=58, "messages";x=1.5;t=50750;d=@1659578233;s=%"caf%c3%a9";b=?0;r=246',
    );
    expect(parseQuota(headers)).toStrictEqual(NTFY_SH_QUOTA);
  });

  it('keeps the last value of a repeated parameter', () => {
    const headers = besideRequests('"messages";q=250;w=86400', '"messages";r=x;r=246;t=50750');
    expect(parseQuota(headers)).toStrictEqual(NTFY_SH_QUOTA);
  });

  it('reads members padded with spaces and tabs', () => {
    const headers = rateLimitHeaders(
      ' "requests";q=60;w=300 \t,\t "messages";  q=250;  w=86400 ',
      '"requests";r=58;t=1\t, \t"messages"; r=246;   t=50750\t',
    );
    expect(parseQuota(headers)).toStrictEqual(NTFY_SH_QUOTA);
  });

  it('reads valid members of other RFC 9651 types around the policies without losing them', () => {
    const headers = rateLimitHeaders(
      `:cHJvamVjdA==:;q=1, ("a, b" tok;x=1 ?1);q=2, ${NTFY_SH_POLICY}, tok;q=3, @1659578233, %"caf%c3%a9", 1.5;q=4`,
      `("x" "y");r=1;t=2, ${NTFY_SH_LIMIT}, ?0;r=3;t=4, -7;r=5;t=6`,
    );
    expect(parseQuota(headers)).toStrictEqual(NTFY_SH_QUOTA);
  });

  it.each([
    ['a comma', '"spare, messages";r=1;t=2'],
    ['a semicolon', '"messages;spare";r=246;t=50750'],
    ['an escaped quote', '"spare\\", \\"messages";r=1;t=2'],
  ])('reads a quoted name holding %s as one name', (_label, limitMember) => {
    expect(parseQuota(besideRequests('"messages";q=250;w=86400', limitMember))).toStrictEqual({
      requests: REQUESTS,
    });
  });

  it('reads the members around a quoted name holding `,` and `;`', () => {
    const headers = rateLimitHeaders(
      `"a, b; c";q=1;w=2, ${NTFY_SH_POLICY}`,
      `"requests";r=58;t=1, "a, b; c";r=3;t=4, "messages";r=246;t=50750`,
    );
    expect(parseQuota(headers)).toStrictEqual(NTFY_SH_QUOTA);
  });

  it('loses the members an unterminated quote swallows, and nothing before it', () => {
    // The quote opened before `requests` closes at the one before `messages`, so neither name survives.
    const first = rateLimitHeaders(NTFY_SH_POLICY, '"requests;r=58;t=1, "messages";r=246;t=50750');
    expect(parseQuota(first)).toBeUndefined();
    const last = rateLimitHeaders(NTFY_SH_POLICY, '"requests";r=58;t=1, "messages;r=246;t=50750');
    expect(parseQuota(last)).toStrictEqual({ requests: REQUESTS });
  });

  it.each([
    ['Ratelimit-Policy', 'Ratelimit'],
    ['RateLimit-Policy', 'RateLimit'],
    ['RATELIMIT-POLICY', 'RATELIMIT'],
  ])('reads the headers when the response names them %s / %s', (policyName, limitName) => {
    const headers = new Headers([
      [policyName, NTFY_SH_POLICY],
      [limitName, NTFY_SH_LIMIT],
    ]);
    expect(parseQuota(headers)).toStrictEqual(NTFY_SH_QUOTA);
  });

  it('never throws on generated header text, and reports only non-negative integers', () => {
    const NAMES = ['"messages"', '"requests"', '"emails"', 'messages', '"Messages"'];
    const COUNTS = ['0', '250', '50750'];
    const VALUES = ['-1', '1.5', '9999999999999999', 'x', '"5"', '?1', ''];
    const JUNK = ['"', '\\', '(', ')', ':', '@', '%"', '%e9', '=', ';', ' ', '\t', ',', '§'];
    const SEPARATORS = [', ', ',', ' ,\t'];
    // mulberry32 with a fixed seed, so a failure reproduces.
    let seed = 60;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const pick = (items: readonly string[]) => items[Math.floor(random() * items.length)] ?? '';
    /** A member naming most of `keys`, each value usually a count, with junk spliced in about a third of the time. */
    const member = (keys: readonly string[]) => {
      let text = pick(NAMES);
      for (const key of keys) {
        if (random() < 0.9) text += `;${key}=${pick(random() < 0.7 ? COUNTS : VALUES)}`;
      }
      if (random() < 0.35) {
        const at = Math.floor(random() * (text.length + 1));
        text = text.slice(0, at) + pick(JUNK) + text.slice(at);
      }
      return text;
    };
    /** One to three members joined by `,` with assorted whitespace. */
    const header = (keys: readonly string[]) => {
      let text = member(keys);
      for (let i = Math.floor(random() * 3); i > 0; i--) text += pick(SEPARATORS) + member(keys);
      return text;
    };
    let reported = 0;
    for (let i = 0; i < 5_000; i++) {
      const headers = rateLimitHeaders(header(['q', 'w']), header(['r', 't']));
      const quota = parseQuota(headers);
      if (quota === undefined) continue;
      reported++;
      for (const key of Object.keys(quota)) expect(['messages', 'requests']).toContain(key);
      for (const policy of [quota.messages, quota.requests]) {
        for (const value of policy ? Object.values(policy) : []) {
          expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
        }
      }
    }
    // The generator reaches readable policies, not only rejections.
    expect(reported).toBeGreaterThan(0);
  });
});

describe('parseQuota on long header values', () => {
  /** Per-call CPU budget at every size; a run past it already fails, so the remaining runs are skipped. */
  const CPU_LIMIT_MS = 50;

  /** Thread CPU milliseconds per `parseQuota()` of a response whose `RateLimit` is `limit`, over `reps` calls: the least of three runs. */
  function cpuMsPerCall(limit: string, reps: number): number {
    const headers = rateLimitHeaders(NTFY_SH_POLICY, limit);
    let least = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const start = process.threadCpuUsage();
      for (let i = 0; i < reps; i++) parseQuota(headers);
      const { user, system } = process.threadCpuUsage(start);
      least = Math.min(least, (user + system) / 1000 / reps);
      if (least > CPU_LIMIT_MS) break;
    }
    return least;
  }

  /**
   * Each shape doubles from 5k to 320k characters, checking the per-call budget
   * at each size before the next and re-timing the 5k baseline beside it, so a
   * slow stretch of the run inflates neither side alone. The full span is timed
   * as three such pairs and the assertion is on their least growth: a linear
   * scan grows about 64× and a quadratic one about 4096×. The scanner uses no
   * regex, so every shape carries the full span. A header value cannot hold a
   * line break (`Headers` rejects CR, LF, and NUL), so the two line-break shapes
   * become their reachable forms: one long Latin-1 line ending in a tab, and
   * whitespace with commas throughout.
   */
  it.each([
    ['a run of double quotes', (n: number) => '"'.repeat(n), undefined],
    ['escaped quotes never closed', (n: number) => `"${'\\"'.repeat(n / 2)}`, undefined],
    ['a run of inner-list openers', (n: number) => '('.repeat(n), undefined],
    ['a run of semicolons', (n: number) => `"messages"${';'.repeat(n)}`, undefined],
    [
      'a run of parameters on a readable member',
      (n: number) => `"messages";r=246;t=50750${';a'.repeat(n / 2)}`,
      { messages: MESSAGES },
    ],
    [
      'a run of members',
      (n: number) => `${'"x";q=10, '.repeat(n / 10)}"messages";r=246;t=50750`,
      { messages: MESSAGES },
    ],
    [
      'a run of unreadable members',
      (n: number) => `${'"xy";r y, '.repeat(n / 10)}"messages";r=246;t=50750`,
      { messages: MESSAGES },
    ],
    ['quotes reopening across commas', (n: number) => '"a, '.repeat(n / 4), undefined],
    [
      'a run of empty members',
      (n: number) => `${', '.repeat(n / 2)}"messages";r=246;t=50750`,
      { messages: MESSAGES },
    ],
    [
      'one long digit run',
      (n: number) => `"messages";r=${'9'.repeat(n)}, "requests";r=58;t=1`,
      { requests: REQUESTS },
    ],
    ['one Latin-1 line ending in a tab', (n: number) => `${'§1 x'.repeat(n / 4)}\ty`, undefined],
    [
      'whitespace and commas throughout',
      (n: number) => `${'  \t,'.repeat(n / 4)}"messages";r=246;t=50750`,
      { messages: MESSAGES },
    ],
  ])('reads %s in time linear in its length', { timeout: 0 }, (_shape, make, expected) => {
    const small = 5_000;
    expect(parseQuota(rateLimitHeaders(NTFY_SH_POLICY, make(small)))).toStrictEqual(expected);
    const pair = (n: number) => {
      const largeMs = cpuMsPerCall(make(n), (64 * small) / n);
      expect(largeMs).toBeLessThan(CPU_LIMIT_MS);
      return largeMs / cpuMsPerCall(make(small), 64);
    };
    for (let n = small * 2; n < small * 64; n *= 2) pair(n);
    const growth = Math.min(pair(small * 64), pair(small * 64), pair(small * 64));
    expect(growth).toBeLessThan(256);
  });
});
