/**
 * @fileoverview Tests for the EmojiTagService — substring search, ordering,
 * truncation flag, direct lookup, edge-case query inputs (empty / whitespace /
 * zero-limit), the `size` getter, and the module-level init/get/reset
 * accessors that the framework wiring relies on.
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
  it('returns the curated default set when no query is given', () => {
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
