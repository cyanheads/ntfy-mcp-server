/**
 * @fileoverview Tests for `ntfy_search_emoji_tags` — service wiring, default
 * limit, offset paging past the limit cap, enrichment (normalized query echo,
 * total, truncation, next-page and empty-result notices, the query rendered
 * literally), `:code:` / spaced / emoji queries on both surfaces, the
 * `limit` clamp's wiring (clamped / not clamped, advertised in both
 * `NTFY_CLAMP_LIMITS` modes), format-rendering of matches, and the `NTFY_ENABLE_EMOJI_TAGS`
 * gate that wraps the definition in `disabledTool()`.
 * @module tests/tools/ntfy-search-emoji-tags.tool
 */

import { type AnyToolDefinition, disabledTool, z } from '@cyanheads/mcp-ts-core';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetServerConfig } from '@/config/server-config.js';
import { ntfySearchEmojiTags } from '@/mcp-server/tools/definitions/ntfy-search-emoji-tags.tool.js';
import {
  initEmojiTagService,
  resetEmojiTagService,
} from '@/services/emoji-tags/emoji-tag-service.js';

/** Every text block of a `CallToolResult`, joined. */
const contentText = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((block) => block.text ?? '').join('\n');

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

  it('reaches rows past the limit cap via offset and never repeats a row across pages', async () => {
    const firstCtx = createMockContext();
    const first = await ntfySearchEmojiTags.handler(
      ntfySearchEmojiTags.input.parse({ limit: 200 }),
      firstCtx,
    );
    const secondCtx = createMockContext();
    const second = await ntfySearchEmojiTags.handler(
      ntfySearchEmojiTags.input.parse({ limit: 200, offset: 200 }),
      secondCtx,
    );

    expect(first.matches).toHaveLength(200);
    expect(second.matches).toHaveLength(200);
    const overlap = new Set(first.matches.map((m) => m.tag));
    expect(second.matches.some((m) => overlap.has(m.tag))).toBe(false);
    expect(getEnrichment(secondCtx).totalCount).toBe(getEnrichment(firstCtx).totalCount);
  });

  it('serves a `limit` above the page size as a 200-row page that names the next offset', async () => {
    const ctx = createMockContext();
    const result = await ntfySearchEmojiTags.handler(
      ntfySearchEmojiTags.input.parse({ limit: 500 }),
      ctx,
    );

    expect(result.matches).toHaveLength(200);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.notice).toContain('200-row page size');
    expect(enrichment.notice).toContain('offset: 200');
  });

  describe('`limit` above the 200-row cap', () => {
    const FLAG = 'NTFY_CLAMP_LIMITS';
    /** The `limit` property as `tools/list` advertises it. */
    const advertisedLimit = () =>
      (
        z.toJSONSchema(ntfySearchEmojiTags.input, { io: 'input' }) as unknown as {
          properties: { limit: Record<string, unknown> };
        }
      ).properties.limit;

    beforeEach(() => {
      delete process.env[FLAG];
      resetServerConfig();
    });
    afterEach(() => {
      delete process.env[FLAG];
      resetServerConfig();
    });

    it('is clamped to 200 with a notice naming both values and a log line naming this tool', async () => {
      const ctx = createMockContext();
      const result = await ntfySearchEmojiTags.handler(
        ntfySearchEmojiTags.input.parse({ limit: 5000 }),
        ctx,
      );

      expect(result.matches).toHaveLength(200);
      expect(getEnrichment(ctx).notice).toContain(
        '`limit` 5000 is above the 200-row page size, so this page holds 200',
      );
      expect((ctx.log as MockContextLogger).calls).toContainEqual({
        level: 'info',
        msg: 'Clamped limit',
        data: { tool: 'ntfy_search_emoji_tags', requested: 5000, applied: 200 },
      });
    });

    it('is not clamped at 200, so nothing is logged and the notice names no cap', async () => {
      const ctx = createMockContext();
      await ntfySearchEmojiTags.handler(ntfySearchEmojiTags.input.parse({ limit: 200 }), ctx);

      expect(getEnrichment(ctx).notice).not.toContain('page size');
      expect((ctx.log as MockContextLogger).calls).toEqual([]);
    });

    it('is advertised with no maximum while clamping, and as maximum 200 and rejected when NTFY_CLAMP_LIMITS=false', () => {
      expect(advertisedLimit()).not.toHaveProperty('maximum');
      expect(advertisedLimit()).toMatchObject({ type: 'integer', minimum: 1, default: 25 });
      expect(advertisedLimit().description).toBe(
        'Maximum number of matches to return. Default 25. One call returns at most 200; a larger value is served as 200, and the notice says so whenever more remain. Page past it with `offset`.',
      );

      process.env[FLAG] = 'false';
      resetServerConfig();
      expect(advertisedLimit()).toMatchObject({ maximum: 200 });
      expect(advertisedLimit().description).toBe(
        'Maximum number of matches to return. Default 25. At most 200 per call. Page past it with `offset`.',
      );
      expect(ntfySearchEmojiTags.input.safeParse({ limit: 201 }).success).toBe(false);
      expect(ntfySearchEmojiTags.input.safeParse({ limit: 200 }).success).toBe(true);
    });
  });

  it('defaults offset to 0, so an unpaged call starts at the first row', async () => {
    const ctx = createMockContext();
    const input = ntfySearchEmojiTags.input.parse({ limit: 3 });
    expect(input.offset).toBe(0);
    const result = await ntfySearchEmojiTags.handler(input, ctx);
    const offsetCtx = createMockContext();
    const offsetResult = await ntfySearchEmojiTags.handler(
      ntfySearchEmojiTags.input.parse({ limit: 3, offset: 0 }),
      offsetCtx,
    );
    expect(result.matches).toEqual(offsetResult.matches);
  });

  it('names the next offset in the notice when matches remain past the page', async () => {
    const ctx = createMockContext();
    const input = ntfySearchEmojiTags.input.parse({ query: 'a', limit: 10, offset: 20 });
    const result = await ntfySearchEmojiTags.handler(input, ctx);
    expect(result.matches).toHaveLength(10);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.notice).toContain('offset: 30');
    expect(enrichment.notice).toContain('21–30');
  });

  it('flags an offset past the last match and tells the caller to page back', async () => {
    const ctx = createMockContext();
    const input = ntfySearchEmojiTags.input.parse({ query: 'warning', offset: 5000 });
    const result = await ntfySearchEmojiTags.handler(input, ctx);
    expect(result.matches).toHaveLength(0);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.notice).toContain('5000');
    expect(String(enrichment.notice).toLowerCase()).toContain('lower it');
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

  it('renders the table rows byte-for-byte as before the literal() sweep', () => {
    const blocks = ntfySearchEmojiTags.format!({
      matches: [
        { tag: 'warning', emoji: '⚠️' },
        { tag: '+1', emoji: '👍' },
      ],
    });
    expect((blocks[0] as { text: string }).text).toBe(
      '| Tag | Emoji |\n|:----|:------|\n| `warning` | ⚠️ |\n| `+1` | 👍 |',
    );
  });

  it('resolves a `:code:` and spaced query and echoes the normalized query on both surfaces', async () => {
    const result = await runToolContract(ntfySearchEmojiTags, { query: ' :Heavy Check: ' });

    expect(result.structuredContent).toMatchObject({
      matches: [{ tag: 'heavy_check_mark', emoji: '✔️' }],
      effectiveQuery: 'heavy_check',
      totalCount: 1,
      truncated: false,
    });
    const text = contentText(result);
    expect(text).toContain('| `heavy_check_mark` | ✔️ |');
    expect(text).toContain('`heavy_check`');
    expect(text).not.toContain('Heavy Check');
  });

  it('resolves an emoji with a skin tone to its short code', async () => {
    const result = await runToolContract(ntfySearchEmojiTags, { query: '👍🏽' });

    expect(result.structuredContent).toMatchObject({
      matches: [{ tag: '+1', emoji: '👍' }],
      effectiveQuery: '👍🏽',
      totalCount: 1,
    });
    expect(contentText(result)).toContain('| `+1` | 👍 |');
  });

  it('lists the reference with no effectiveQuery for a query that normalizes to nothing', async () => {
    const result = await runToolContract(ntfySearchEmojiTags, { query: ' :: ' });

    expect(result.structuredContent).toMatchObject({ totalCount: 1812, truncated: true });
    expect(result.structuredContent).not.toHaveProperty('effectiveQuery');
    expect((result.structuredContent as { matches: unknown[] }).matches).toHaveLength(25);
    expect(contentText(result)).not.toContain('`::`');
  });

  it('names both accepted query forms when a text-and-emoji query matches nothing', async () => {
    const result = await runToolContract(ntfySearchEmojiTags, { query: 'warning ⚠️' });

    expect(result.structuredContent).toMatchObject({ matches: [], totalCount: 0 });
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toContain('`warning_⚠️`');
    expect(notice).toContain('part of a tag name');
    expect(notice).toContain('a single emoji');
    expect(contentText(result)).toContain('a single emoji');
  });

  it('keeps a query holding backticks and emphasis inside one code span of the empty-result notice', async () => {
    const result = await runToolContract(ntfySearchEmojiTags, { query: 'x`*y*' });
    const notice =
      'No emoji tags matched query ``x`*y*``. Send part of a tag name (`warning`, `heavy check`) or a single emoji (`⚠️`), not both; try a shorter substring, or omit the query to list the reference from the start.';

    expect(result.structuredContent).toMatchObject({ matches: [], totalCount: 0, notice });
    expect(contentText(result)).toContain(notice);
  });

  it('names the query in the notice as it was matched, so a line break reads as `_` on one line', async () => {
    const result = await runToolContract(ntfySearchEmojiTags, { query: 'zz\n# forged' });
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toContain('No emoji tags matched query `zz_#_forged`. Send');
    expect(notice).not.toContain('\n');
    expect(result.structuredContent).toMatchObject({ effectiveQuery: 'zz_#_forged' });
  });
});

