/**
 * @fileoverview In-memory emoji-tag lookup service. Backed by the generated
 * table at `data.generated.ts`; supports search with a configurable limit and
 * offset, plus direct tag → emoji lookup. A query matches a tag name as a
 * substring once both are folded (case, and spaces or hyphens read as `_`),
 * with surrounding `:` dropped from the query, or matches a row's emoji whole,
 * with U+FE0F and skin-tone modifiers ignored on both sides.
 * @module services/emoji-tags/emoji-tag-service
 */

import { EMOJI_TAGS } from './data.generated.js';

export interface EmojiMatch {
  emoji: string;
  tag: string;
}

export interface EmojiSearchResult {
  /** The query as matched against tag names; absent when it normalized to nothing. */
  effectiveQuery?: string;
  matches: EmojiMatch[];
  total: number;
  truncated: boolean;
}

/**
 * Whitespace and `-`, each read as `_`. Folding both the query and the tag
 * name keeps `-1`, `t-rex`, and `non-potable_water` matching themselves. A
 * one-character class has one parse per character, so it scans caller-sized
 * text in linear time.
 */
const SEPARATOR = /[\s-]/g;
/**
 * U+FE0F (emoji presentation) and the skin-tone modifiers U+1F3FB–U+1F3FF:
 * a caller's emoji may carry them where the reference's does not, or lack
 * them where it does. One-character class, linear like {@link SEPARATOR}.
 */
const GLYPH_VARIANT = /[\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu;

/** A tag name or query in the form the substring match compares. */
function foldName(text: string): string {
  return text.toLowerCase().replace(SEPARATOR, '_');
}

/** An emoji with its presentation selector and skin tone dropped. */
function glyphKey(text: string): string {
  return text.replace(GLYPH_VARIANT, '');
}

/** `text` without the `:` runs at either end, as in `:warning:`. */
function stripColons(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === ':') start++;
  while (end > start && text[end - 1] === ':') end--;
  return text.slice(start, end);
}

/** A reference row with the forms a query is compared against, computed once. */
interface IndexedRow extends EmojiMatch {
  /** `emoji` reduced by {@link glyphKey}. */
  glyph: string;
  /** `tag` folded by {@link foldName}. */
  name: string;
}

export class EmojiTagService {
  /** Rows in doc order, for deterministic results. */
  private readonly rows: readonly IndexedRow[];
  private readonly byTag: ReadonlyMap<string, string>;

  constructor(entries: ReadonlyArray<readonly [string, string]> = EMOJI_TAGS) {
    this.rows = entries.map(([tag, emoji]) => ({
      tag,
      emoji,
      name: foldName(tag),
      glyph: glyphKey(emoji),
    }));
    this.byTag = new Map(entries);
  }

  /**
   * Search in doc order, except that the row whose folded tag name equals the
   * folded query comes first: a short name (`x`, `ok`, `us`) sits inside dozens
   * of longer ones that precede it in doc order, so it would otherwise land
   * past the first page. The query is trimmed and stripped of surrounding `:`;
   * a row matches when its folded tag name contains the folded query, or when
   * its emoji equals the query with U+FE0F and skin tones ignored. Equality,
   * not a substring test, since one emoji (❤) sits inside several others. A
   * query that normalizes to nothing lists every row.
   *
   * @param query - Tag-name substring or one emoji; empty/omitted matches everything.
   * @param limit - Rows to return from `offset`.
   * @param offset - Rows to skip, so callers can page past `limit`.
   */
  search(query: string | undefined, limit: number, offset = 0): EmojiSearchResult {
    const trimmed = stripColons(query?.trim() ?? '').trim();
    const needle = foldName(trimmed);
    const glyph = glyphKey(trimmed);
    const matched =
      needle.length === 0
        ? this.rows
        : this.rows.filter((row) => row.name.includes(needle) || row.glyph === glyph);
    const all =
      needle.length === 0
        ? matched
        : [
            ...matched.filter((row) => row.name === needle),
            ...matched.filter((row) => row.name !== needle),
          ];
    const total = all.length;
    const start = Math.max(0, offset);
    const sliced = all.slice(start, start + Math.max(0, limit));
    return {
      ...(needle.length > 0 && { effectiveQuery: needle }),
      matches: sliced.map(({ tag, emoji }) => ({ tag, emoji })),
      total,
      truncated: total > start + sliced.length,
    };
  }

  get size(): number {
    return this.rows.length;
  }

  lookup(tag: string): string | undefined {
    return this.byTag.get(tag);
  }
}

let _service: EmojiTagService | undefined;

export function initEmojiTagService(): EmojiTagService {
  _service = new EmojiTagService();
  return _service;
}

export function getEmojiTagService(): EmojiTagService {
  if (!_service) {
    throw new Error('EmojiTagService not initialized — call initEmojiTagService() in setup().');
  }
  return _service;
}

export function resetEmojiTagService(): void {
  _service = undefined;
}
