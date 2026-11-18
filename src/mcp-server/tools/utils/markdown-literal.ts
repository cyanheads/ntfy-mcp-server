/**
 * @fileoverview Renders upstream and caller-supplied strings into `content[]`
 * Markdown as literal text. Built on the framework's `inlineCode()` /
 * `codeBlock()`, which size delimiters past the longest backtick run, so a
 * value reads back byte-identical under a CommonMark parser and no character in
 * it — emphasis, HTML, autolinks, link syntax, backticks — renders as Markdown.
 * Escaping is deliberately avoided: the rendered value stays the exact string
 * an agent copies into an exact-match filter. A consent prompt is the one
 * exception, since there the reader is a person deciding what to approve:
 * invisible characters show as escapes, a destination (`promptTarget()`) is
 * shown whole, and any other value (`promptLiteral()`) as an excerpt.
 * @module mcp-server/tools/utils/markdown-literal
 */

import { markdown } from '@cyanheads/mcp-ts-core/utils';

/** CommonMark line endings: LF, CR, and CRLF. */
const LINE_BREAK = /[\r\n]/;

/** What `literal()` renders for an empty string. */
const EMPTY = '(empty)';

/** How many characters (code points) of a value a consent prompt shows, unless it is a destination. */
const PROMPT_EXCERPT_CHARS = 200;

/**
 * What a consent prompt shows as an escape rather than as itself: controls
 * (line breaks and tabs among them), line and paragraph separators, format
 * characters (bidi controls, zero-width characters, the soft hyphen), and lone
 * surrogates.
 */
const PROMPT_ESCAPED = /[\p{Cc}\p{Zl}\p{Zp}\p{Cf}\p{Cs}]/gu;

/** Escapes a reader knows on sight; every other escaped code point reads `\u{…}`. */
const NAMED_ESCAPES = new Map([
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\t', '\\t'],
]);

/** `char` as a visible escape: `\n`, `\r`, `\t`, or `\u{202E}`. */
function escapeChar(char: string): string {
  const hex = char.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0');
  return NAMED_ESCAPES.get(char) ?? `\\u{${hex}}`;
}

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

/**
 * `value` with every control character, line or paragraph separator, format
 * character, and lone surrogate shown as an escape (`\n`, `\u{202E}`), rendered
 * with `literal()`. With no line break left, that is always one inline code
 * span or the `(empty)` marker: no value can add a line to the prompt, reorder
 * the text around it, or carry an invisible control or format character into
 * it. Backslashes are not doubled, so a value holding the text `\n` reads as a
 * value holding a line break would.
 */
function escapedSpan(value: string): string {
  return literal(value.replace(PROMPT_ESCAPED, escapeChar));
}

/**
 * A destination — where a side effect goes: an email address, a phone number,
 * a broadcast intent, an HTTP URL — as a consent prompt shows it: whole,
 * however long, so the host a request reaches is always in view. Rendered as
 * `promptLiteral()` renders a value, without the cut or the length note: one
 * inline code span on the line it sits in, every invisible character shown as
 * an escape. Linear in the value's length.
 *
 * Prompt text only: an approval binds the outbound request, never this text,
 * and output keeps `literal()`, which leaves the value byte-identical.
 *
 * @param value - The caller-supplied destination, as the request will send it.
 */
export function promptTarget(value: string): string {
  return escapedSpan(value);
}

/**
 * A caller-supplied value other than a destination as a consent prompt shows
 * it — a label, a method, a body, a header name, an extra: one inline code
 * span on the line it sits in, with every invisible character shown as an
 * escape (`\n`, `\u{202E}`), of the value's first 200 characters (code points,
 * so a cut never splits a surrogate pair). When it cuts, the value's full
 * length follows the span — `(first 200 of 8018 characters)` — so a harmless
 * start never passes for the whole. A destination is shown whole instead,
 * through `promptTarget()`.
 *
 * Prompt text only: an approval binds the outbound request, never this text,
 * and output keeps `literal()`, which leaves the value byte-identical.
 *
 * @param value - The caller-supplied value, as the request will send it.
 */
export function promptLiteral(value: string): string {
  let chars = 0;
  let end = value.length;
  // A UTF-16 length within the excerpt puts the code-point count within it too.
  if (value.length > PROMPT_EXCERPT_CHARS) {
    end = 0;
    for (const char of value) {
      if (chars < PROMPT_EXCERPT_CHARS) end += char.length;
      chars++;
    }
  }
  const shown = escapedSpan(value.slice(0, end));
  return chars > PROMPT_EXCERPT_CHARS
    ? `${shown} (first ${PROMPT_EXCERPT_CHARS} of ${chars} characters)`
    : shown;
}
