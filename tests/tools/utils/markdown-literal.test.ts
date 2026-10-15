/**
 * @fileoverview Tests for `literal()` / `literalBlock()` — delimiter sizing past
 * backtick runs, edge padding, and the fence that replaces a span when the value
 * holds a CR, LF, or CRLF line ending.
 * @module tests/tools/utils/markdown-literal
 */

import { describe, expect, it } from 'vitest';

import { literal, literalBlock } from '@/mcp-server/tools/utils/markdown-literal.js';

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
