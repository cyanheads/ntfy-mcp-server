/**
 * @fileoverview Tests for the EmojiTagService — substring search, ordering,
 * offset paging, truncation flag, direct lookup, edge-case query inputs (empty /
 * whitespace / zero-limit / out-of-range offset), the `size` getter, and the
 * module-level init/get/reset accessors that the framework wiring relies on.
 * Over the bundled reference: the query forms a caller reaches for (`:code:`,
 * spaces or hyphens for `_`, an emoji with or without U+FE0F or a skin tone),
 * every tag name and every emoji resolving to its own row, the normalized
 * query the search reports, and the time normalization takes on caller-sized
 * queries.
 * @module tests/services/emoji-tag-service
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EMOJI_TAGS } from '@/services/emoji-tags/data.generated.js';
import {
  EmojiTagService,
  getEmojiTagService,
  initEmojiTagService,
  resetEmojiTagService,
} from '@/services/emoji-tags/emoji-tag-service.js';

describe('EmojiTagService', () => {
  it('returns the leading entries in doc order when no query is given', () => {
    const svc = new EmojiTagService([
      ['grinning', '😀'],
      ['smile', '😄'],
      ['warning', '⚠️'],
    ]);
    const result = svc.search(undefined, 2);
    expect(result.matches).toEqual([
      { tag: 'grinning', emoji: '😀' },
      { tag: 'smile', emoji: '😄' },
    ]);
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it('matches case-insensitive substrings and preserves doc order', () => {
    const svc = new EmojiTagService([
      ['warning', '⚠️'],
      ['rotating_light', '🚨'],
      ['skull_and_crossbones', '☠️'],
      ['fire', '🔥'],
    ]);
    const result = svc.search('SKULL', 10);
    expect(result.matches).toEqual([{ tag: 'skull_and_crossbones', emoji: '☠️' }]);
    expect(result.total).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('flags truncation when more matches exist than the limit allows', () => {
    const svc = new EmojiTagService(
      Array.from({ length: 50 }, (_, i) => [`alert_${i}`, '⚠️'] as const),
    );
    const result = svc.search('alert', 10);
    expect(result.matches).toHaveLength(10);
    expect(result.total).toBe(50);
    expect(result.truncated).toBe(true);
  });

  it('pages through every match with offset, ending with truncated=false', () => {
    const svc = new EmojiTagService(
      Array.from({ length: 5 }, (_, i) => [`alert_${i}`, '⚠️'] as const),
    );

    const first = svc.search('alert', 2, 0);
    expect(first.matches.map((m) => m.tag)).toEqual(['alert_0', 'alert_1']);
    expect(first.total).toBe(5);
    expect(first.truncated).toBe(true);

    const second = svc.search('alert', 2, 2);
    expect(second.matches.map((m) => m.tag)).toEqual(['alert_2', 'alert_3']);
    expect(second.truncated).toBe(true);

    const last = svc.search('alert', 2, 4);
    expect(last.matches.map((m) => m.tag)).toEqual(['alert_4']);
    expect(last.total).toBe(5);
    expect(last.truncated).toBe(false);
  });

  it('reaches entries past the limit cap that no query narrows to', () => {
    const svc = new EmojiTagService(
      Array.from({ length: 500 }, (_, i) => [`tag_${i}`, '⚠️'] as const),
    );
    const page = svc.search(undefined, 200, 400);
    expect(page.matches).toHaveLength(100);
    expect(page.matches[0]?.tag).toBe('tag_400');
    expect(page.matches.at(-1)?.tag).toBe('tag_499');
    expect(page.total).toBe(500);
    expect(page.truncated).toBe(false);
  });

  it('returns nothing with truncated=false when offset lands past the last match', () => {
    const svc = new EmojiTagService([
      ['grinning', '😀'],
      ['smile', '😄'],
    ]);
    const result = svc.search(undefined, 25, 10);
    expect(result.matches).toEqual([]);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('defaults offset to 0 when omitted', () => {
    const svc = new EmojiTagService([
      ['grinning', '😀'],
      ['smile', '😄'],
    ]);
    expect(svc.search(undefined, 1).matches).toEqual([{ tag: 'grinning', emoji: '😀' }]);
  });

  it('returns an empty result with truncated=false when nothing matches', () => {
    const svc = new EmojiTagService([['warning', '⚠️']]);
    const result = svc.search('nonexistent', 5);
    expect(result.matches).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('lookup returns the raw emoji for a known tag', () => {
    const svc = new EmojiTagService([['warning', '⚠️']]);
    expect(svc.lookup('warning')).toBe('⚠️');
    expect(svc.lookup('missing')).toBeUndefined();
  });

  it('treats an empty-string query as "no query" (returns the leading slice)', () => {
    const svc = new EmojiTagService([
      ['grinning', '😀'],
      ['smile', '😄'],
    ]);
    const result = svc.search('', 5);
    expect(result.matches).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it('trims whitespace from the query before matching', () => {
    const svc = new EmojiTagService([
      ['grinning', '😀'],
      ['warning', '⚠️'],
    ]);
    const result = svc.search('   warning   ', 5);
    expect(result.matches).toEqual([{ tag: 'warning', emoji: '⚠️' }]);
  });

  it('returns no matches when limit is 0 (truncated still reflects total)', () => {
    const svc = new EmojiTagService([
      ['grinning', '😀'],
      ['smile', '😄'],
    ]);
    const result = svc.search(undefined, 0);
    expect(result.matches).toEqual([]);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('size getter reflects the entry count', () => {
    expect(new EmojiTagService([]).size).toBe(0);
    expect(
      new EmojiTagService([
        ['a', 'A'],
        ['b', 'B'],
      ]).size,
    ).toBe(2);
  });

  it('default constructor exposes the generated EMOJI_TAGS table', () => {
    const svc = new EmojiTagService();
    expect(svc.size).toBe(EMOJI_TAGS.length);
    // Sanity check — `warning` must be present for the publish tool's
    // emoji-resolution flow to remain useful.
    expect(svc.lookup('warning')).toBeDefined();
  });

  it('reads spaces and hyphens as `_` on both the query and the tag name, an exact name first', () => {
    const svc = new EmojiTagService([
      ['t-rex', '🦖'],
      ['heavy_check_mark', '✔️'],
      ['non-potable_water', '🚱'],
      ['potable_water', '🚰'],
    ]);
    expect(svc.search('t rex', 5).matches.map((m) => m.tag)).toEqual(['t-rex']);
    expect(svc.search('T_Rex', 5).matches.map((m) => m.tag)).toEqual(['t-rex']);
    expect(svc.search('heavy check', 5).matches.map((m) => m.tag)).toEqual(['heavy_check_mark']);
    expect(svc.search('heavy-check', 5).matches.map((m) => m.tag)).toEqual(['heavy_check_mark']);
    expect(svc.search('potable water', 5).matches.map((m) => m.tag)).toEqual([
      'potable_water',
      'non-potable_water',
    ]);
    expect(svc.search('potable', 5).matches.map((m) => m.tag)).toEqual([
      'non-potable_water',
      'potable_water',
    ]);
  });
});

describe('EmojiTagService query forms over the bundled reference', () => {
  const svc = new EmojiTagService();
  /** Every match for `query`, on one page. */
  const all = (query: string | undefined) => svc.search(query, svc.size);
  const tagsOf = (query: string) => all(query).matches.map((m) => m.tag);

  it.each([
    [':warning:', ['warning']],
    ['heavy check', ['heavy_check_mark']],
    [':+1:', ['+1']],
    ['⚠️', ['warning']],
    ['⚠', ['warning']],
    ['👍🏽', ['+1']],
    ['👎🏿', ['-1']],
    ['🏳‍🌈', ['rainbow_flag']],
    ['#⃣', ['hash']],
  ])('resolves %j to %j', (query, tags) => {
    expect(tagsOf(query)).toEqual(tags);
  });

  it('compares a glyph for equality, not as a substring of a longer emoji', () => {
    // U+2764 alone sits inside several emoji (heart_on_fire, mending_heart, …); only `heart` is it.
    expect(tagsOf('❤')).toEqual(['heart']);
  });

  it('finds every tag name, queried verbatim, among its own matches', () => {
    expect(svc.size).toBe(1812);
    const missing = EMOJI_TAGS.filter(([tag]) => !tagsOf(tag).includes(tag)).map(([tag]) => tag);
    expect(missing).toEqual([]);
  });

  it('puts the tag a query names exactly first, on the default 25-row page', () => {
    // `x`, `ok`, `us`, `lock` are substrings of dozens of longer names that precede them in doc order.
    expect(svc.search('x', 25).matches[0]?.tag).toBe('x');
    expect(svc.search(':ok:', 25).matches[0]?.tag).toBe('ok');
    const buried = EMOJI_TAGS.filter(([tag]) => svc.search(tag, 25).matches[0]?.tag !== tag).map(
      ([tag]) => tag,
    );
    expect(buried).toEqual([]);
  });

  it('resolves every emoji, with and without U+FE0F, to exactly its own row', () => {
    const wrong = EMOJI_TAGS.flatMap(([tag, emoji]) =>
      [emoji, emoji.replaceAll('️', '')]
        .filter((query) => JSON.stringify(tagsOf(query)) !== JSON.stringify([tag]))
        .map((query) => `${tag} ← ${query}`),
    );
    expect(wrong).toEqual([]);
  });

  it.each([undefined, '', '   ', '::', ' :: ', ':'])(
    'treats %j as no query: every row, and no effectiveQuery',
    (query) => {
      const result = all(query);
      expect(result.total).toBe(1812);
      expect(result.effectiveQuery).toBeUndefined();
    },
  );

  it.each([
    ['  warning  ', 'warning'],
    [':warning:', 'warning'],
    ['Heavy Check', 'heavy_check'],
    [' :t-rex: ', 't_rex'],
    ['⚠️', '⚠️'],
  ])('reports %j as effectiveQuery %j', (query, effective) => {
    expect(all(query).effectiveQuery).toBe(effective);
  });

  it('matches nothing for a query mixing a tag name and an emoji', () => {
    expect(all('warning ⚠️')).toMatchObject({ matches: [], total: 0 });
  });
});

