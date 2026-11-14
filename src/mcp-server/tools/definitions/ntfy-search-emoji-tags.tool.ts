/**
 * @fileoverview `ntfy_search_emoji_tags` — search across the bundled ntfy
 * emoji short-code reference by tag-name substring (`:code:`, spaces, and
 * hyphens normalized) or by emoji. Returns tag → emoji rows the agent can plug
 * into `ntfy_publish_message`'s `tags` field, paged by `limit`/`offset`. The
 * normalized query, true match total, truncation flag, and empty-result or
 * next-page guidance ride the `enrichment` block so they reach both
 * `structuredContent` and `content[]` without a `format()` entry. Wrapped in
 * `disabledTool()` when `NTFY_ENABLE_EMOJI_TAGS=false`: absent from
 * `tools/list`, shown only on the startup line and the HTTP landing page.
 * @module mcp-server/tools/definitions/ntfy-search-emoji-tags.tool
 */

import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';

import { isEmojiTagsEnabled } from '@/config/server-config.js';
import { clampLimit, limitSchema } from '@/mcp-server/tools/utils/limit-clamp.js';
import { literal } from '@/mcp-server/tools/utils/markdown-literal.js';
import { getEmojiTagService } from '@/services/emoji-tags/emoji-tag-service.js';

const TOOL_NAME = 'ntfy_search_emoji_tags';
const DEFAULT_LIMIT = 25;
/**
 * Rows one call returns. Under `NTFY_CLAMP_LIMITS` (the default) a larger
 * `limit` is served as this and, when matches remain, the notice names both
 * values and the next page; with it off, the schema rejects a larger value.
 */
const MAX_LIMIT = 200;

const InputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      'Part of a tag name, matched case-insensitively; surrounding colons are dropped (`:warning:`) and spaces or hyphens match `_` (`heavy check` finds `heavy_check_mark`). Or one emoji (`⚠️`), which finds its own tag, with or without a skin tone. A tag named exactly by the query comes first. Omit to list the reference from the start in its documented order.',
    ),
  limit: limitSchema({
    cap: MAX_LIMIT,
    defaultLimit: DEFAULT_LIMIT,
    describe: (capRule) =>
      `Maximum number of matches to return. Default ${DEFAULT_LIMIT}. ${capRule} Page past it with \`offset\`.`,
  }),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      'Number of matches to skip before returning `limit` rows. Use it with `totalCount` to page past the `limit` cap — the reference holds far more tags than one call can return.',
    ),
});

const OutputSchema = z.object({
  matches: z
    .array(
      z
        .object({
          tag: z
            .string()
            .describe(
              "Emoji short code — pass this verbatim in `ntfy_publish_message`'s `tags` field.",
            ),
          emoji: z.string().describe('Rendered Unicode emoji.'),
        })
        .describe('A single tag → emoji pairing.'),
    )
    .describe(
      'Tag → emoji rows: the tag named exactly by the query first, then the rest in the order they appear in the upstream reference.',
    ),
});

const definition = tool(TOOL_NAME, {
  description:
    "Look up ntfy emoji tag short codes. Use the returned `tag` strings in `ntfy_publish_message`'s `tags` field to render emojis on the recipient's device. Without a query, returns the first slice of the full reference; pass part of a tag name (e.g., `warning`, `tada`, `heavy check`) to filter, or an emoji to find its short code, and `offset` to page through matches beyond `limit`.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: InputSchema,
  output: OutputSchema,

  // Agent-facing success-path context — the parsed query, the true match total,
  // the truncation flag, and empty-result guidance. Merged into structuredContent
  // and mirrored into a content[] trailer; never authored into format().
  enrichment: {
    effectiveQuery: z
      .string()
      .optional()
      .describe(
        'The query as matched against tag names — trimmed, surrounding colons dropped, lowercased, spaces and hyphens read as `_`; absent when no query was given or it normalized to nothing.',
      ),
    totalCount: z.number().describe('Total matches before `limit`/`offset` were applied.'),
    truncated: z
      .boolean()
      .describe('True when matches remain past this page — advance with `offset` to reach them.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no tags matched or matches remain unseen — echoes the query and names the next `offset` or a shorter substring.',
      ),
  },

  handler(input, ctx) {
    const { applied: limit, clamped } = clampLimit(
      input.limit,
      { cap: MAX_LIMIT, tool: TOOL_NAME },
      ctx,
    );
    const { effectiveQuery, matches, total, truncated } = getEmojiTagService().search(
      input.query,
      limit,
      input.offset,
    );

    if (effectiveQuery !== undefined) ctx.enrich.echo(effectiveQuery);
    ctx.enrich.total(total);
    ctx.enrich({ truncated });
    if (matches.length === 0) {
      ctx.enrich.notice(
        input.offset >= total && total > 0
          ? `\`offset\` ${input.offset} is past the last of ${total} matches — lower it to page back into range.`
          : effectiveQuery !== undefined
            ? `No emoji tags matched query ${literal(effectiveQuery)}. Send part of a tag name (\`warning\`, \`heavy check\`) or a single emoji (\`⚠️\`), not both; try a shorter substring, or omit the query to list the reference from the start.`
            : 'The bundled reference is empty — this should not happen; report it.',
      );
    } else if (truncated) {
      const next = input.offset + matches.length;
      const capped = clamped
        ? ` \`limit\` ${input.limit} is above the ${MAX_LIMIT}-row page size, so this page holds ${MAX_LIMIT}.`
        : '';
      ctx.enrich.notice(
        `Showing matches ${input.offset + 1}–${next} of ${total}.${capped} Pass \`offset: ${next}\` (same \`query\`) for the next page, or narrow the query.`,
      );
    }

    return { matches };
  },

  format(result) {
    if (result.matches.length === 0) {
      return [{ type: 'text', text: 'No emoji tags matched.' }];
    }
    const header = '| Tag | Emoji |\n|:----|:------|';
    const rows = result.matches.map((m) => `| ${literal(m.tag)} | ${m.emoji} |`);
    return [{ type: 'text', text: `${header}\n${rows.join('\n')}` }];
  },
});

export const ntfySearchEmojiTags = isEmojiTagsEnabled()
  ? definition
  : disabledTool(definition, {
      reason: 'Emoji tag lookup is turned off in this deployment.',
      hint: 'NTFY_ENABLE_EMOJI_TAGS=true',
    });
