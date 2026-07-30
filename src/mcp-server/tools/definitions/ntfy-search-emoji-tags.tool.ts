/**
 * @fileoverview `ntfy_search_emoji_tags` — substring search across the bundled
 * ntfy emoji short-code reference. Returns tag → emoji rows the agent can plug
 * into `ntfy_publish_message`'s `tags` field, paged by `limit`/`offset`. The
 * parsed query, true match total, truncation flag, and empty-result or
 * next-page guidance ride the `enrichment` block so they reach both
 * `structuredContent` and `content[]` without a `format()` entry.
 * @module mcp-server/tools/definitions/ntfy-search-emoji-tags.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';

import { getEmojiTagService } from '@/services/emoji-tags/emoji-tag-service.js';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

const InputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      'Substring to match against emoji tag names (case-insensitive). Omit to list the reference from the start in its documented order.',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe('Maximum number of matches to return. Default 25, max 200.'),
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
    .describe('Tag → emoji rows in the order they appear in the upstream reference.'),
});

export const ntfySearchEmojiTags = tool('ntfy_search_emoji_tags', {
  description:
    "Look up ntfy emoji tag short codes. Use the returned `tag` strings in `ntfy_publish_message`'s `tags` field to render emojis on the recipient's device. Without a query, returns the first slice of the full reference; pass a substring (e.g., `warning`, `tada`, `cd`) to filter, and `offset` to page through matches beyond `limit`.",
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
      .describe('The query as the server parsed it; absent when no query was given.'),
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
    const { matches, total, truncated } = getEmojiTagService().search(
      input.query,
      input.limit,
      input.offset,
    );

    if (input.query) ctx.enrich.echo(input.query);
    ctx.enrich.total(total);
    ctx.enrich({ truncated });
    if (matches.length === 0) {
      ctx.enrich.notice(
        input.offset >= total && total > 0
          ? `\`offset\` ${input.offset} is past the last of ${total} matches — lower it to page back into range.`
          : input.query
            ? `No emoji tags matched query \`${input.query}\`. Try a shorter substring or omit the query to list the reference from the start.`
            : 'The bundled reference is empty — this should not happen; report it.',
      );
    } else if (truncated) {
      const next = input.offset + matches.length;
      ctx.enrich.notice(
        `Showing matches ${input.offset + 1}–${next} of ${total}. Pass \`offset: ${next}\` (same \`query\`) for the next page, or narrow the query.`,
      );
    }

    return { matches };
  },

  format(result) {
    if (result.matches.length === 0) {
      return [{ type: 'text', text: 'No emoji tags matched.' }];
    }
    const header = '| Tag | Emoji |\n|:----|:------|';
    const rows = result.matches.map((m) => `| \`${m.tag}\` | ${m.emoji} |`);
    return [{ type: 'text', text: `${header}\n${rows.join('\n')}` }];
  },
});
