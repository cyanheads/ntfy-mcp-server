/**
 * @fileoverview Tests for `literal()` / `literalBlock()` — delimiter sizing past
 * backtick runs, edge padding, and the fence that replaces a span when the value
 * holds a CR, LF, or CRLF line ending — and for the consent-prompt renderers
 * `promptLiteral()` and `promptTarget()`: visible escapes for controls,
 * separators, format characters, and lone surrogates; `promptLiteral()`'s
 * 200-character excerpt, its stated length, and its cut between code points;
 * `promptTarget()`'s whole value, however long; time linear in the value's
 * length for both.
 * @module tests/tools/utils/markdown-literal
 */

import { describe, expect, it } from 'vitest';

import {
  literal,
  literalBlock,
  promptLiteral,
  promptTarget,
} from '@/mcp-server/tools/utils/markdown-literal.js';
import { readCommonMark } from '../../helpers/commonmark.js';

/** Any code point a prompt renderer must never pass through raw. */
const RAW_INVISIBLE = /[\p{Cc}\p{Zl}\p{Zp}\p{Cf}\p{Cs}]/u;

/** A value holding one escaped character class, and the code span a prompt shows it as. */
const ESCAPES = [
  ['LF', 'a\n# b', '`a\\n# b`'],
  ['CR', 'a\r# b', '`a\\r# b`'],
  ['CRLF', 'a\r\n# b', '`a\\r\\n# b`'],
  ['tab', 'a\tb', '`a\\tb`'],
  ['NUL', 'a\u0000b', '`a\\u{0000}b`'],
  ['ESC', '\u001B[31mred', '`\\u{001B}[31mred`'],
  ['NEL', 'a\u0085b', '`a\\u{0085}b`'],
  ['DEL', 'a\u007Fb', '`a\\u{007F}b`'],
  ['line separator', 'a\u2028b', '`a\\u{2028}b`'],
  ['paragraph separator', 'a\u2029b', '`a\\u{2029}b`'],
  ['right-to-left override', 'evil\u202Etxt.exe', '`evil\\u{202E}txt.exe`'],
  ['isolates', '\u2066a\u2067b\u2068c\u2069', '`\\u{2066}a\\u{2067}b\\u{2068}c\\u{2069}`'],
  ['zero-width space', 'ap\u200Bprove', '`ap\\u{200B}prove`'],
  ['byte-order mark', '\uFEFFx', '`\\u{FEFF}x`'],
  ['soft hyphen', 'a\u00ADb', '`a\\u{00AD}b`'],
  ['tag character', 'a\u{E0041}b', '`a\\u{E0041}b`'],
  ['lone surrogate', 'a\uD800b', '`a\\u{D800}b`'],
  ['backtick beside a line break', '`\n`', '`` `\\n` ``'],
] as const;

describe('literal', () => {
  it.each([
    ['plain', '`plain`'],
    ['*x* <b> [t](u)', '`*x* <b> [t](u)`'],
    ['a`b', '``a`b``'],
    ['a``b', '```a``b```'],
    ['a```b', '````a```b````'],
    ['a````b', '`````a````b`````'],
    ['`edge', '`` `edge ``'],
    ['edge`', '`` edge` ``'],
    [' padded ', '`  padded  `'],
  ])('wraps %j as %j', (value, expected) => {
    expect(literal(value)).toBe(expected);
  });

  it('renders an empty value as a visible `(empty)` marker, not a bare pair of backticks', () => {
    expect(literal('')).toBe('(empty)');
    // A value that reads "(empty)" stays a code span, so the two never collide.
    expect(literal('(empty)')).toBe('`(empty)`');
  });

  it.each([
    ['LF', 'a\n# b'],
    ['CR', 'a\r# b'],
    ['CRLF', 'a\r\n# b'],
  ])('fences a value with a %s line ending on lines of its own', (_label, value) => {
    expect(literal(value)).toBe(`\n\`\`\`text\n${value}\n\`\`\`\n`);
  });

  it('maps an array element by element, ignoring the index `.map()` passes', () => {
    expect(['a', 'b`c', 'd\ne'].map(literal)).toEqual(['`a`', '``b`c``', '\n```text\nd\ne\n```\n']);
  });
});

