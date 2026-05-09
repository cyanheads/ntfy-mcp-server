/**
 * @fileoverview Tests for `ntfy_search_emoji_tags` — service wiring, default
 * limit, format-rendering of an empty result.
 * @module tests/tools/ntfy-search-emoji-tags.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

  it('returns matches that contain the query substring', async () => {
    const ctx = createMockContext();
    const input = ntfySearchEmojiTags.input.parse({ query: 'warning', limit: 5 });
    const result = await ntfySearchEmojiTags.handler(input, ctx);
    expect(result.matches.some((m) => m.tag === 'warning')).toBe(true);
    expect(result.matches.length).toBeLessThanOrEqual(5);
  });

  it('returns the leading slice when no query is provided', async () => {
    const ctx = createMockContext();
    const input = ntfySearchEmojiTags.input.parse({});
    const result = await ntfySearchEmojiTags.handler(input, ctx);
    expect(result.matches.length).toBe(25);
    expect(result.truncated).toBe(true);
  });

  it('renders an empty-state message when nothing matches', () => {
    const blocks = ntfySearchEmojiTags.format!({
      matches: [],
      total: 0,
      truncated: false,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No emoji tags matched');
    expect(text).toContain('truncated: false');
  });

  it('renders rows + total + truncated state when there are matches', () => {
    const blocks = ntfySearchEmojiTags.format!({
      matches: [
        { tag: 'warning', emoji: '⚠️' },
        { tag: 'tada', emoji: '🎉' },
      ],
      total: 7,
      truncated: true,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('warning');
    expect(text).toContain('tada');
    expect(text).toContain('7 total matches');
    expect(text).toContain('truncated: true');
  });
});