describe('EmojiTagService.search on caller-sized queries', () => {
  const svc = new EmojiTagService();
  /** Per-call CPU budget at every size; a run past it already fails, so the remaining runs are skipped. */
  const CPU_LIMIT_MS = 50;

  /** Thread CPU milliseconds per `search()` of `query` over `reps` calls: the least of three runs. */
  function cpuMsPerCall(query: string, reps: number): number {
    let least = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const start = process.threadCpuUsage();
      for (let i = 0; i < reps; i++) svc.search(query, 25);
      const { user, system } = process.threadCpuUsage(start);
      least = Math.min(least, (user + system) / 1000 / reps);
      if (least > CPU_LIMIT_MS) break;
    }
    return least;
  }

  /**
   * Each shape doubles from `small` to 64× `small`, checking the per-call budget
   * at each size before the next and re-timing the `small` baseline beside it,
   * so a slow stretch of the run inflates neither side alone. The full span is
   * timed as three such pairs and the assertion is on their least growth: a
   * linear scan grows about 64× and a quadratic one about 4096×. Shapes a regex
   * scans end to end stay under ~80k characters, where Bun's regex engine leaves
   * its JIT for a slower interpreter; the digit run carries the 5k → 320k span.
   * The whitespace-only shape trims to no query, so it lists the reference.
   */
  it.each([
    ['one long line ending in a break', (n: number) => `${'x'.repeat(n)}\ny`, 1_200, 0],
    ['line breaks throughout', (n: number) => '  \r\n'.repeat(n / 4), 1_200, 1812],
    [
      'colon runs at both ends',
      (n: number) => `${':'.repeat(n / 2)}x:y${':'.repeat(n / 2)}`,
      1_200,
      0,
    ],
    ['a colon run inside', (n: number) => `x${':'.repeat(n)}y`, 1_200, 0],
    ['hyphens and skin tones', (n: number) => '-\u{1F3FD}️'.repeat(n / 4), 1_200, 0],
    ['one long digit run', (n: number) => '9'.repeat(n), 5_000, 0],
  ])('normalizes %s in time linear in its length', { timeout: 0 }, (_shape, make, small, total) => {
    expect(svc.search(make(small), 25).total).toBe(total);
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

describe('EmojiTagService module-level accessors', () => {
  beforeEach(() => {
    resetEmojiTagService();
  });
  afterEach(() => {
    resetEmojiTagService();
  });

  it('getEmojiTagService throws before init', () => {
    expect(() => getEmojiTagService()).toThrow(/not initialized/i);
  });

  it('initEmojiTagService returns the same instance that getEmojiTagService later resolves', () => {
    const svc = initEmojiTagService();
    expect(getEmojiTagService()).toBe(svc);
  });

  it('resetEmojiTagService unblocks fresh init across suites', () => {
    initEmojiTagService();
    resetEmojiTagService();
    expect(() => getEmojiTagService()).toThrow(/not initialized/i);
  });
});