describe('ntfySearchEmojiTags behind NTFY_ENABLE_EMOJI_TAGS', () => {
  /** The marker `disabledTool()` attaches, read through the public wrapper rather than named. */
  const MARKER = Object.keys(disabledTool({} as AnyToolDefinition, { reason: 'probe' }));

  /** Re-evaluate the definition module, since the flag is read when it loads. */
  async function loadWith(value: string | undefined) {
    if (value !== undefined) vi.stubEnv('NTFY_ENABLE_EMOJI_TAGS', value);
    vi.resetModules();
    const mod = await import('@/mcp-server/tools/definitions/ntfy-search-emoji-tags.tool.js');
    return mod.ntfySearchEmojiTags as object;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([undefined, '', 'true'])(
    'is an ordinary definition when the flag is %j',
    async (value) => {
      const def = await loadWith(value);
      expect(MARKER.some((key) => key in def)).toBe(false);
    },
  );

  it('is wrapped in disabledTool() with the operator reason and hint when the flag is false', async () => {
    const def = await loadWith('false');
    expect(def).toMatchObject(
      disabledTool({} as AnyToolDefinition, {
        reason: 'Emoji tag lookup is turned off in this deployment.',
        hint: 'NTFY_ENABLE_EMOJI_TAGS=true',
      }),
    );
    expect(def).toMatchObject({ name: 'ntfy_search_emoji_tags' });
  });

  it('fails to load, naming the variable, on an unrecognized value', async () => {
    await expect(loadWith('maybe')).rejects.toThrow(/NTFY_ENABLE_EMOJI_TAGS/);
  });
});
