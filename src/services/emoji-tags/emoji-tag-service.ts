/**
 * @fileoverview In-memory emoji-tag lookup service. Backed by the generated
 * table at `data.generated.ts`; supports substring search with a configurable
 * limit and offset, plus direct tag → emoji lookup.
 * @module services/emoji-tags/emoji-tag-service
 */

import { EMOJI_TAGS } from './data.generated.js';

export interface EmojiMatch {
  emoji: string;
  tag: string;
}

export interface EmojiSearchResult {
  matches: EmojiMatch[];
  total: number;
  truncated: boolean;
}

export class EmojiTagService {
  /** Frozen tuples by index — preserves the doc order for deterministic results. */
  private readonly entries: ReadonlyArray<readonly [string, string]>;
  private readonly byTag: ReadonlyMap<string, string>;

  constructor(entries: ReadonlyArray<readonly [string, string]> = EMOJI_TAGS) {
    this.entries = entries;
    this.byTag = new Map(entries);
  }

  /**
   * Substring search over the tag names in doc order.
   *
   * @param query - Case-insensitive substring; empty/omitted matches everything.
   * @param limit - Rows to return from `offset`.
   * @param offset - Rows to skip, so callers can page past `limit`.
   */
  search(query: string | undefined, limit: number, offset = 0): EmojiSearchResult {
    const needle = query?.trim().toLowerCase() ?? '';
    const all =
      needle.length === 0
        ? this.entries
        : this.entries.filter(([tag]) => tag.toLowerCase().includes(needle));
    const total = all.length;
    const start = Math.max(0, offset);
    const sliced = all.slice(start, start + Math.max(0, limit));
    return {
      matches: sliced.map(([tag, emoji]) => ({ tag, emoji })),
      total,
      truncated: total > start + sliced.length,
    };
  }

  get size(): number {
    return this.entries.length;
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
