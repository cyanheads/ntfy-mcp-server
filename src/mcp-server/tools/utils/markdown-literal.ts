/**
 * @fileoverview Renders upstream and caller-supplied strings into `content[]`
 * Markdown as literal text. Built on the framework's `inlineCode()` /
 * `codeBlock()`, which size delimiters past the longest backtick run, so a
 * value reads back byte-identical under a CommonMark parser and no character in
 * it — emphasis, HTML, autolinks, link syntax, backticks — renders as Markdown.
 * Escaping is deliberately avoided: the rendered value stays the exact string
 * an agent copies into an exact-match filter.
 * @module mcp-server/tools/utils/markdown-literal
 */

import { markdown } from '@cyanheads/mcp-ts-core/utils';

/** CommonMark line endings: LF, CR, and CRLF. */
const LINE_BREAK = /[\r\n]/;

/** What `literal()` renders for an empty string. */
const EMPTY = '(empty)';

/**
 * A fenced code block holding `value` verbatim, its fence longer than any
 * backtick run inside.
 *
 * @param value - Text placed in the block unchanged.
 * @param info - Info string after the opening fence (`text`, `markdown`, `json`).
 */
export function literalBlock(value: string, info: string): string {
  return markdown().codeBlock(value, info).build();
}

/**
 * An inline code span holding `value` verbatim. A value with a line break
 * becomes a `text` fence on lines of its own instead: block structure is parsed
 * before inline spans, so a line inside a span that opens with `#`, `-`, or
 * `>` would start a heading, list, or quote of its own. An empty value renders
 * as a bare `(empty)` marker: an empty span is two backticks that read as
 * stray characters, and a non-empty value is always a span, so the marker
 * never collides with one.
 *
 * @param value - Text to render literally.
 */
export function literal(value: string): string {
  if (value === '') return EMPTY;
  if (LINE_BREAK.test(value)) return `\n${literalBlock(value, 'text')}\n`;
  return markdown().inlineCode(value).build();
}