describe('literalBlock', () => {
  it('sizes the fence past the longest backtick run and labels it with the info string', () => {
    expect(literalBlock('x\n```\ny', 'markdown')).toBe('````markdown\nx\n```\ny\n````');
    expect(literalBlock('plain', 'text')).toBe('```text\nplain\n```');
  });
});

describe('promptLiteral', () => {
  it.each([
    ['plain', '`plain`'],
    ['*x* <b> [t](u)', '`*x* <b> [t](u)`'],
    ['a`b', '``a`b``'],
    ['', '(empty)'],
  ])('renders %j as %j, the way `literal()` does', (value, expected) => {
    expect(promptLiteral(value)).toBe(expected);
  });

  it.each(ESCAPES)(
    'shows a %s as a visible escape inside one code span',
    (_label, value, expected) => {
      const rendered = promptLiteral(value);
      expect(rendered).toBe(expected);
      expect(rendered).not.toMatch(RAW_INVISIBLE);
    },
  );

  it('leaves visible non-ASCII, emoji, and a joined emoji sequence as they are', () => {
    expect(promptLiteral('café 😀 ✔️')).toBe('`café 😀 ✔️`');
    // The joiner inside a family emoji is a format character, so it shows.
    expect(promptLiteral('👨\u200D👩')).toBe('`👨\\u{200D}👩`');
  });

  it('shows a value of 200 characters whole, counting code points rather than UTF-16 units', () => {
    expect(promptLiteral('a'.repeat(200))).toBe(`\`${'a'.repeat(200)}\``);
    // 200 astral code points are 400 UTF-16 units, still 200 characters.
    expect(promptLiteral('😀'.repeat(200))).toBe(`\`${'😀'.repeat(200)}\``);
  });

  it('shows the first 200 characters of a longer value and states its full length', () => {
    expect(promptLiteral('a'.repeat(201))).toBe(
      `\`${'a'.repeat(200)}\` (first 200 of 201 characters)`,
    );
    expect(promptLiteral(`${'b'.repeat(250)}\n${'c'.repeat(7767)}`)).toBe(
      `\`${'b'.repeat(200)}\` (first 200 of 8018 characters)`,
    );
  });

  it('cuts between code points, never inside a surrogate pair', () => {
    const rendered = promptLiteral(`${'a'.repeat(199)}😀😀`);
    expect(rendered).toBe(`\`${'a'.repeat(199)}😀\` (first 200 of 201 characters)`);
    expect(rendered.isWellFormed()).toBe(true);
  });

  it('escapes a joiner the cut leaves at the end, so it cannot join what follows', () => {
    const family = '👨\u200D👩\u200D👧';
    expect(promptLiteral(`${'a'.repeat(198)}${family}`)).toBe(
      `\`${'a'.repeat(198)}👨\\u{200D}\` (first 200 of 203 characters)`,
    );
  });

  it('measures the length before escaping, so a cut never splits an escape', () => {
    expect(promptLiteral('\u202E'.repeat(201))).toBe(
      `\`${'\\u{202E}'.repeat(200)}\` (first 200 of 201 characters)`,
    );
  });

  it('sizes the span past a backtick run inside the excerpt', () => {
    expect(promptLiteral(`${'`'.repeat(3)}${'x'.repeat(300)}`)).toBe(
      `\`\`\`\` \`\`\`${'x'.repeat(197)} \`\`\`\` (first 200 of 303 characters)`,
    );
  });
});

describe('promptTarget', () => {
  it.each([
    ['plain', '`plain`'],
    ['*x* <b> [t](u)', '`*x* <b> [t](u)`'],
    ['a`b', '``a`b``'],
    ['', '(empty)'],
  ])('renders %j as %j, the way `literal()` does', (value, expected) => {
    expect(promptTarget(value)).toBe(expected);
  });

  it.each(ESCAPES)(
    'shows a %s as a visible escape inside one code span',
    (_label, value, expected) => {
      const rendered = promptTarget(value);
      expect(rendered).toBe(expected);
      expect(rendered).not.toMatch(RAW_INVISIBLE);
    },
  );

  it('shows a value over 200 characters whole, in one code span with no length note', () => {
    // The host the request reaches sits past the 200th character.
    const url = `http://trusted.example.com-${'x'.repeat(190)}@127.0.0.1:38799/`;
    expect(url).toHaveLength(234);
    expect(promptTarget(url)).toBe(`\`${url}\``);
    expect(promptTarget('a'.repeat(8018))).toBe(`\`${'a'.repeat(8018)}\``);
    expect(promptTarget('😀'.repeat(300))).toBe(`\`${'😀'.repeat(300)}\``);
  });

  it('escapes every character of a long value, past the 200th too', () => {
    const rendered = promptTarget(`${'a'.repeat(250)}\n\u202E${'b'.repeat(50)}`);
    expect(rendered).toBe(`\`${'a'.repeat(250)}\\n\\u{202E}${'b'.repeat(50)}\``);
    expect(rendered).not.toMatch(RAW_INVISIBLE);
  });

  it('keeps a value with backtick runs at either end and a line break in one code span under a CommonMark parse', () => {
    const value = `\`\`a\`b\n\`\`\`${'x'.repeat(300)}\``;
    const rendered = promptTarget(value);
    expect(rendered.split('\n')).toHaveLength(1);
    expect(readCommonMark(rendered)).toBe(`⟨code_inline:\`\`a\`b\\n\`\`\`${'x'.repeat(300)}\`⟩`);
  });
});

describe('prompt renderers on caller-sized values', () => {
  /**
   * Thread CPU milliseconds per `render(value)` over `reps` calls: the least of
   * three runs. A run past `limitMs` already fails, so the rest are skipped.
   */
  function cpuMsPerCall(
    render: (value: string) => string,
    value: string,
    reps: number,
    limitMs: number,
  ): number {
    let least = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const start = process.threadCpuUsage();
      for (let i = 0; i < reps; i++) render(value);
      const { user, system } = process.threadCpuUsage(start);
      least = Math.min(least, (user + system) / 1000 / reps);
      if (least > limitMs) break;
    }
    return least;
  }

  /**
   * Each renderer, what its output on a 5k-character value matches, and its
   * per-call CPU budget at every size. `promptLiteral()` cuts the value and
   * states its length, so no step reads past the excerpt. `promptTarget()`
   * escapes and renders all of it: a 320k run of format characters becomes
   * 2.56M characters of escapes, which Bun takes up to about 90 ms to build
   * and Node about 35 ms, and a quadratic step still overruns 250 ms by 160k.
   */
  const RENDERERS = [
    ['promptLiteral', promptLiteral, / \(first 200 of \d+ characters\)$/, 50],
    ['promptTarget', promptTarget, /^`[\s\S]{5000,}`$/, 250],
  ] as const;

  /**
   * Each shape doubles from 5k to 320k characters, checking the per-call
   * budget at each size before the next and re-timing the 5k baseline beside
   * it, so a slow stretch of the run inflates neither side alone. The full span
   * is timed as three such pairs and the assertion is on their least growth: a
   * linear count grows about 64× and a quadratic one about 4096×.
   */
  const SHAPES = [
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['line breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
    ['a format-character run', (n: number) => '\u202E'.repeat(n)],
    ['a backtick run', (n: number) => '`'.repeat(n)],
    ['astral code points', (n: number) => '😀'.repeat(n / 2)],
    ['one long digit run', (n: number) => '9'.repeat(n)],
  ] as const;

  it.each(
    RENDERERS.flatMap(([name, render, sample, limitMs]) =>
      SHAPES.map(
        ([shape, make]) => [`${shape} through ${name}`, render, sample, limitMs, make] as const,
      ),
    ),
  )(
    'renders %s in time linear in its length',
    { timeout: 0 },
    (_shape, render, sample, limitMs, make) => {
      const small = 5_000;
      expect(render(make(small))).toMatch(sample);
      const pair = (n: number) => {
        const largeMs = cpuMsPerCall(render, make(n), (64 * small) / n, limitMs);
        expect(largeMs).toBeLessThan(limitMs);
        return largeMs / cpuMsPerCall(render, make(small), 64, limitMs);
      };
      for (let n = small * 2; n < small * 64; n *= 2) pair(n);
      const growth = Math.min(pair(small * 64), pair(small * 64), pair(small * 64));
      expect(growth).toBeLessThan(256);
    },
  );
});
