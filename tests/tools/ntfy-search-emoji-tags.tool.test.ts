/**
 * @fileoverview Tests for `ntfy_search_emoji_tags` — service wiring, default
 * limit, enrichment (query echo, total, truncation, empty-result notice), and
 * format-rendering of matches.
 * @module tests/tools/ntfy-search-emoji-tags.tool
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ntfySearchEmojiTags } from '@/mcp-server/tools/definitions/ntfy-search-emoji-tags.tool.js';
import {
  initEmojiTagService,
  resetEmojiTagService,
} from '@/services/emoji-tags/emoji-tag-service.js';

describe('ntfySearchEmojiTags handler', () => {
  beforeEach(() => {
    resetEmojiTagService();
    initEmojiTagService();
  });
  afterEach(() => {
    resetEmojiTagService();
  });

  it('returns matches containing the query substring and echoes the parsed query + total', async () => {
    const ctx = createMockContext();
    const input = ntfySearchEmojiTags.input.parse({ query: 'warning', limit: 5 });
    const result = await ntfySearchEmojiTags.handler(input, ctx);
    expect(result.matches.some((m) => m.tag === 'warning')).toBe(true);
    expect(result.matches.length).toBeLessThanOrEqual(5);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('warning');
    expect(typeof enrichment.totalCount).toBe('number');
    expect(typeof enrichment.truncated).toBe('boolean');
  });

  it('returns the leading slice and flags truncation when no query is provided', async () => {
    const ctx = createMockContext();
    const input = ntfySearchEmojiTags.input.parse({});
    const result = await ntfySearchEmojiTags.handler(input, ctx);
    expect(result.matches.length).toBe(25);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.effectiveQuery).toBeUndefined();
  });

  it('populates a notice that echoes the query and offers a recovery hint when nothing matched', async () => {
    const ctx = createMockContext();
    const input = ntfySearchEmojiTags.input.parse({ query: 'zzznevermatchz' });
    const result = await ntfySearchEmojiTags.handler(input, ctx);
    expect(result.matches).toHaveLength(0);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('zzznevermatchz');
    expect(String(enrichment.notice).toLowerCase()).toContain('shorter');
  });

  it('renders an empty matches set without rows', () => {
    const blocks = ntfySearchEmojiTags.format!({ matches: [] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No emoji tags matched');
  });

  it('renders tag → emoji rows when there are matches', () => {
    const blocks = ntfySearchEmojiTags.format!({
      matches: [
        { tag: 'warning', emoji: '⚠️' },
        { tag: 'tada', emoji: '🎉' },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('warning');
    expect(text).toContain('tada');
  });
});
