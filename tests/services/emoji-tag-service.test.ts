/**
 * @fileoverview Tests for the EmojiTagService — substring search, ordering,
 * truncation flag, and direct lookup.
 * @module tests/services/emoji-tag-service
 */

import { describe, expect, it } from 'vitest';

import { EmojiTagService } from '@/services/emoji-tags/emoji-tag-service.js';

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
});
