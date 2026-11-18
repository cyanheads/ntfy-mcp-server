/**
 * @fileoverview Reads ntfy's rate-limit response headers into an
 * {@link NtfyQuota}. Since v2.37.0 ntfy answers a publish, clear, or delete
 * with one `RateLimit-Policy` line (`"messages";q=250;w=86400`) and one
 * `RateLimit` line (`"messages";r=246;t=50750`) per policy; `fetch` joins the
 * repeated lines with `, `, so each header reads as an RFC 9651 List. The scan
 * follows RFC 9651's List grammar but drops only a member it cannot read, where
 * the RFC fails the whole field, so one bad member never hides a good one.
 * @module services/ntfy/quota
 */

import type { NtfyQuota } from './types.js';

/** An RFC 9651 bare item, reduced to what a quota reads: an Integer, a String, or any other type, only stepped over. */
type Item =
  | { type: 'integer'; value: number }
  | { type: 'string'; value: string }
  | { type: 'other' };

const OTHER: Item = { type: 'other' };

/** Parameters by key; a repeated key keeps its last value (RFC 9651 §4.2.3.2). */
type Params = Map<string, Item>;

/** A List member: its name when its item is a String, and its parameters. */
interface Member {
  name: string | undefined;
  params: Params;
}

/** The scan over one header value. Each reader moves `pos` past what it read, or leaves it where the text stopped parsing. */
interface Cursor {
  pos: number;
  readonly text: string;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const PERCENT = 0x25;

const charCodes = (chars: string) => new Set(Array.from(chars, (char) => char.charCodeAt(0)));
/** `tchar` (RFC 9110 §5.6.2) symbols plus the `:` and `/` a Token also allows. */
const TOKEN_SYMBOLS = charCodes("!#$%&'*+-.^_`|~:/");
const KEY_SYMBOLS = charCodes('_-.*');
const BASE64_SYMBOLS = charCodes('+/=');

// `charCodeAt` past the end is NaN, which every predicate rejects.
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isLcAlpha = (c: number) => c >= 0x61 && c <= 0x7a;
const isAlpha = (c: number) => isLcAlpha(c) || (c >= 0x41 && c <= 0x5a);
const isLcHex = (c: number) => isDigit(c) || (c >= 0x61 && c <= 0x66);
const isTokenChar = (c: number) => isAlpha(c) || isDigit(c) || TOKEN_SYMBOLS.has(c);
const isKeyChar = (c: number) => isLcAlpha(c) || isDigit(c) || KEY_SYMBOLS.has(c);
const isBase64Char = (c: number) => isAlpha(c) || isDigit(c) || BASE64_SYMBOLS.has(c);
/** Visible ASCII and space, the only characters a String or Display String holds unescaped. */
const isPrintable = (c: number) => c >= 0x20 && c <= 0x7e;

/**
 * The policies a response's `RateLimit-Policy` / `RateLimit` headers carry, or
 * `undefined` when they carry none. A policy is read only when the policy
 * header gives its `q` and the `RateLimit` member of the same name gives its
 * `r` and `t`, all three Integers ≥ 0. Names match exactly (`messages`,
 * `requests`); every other name, and every member that does not parse, is
 * skipped. Never throws.
 */
export function parseQuota(headers: Headers): NtfyQuota | undefined {
  const policies = membersByName(headers.get('ratelimit-policy') ?? '');
  const states = membersByName(headers.get('ratelimit') ?? '');
  const read = (name: string): [limit: number, remaining: number, seconds: number] | undefined => {
    const policy = policies.get(name);
    const state = states.get(name);
    if (!policy || !state) return;
    const limit = count(policy.get('q'));
    const remaining = count(state.get('r'));
    const seconds = count(state.get('t'));
    if (limit === undefined || remaining === undefined || seconds === undefined) return;
    return [limit, remaining, seconds];
  };
  const quota: NtfyQuota = {};
  const messages = read('messages');
  if (messages) {
    const [limit, remaining, resetsInSeconds] = messages;
    quota.messages = { limit, remaining, resetsInSeconds };
  }
  const requests = read('requests');
  if (requests) {
    const [limit, remaining, nextRequestInSeconds] = requests;
    quota.requests = { limit, remaining, nextRequestInSeconds };
  }
  return quota.messages || quota.requests ? quota : undefined;
}

/** An Integer item's value when it is ≥ 0; any other item, or none, is not a count. */
function count(item: Item | undefined): number | undefined {
  return item?.type === 'integer' && item.value >= 0 ? item.value : undefined;
}

/**
 * The parameters of each String-named member of one header value, by name.
 * A name two members carry is ambiguous, so it maps to `undefined`.
 */
function membersByName(text: string): Map<string, Params | undefined> {
  const byName = new Map<string, Params | undefined>();
  for (const { name, params } of parseList(text)) {
    if (name !== undefined) byName.set(name, byName.has(name) ? undefined : params);
  }
  return byName;
}

/**
 * The members of an RFC 9651 List (§4.2.1). A member that does not parse, or
 * is followed by anything but `,` or the end, is dropped, and the scan resumes
 * after the next `,` from where it stopped, so every character is read a
 * bounded number of times.
 */
function parseList(text: string): Member[] {
  const cur: Cursor = { text, pos: 0 };
  const members: Member[] = [];
  while (cur.pos < text.length) {
    skipOws(cur);
    const member = parseMember(cur);
    skipOws(cur);
    if (member && (cur.pos === text.length || text[cur.pos] === ',')) {
      members.push(member);
      cur.pos++;
    } else {
      const comma = text.indexOf(',', cur.pos);
      if (comma === -1) break;
      cur.pos = comma + 1;
    }
  }
  return members;
}

function skipOws(cur: Cursor): void {
  while (cur.text[cur.pos] === ' ' || cur.text[cur.pos] === '\t') cur.pos++;
}

/** One member: a bare item or an Inner List, then its parameters. */
function parseMember(cur: Cursor): Member | undefined {
  let name: string | undefined;
  if (cur.text[cur.pos] === '(') {
    if (!skipInnerList(cur)) return;
  } else {
    const item = parseBareItem(cur);
    if (!item) return;
    if (item.type === 'string') name = item.value;
  }
  const params = parseParams(cur);
  return params && { name, params };
}

/** Steps over an Inner List (§4.2.1.2): its space-separated items with their parameters, through the closing `)`. */
function skipInnerList(cur: Cursor): boolean {
  const { text } = cur;
  cur.pos++;
  while (cur.pos < text.length) {
    while (text[cur.pos] === ' ') cur.pos++;
    if (text[cur.pos] === ')') {
      cur.pos++;
      return true;
    }
    if (!parseBareItem(cur) || !parseParams(cur)) return false;
    if (text[cur.pos] !== ' ' && text[cur.pos] !== ')') return false;
  }
  return false;
}

/** `;`-led parameters (§4.2.3.2); a key without `=` is Boolean true. */
function parseParams(cur: Cursor): Params | undefined {
  const { text } = cur;
  const params: Params = new Map();
  while (text[cur.pos] === ';') {
    cur.pos++;
    while (text[cur.pos] === ' ') cur.pos++;
    const key = parseKey(cur);
    if (key === undefined) return;
    let value = OTHER;
    if (text[cur.pos] === '=') {
      cur.pos++;
      const item = parseBareItem(cur);
      if (!item) return;
      value = item;
    }
    params.set(key, value);
  }
  return params;
}

/** A parameter key (§4.2.3.3): lowercase letter or `*`, then lowercase letters, digits, `_`, `-`, `.`, `*`. */
function parseKey(cur: Cursor): string | undefined {
  const { text } = cur;
  const start = cur.pos;
  const first = text.charCodeAt(start);
  if (!isLcAlpha(first) && first !== 0x2a) return;
  cur.pos++;
  while (isKeyChar(text.charCodeAt(cur.pos))) cur.pos++;
  return text.slice(start, cur.pos);
}

/** A bare item (§4.2.3.1), told apart by its first character. */
function parseBareItem(cur: Cursor): Item | undefined {
  const { text } = cur;
  switch (text[cur.pos]) {
    case '"': {
      const value = parseString(cur);
      return value === undefined ? undefined : { type: 'string', value };
    }
    case ':': {
      cur.pos++;
      while (isBase64Char(text.charCodeAt(cur.pos))) cur.pos++;
      if (text[cur.pos] !== ':') return;
      cur.pos++;
      return OTHER;
    }
    case '?': {
      if (text[cur.pos + 1] !== '0' && text[cur.pos + 1] !== '1') return;
      cur.pos += 2;
      return OTHER;
    }
    case '@': {
      cur.pos++;
      return parseNumber(cur)?.type === 'integer' ? OTHER : undefined;
    }
    case '%':
      return skipDisplayString(cur) ? OTHER : undefined;
  }
  const first = text.charCodeAt(cur.pos);
  if (first === 0x2d || isDigit(first)) return parseNumber(cur);
  if (first === 0x2a || isAlpha(first)) {
    cur.pos++;
    while (isTokenChar(text.charCodeAt(cur.pos))) cur.pos++;
    return OTHER;
  }
  return;
}

/** An Integer (§4.2.4: optional `-`, up to 15 digits) with its value, or a Decimal (up to 12 + 3 digits), only stepped over. */
function parseNumber(cur: Cursor): Item | undefined {
  const { text } = cur;
  const negative = text[cur.pos] === '-';
  if (negative) cur.pos++;
  const digitsStart = cur.pos;
  while (isDigit(text.charCodeAt(cur.pos))) {
    if (cur.pos - digitsStart === 15) return;
    cur.pos++;
  }
  const wholeDigits = cur.pos - digitsStart;
  if (wholeDigits === 0) return;
  if (text[cur.pos] !== '.') {
    const digits = Number(text.slice(digitsStart, cur.pos));
    // `0 - digits`, not `-digits`, so `-0` reads as 0 rather than negative zero.
    return { type: 'integer', value: negative ? 0 - digits : digits };
  }
  if (wholeDigits > 12) return;
  cur.pos++;
  const fractionStart = cur.pos;
  while (isDigit(text.charCodeAt(cur.pos))) {
    if (cur.pos - fractionStart === 3) return;
    cur.pos++;
  }
  return cur.pos === fractionStart ? undefined : OTHER;
}

/** A String's value (§4.2.5) with `\"` and `\\` unescaped; undefined when unterminated or holding any other escape or a non-printable character. */
function parseString(cur: Cursor): string | undefined {
  const { text } = cur;
  const parts: string[] = [];
  cur.pos++;
  let run = cur.pos;
  while (cur.pos < text.length) {
    const c = text.charCodeAt(cur.pos);
    if (c === QUOTE) {
      parts.push(text.slice(run, cur.pos));
      cur.pos++;
      return parts.join('');
    }
    if (c === BACKSLASH) {
      const escaped = text[cur.pos + 1];
      if (escaped !== '"' && escaped !== '\\') return;
      parts.push(text.slice(run, cur.pos), escaped);
      cur.pos += 2;
      run = cur.pos;
    } else if (isPrintable(c)) {
      cur.pos++;
    } else {
      return;
    }
  }
  return;
}

/**
 * Steps over a Display String (§4.2.10): `%"`, printable characters and
 * `%xx` lowercase-hex escapes, then `"`. Its value is never read, so the
 * escapes are not decoded and their UTF-8 is not checked.
 */
function skipDisplayString(cur: Cursor): boolean {
  const { text } = cur;
  if (text[cur.pos + 1] !== '"') return false;
  cur.pos += 2;
  while (cur.pos < text.length) {
    const c = text.charCodeAt(cur.pos);
    if (c === QUOTE) {
      cur.pos++;
      return true;
    }
    if (c === PERCENT) {
      const hex = isLcHex(text.charCodeAt(cur.pos + 1)) && isLcHex(text.charCodeAt(cur.pos + 2));
      if (!hex) return false;
      cur.pos += 3;
    } else if (isPrintable(c)) {
      cur.pos++;
    } else {
      return false;
    }
  }
  return false;
}
